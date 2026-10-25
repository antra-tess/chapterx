import { EventQueue } from './event-queue.js'
import { DeferredQueue, isTransientError } from './deferred-queue.js'
import { ChannelStateManager } from './state-manager.js'
import { DiscordConnector, HISTORY_AND_FILTER_BUFFER, SYSTEM_PLACEHOLDER_ID, type PinnedSteer } from '../discord/connector.js'
import { ConfigSystem } from '../config/system.js'
import { ContextBuilder, BuildContextParams } from '../context/builder.js'
import { collectCoveredToolMessageIds } from '../context/stages/tool-interleave.js'
import { ToolSystem } from '../tools/system.js'
import { toolOutputText } from '../tools/output-text.js'
import { Event, BotConfig, ContentBlock, DiscordMessage, ToolCall, ToolResult, VendorConfig } from '../types.js'
import { logger, withActivationLogging } from '../utils/logger.js'
import { displayNameClasses } from '../discord/member-names.js'
import { mentionsToIds } from './outgoing-mentions.js'
import { sleep } from '../utils/retry.js'
import { exclusiveOnly, scanMarkdown, type MarkdownCarry } from '../utils/discord-markdown.js'
import { filterDotMessages, mergeConsecutiveBotMessages } from '../context/stages/message-filtering.js'
import { characterOverride } from '../context/stages/format-messages.js'
import { 
  withTrace, 
  TraceCollector, 
  getTraceWriter,
  traceToolExecution,
  traceRawDiscordMessages,
  traceSetConfig,
  RawDiscordMessage,
} from '../trace/index.js'
import { ActivationStore, Activation, TriggerType, MessageContext } from '../activation/index.js'
import { PluginContextFactory, ContextInjection } from '../tools/plugins/index.js'
import { setResourceAccessor } from '../tools/plugins/mcp-resources.js'
import { SomaClient, shouldChargeTrigger, SomaTriggerType } from '../soma/index.js'
import { MembraneProvider } from '../llm/membrane/index.js'
import { resolveToolModeForModel } from '../llm/membrane/adapter.js'
import { TTSRelayClient, type InterruptionEvent } from '../tts/index.js'
import { parseSteerMessage, loadCatalog, resolveDirective, toProviderParams, formatReadout, listAvailableLabels, resolveVendorForModel, fetchProbeReadout, fetchProxyReadout } from '../steering/index.js'
import type { ChannelSteering } from '../steering/index.js'
import { SleepState } from './sleep.js'
import { pinAddressesBot } from './pin-target.js'
import { finalStepThinkingBlocks, loadThinkingBlocks, persistThinkingBlocks, type ThinkingBlock } from './thinking-cache.js'
// Use any for Membrane type to avoid version mismatch issues between
// our local interface and the actual membrane package
type Membrane = any

interface ContentSegment {
  prefix: string
  visible: string
  suffix?: string
}

/** Keyed by the refusal category in the API's stop_details. */
const REFUSAL_CATEGORY_EMOJI: Record<string, string> = {
  bio: '☣️',
  chem: '🧪',
  nuclear: '☢️',
  cyber: '💻',
  reasoning_extraction: '🧠',
}
const REFUSAL_DEFAULT_EMOJI = '🛑'

function refusalCategory(completion: { raw?: unknown }): string | undefined {
  const raw = completion.raw as { stop_details?: { category?: string | null } } | null | undefined
  return raw?.stop_details?.category ?? undefined
}

function endOfPostedPrefix(completion: string, posted: string): number | undefined {
  let at = 0
  for (const char of posted) {
    if (/\s/.test(char)) continue
    while (at < completion.length && /\s/.test(completion[at]!)) at++
    if (!completion.startsWith(char, at)) return undefined
    at += char.length
  }
  return at
}

/**
 * Snowflakes are decimal strings that grow with time, so a shorter one is
 * older and ids of one length compare as strings.
 */
function snowflakeAtOrBefore(id: unknown, newest: string | undefined): boolean {
  if (typeof id !== 'string' || newest === undefined || !/^\d+$/.test(id) || !/^\d+$/.test(newest)) return false
  return id.length < newest.length || (id.length === newest.length && id <= newest)
}

export class AgentLoop {
  private running = false
  private botUserId?: string
  private botMessageIds = new Set<string>()
  private mcpInitialized = false
  private activeChannels = new Set<string>()
  private pendingChannelEvents = new Map<string, { events: Event[]; dropped: number }>()
  private static readonly MAX_PENDING_CHANNEL_EVENTS = 500
  private answeredContextNewestId = new Map<string, string>()
  private activationStore: ActivationStore
  private cacheDir: string
  private somaClient?: SomaClient
  
  private membraneProvider?: MembraneProvider

  private ttsRelayClient?: TTSRelayClient

  private vendorConfigs: Record<string, VendorConfig> = {}

  private deferredQueue?: DeferredQueue

  private sleepState: SleepState
  private botConfigName?: string

  constructor(
    private botId: string,
    private queue: EventQueue,
    private connector: DiscordConnector,
    private stateManager: ChannelStateManager,
    private configSystem: ConfigSystem,
    private contextBuilder: ContextBuilder,
    private toolSystem: ToolSystem,
    cacheDir: string = './cache'
  ) {
    this.activationStore = new ActivationStore(cacheDir)
    this.cacheDir = cacheDir
    this.sleepState = new SleepState(
      this.connector,
      () => this.resolveBotIdentity(),
    )
  }

  private resolveBotIdentity(): import('./sleep.js').BotIdentity {
    if (this.botConfigName === undefined) {
      try {
        const cfg = this.configSystem.loadBotConfigOnly(this.botId)
        this.botConfigName = typeof cfg.name === 'string' ? cfg.name : ''
      } catch {
        this.botConfigName = ''
      }
    }
    const discord = this.connector.getBotDiscordIdentity()
    return {
      botId: this.botId,
      configName: this.botConfigName || undefined,
      discordUserId: discord.userId,
      discordUsername: discord.username,
      discordGlobalName: discord.globalName,
    }
  }

  setBotUserId(userId: string): void {
    this.botUserId = userId
    logger.info({ botUserId: userId }, 'Bot user ID set')
  }
  
  setVendorConfigs(vendors: Record<string, VendorConfig>): void {
    this.vendorConfigs = vendors
  }

  setMembrane(membrane: Membrane): void {
    this.membraneProvider = new MembraneProvider(membrane)
    logger.info({ botId: this.botId }, 'Membrane provider set')
  }

  async setTTSRelay(config: {
    url: string
    token: string
    reconnectIntervalMs?: number
  }): Promise<void> {
    if (this.ttsRelayClient) {
      this.ttsRelayClient.disconnect()
    }

    this.ttsRelayClient = new TTSRelayClient({
      url: config.url,
      botId: this.botId,
      token: config.token,
      reconnectIntervalMs: config.reconnectIntervalMs,
    })

    this.ttsRelayClient.onInterruption((event: InterruptionEvent) => {
      this.handleTTSInterruption(event)
    })

    await this.ttsRelayClient.connect()
    logger.info({ botId: this.botId, url: config.url }, 'TTS relay connected')
  }

  private async handleTTSInterruption(event: InterruptionEvent): Promise<void> {
    const spokenText = event.spokenText.trim()

    logger.info(
      {
        botId: this.botId,
        channelId: event.channelId,
        reason: event.reason,
        spokenLength: spokenText.length,
      },
      'TTS interruption received'
    )

    if (this.ttsStreamContext && this.ttsStreamContext.channelId === event.channelId) {
      this.ttsStreamContext.interruptedText = spokenText
      this.ttsStreamContext.abortController.abort()
      if (this.ttsRelayClient?.isConnected()) {
        this.ttsRelayClient.sendActivationEnd({
          channelId: this.ttsStreamContext.channelId,
          userId: this.ttsStreamContext.userId,
          username: this.ttsStreamContext.username,
          reason: 'abort',
        })
      }
      logger.info(
        { channelId: event.channelId, spokenLength: spokenText.length },
        'Aborted stream - will post interrupted text'
      )
    }
  }

  disconnectTTSRelay(): void {
    if (this.ttsRelayClient) {
      this.ttsRelayClient.disconnect()
      this.ttsRelayClient = undefined
      logger.info({ botId: this.botId }, 'TTS relay disconnected')
    }
  }

  async run(): Promise<void> {
    this.running = true

    const botConfig = this.configSystem.loadBotConfigOnly(this.botId)
    if (botConfig.deferred_retries) {
      this.deferredQueue = new DeferredQueue()
      await this.deferredQueue.initialize(this.botId, (event) => this.queue.push(event))
    }

    logger.info({ botId: this.botId, deferredRetries: !!botConfig.deferred_retries }, 'Agent loop started')

    while (this.running) {
      try {
        const batch = this.queue.pollBatch()

        if (batch.length > 0) {
          logger.debug({ batchSize: batch.length, queueSize: this.queue.size() }, 'Polled batch from queue')
          await this.processBatch(batch)
        } else {
          await sleep(100)
        }
      } catch (error) {
        logger.error({ err: error, errorMessage: (error as any)?.message, errorStack: (error as any)?.stack }, 'Error in agent loop')
        await sleep(1000)
      }
    }

    logger.info('Agent loop stopped')
  }

  stop(): void {
    this.running = false
    this.deferredQueue?.stop()
  }

  private parseIntoSegments(fullChunk: string): ContentSegment[] {
    interface Region { start: number; end: number; text: string }
    const invisibleRegions: Region[] = []
    
    const thinkingPattern = /<thinking>[\s\S]*?<\/thinking>/g
    let match
    while ((match = thinkingPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    const toolPattern = /<function_calls>[\s\S]*?<\/function_calls>/g
    while ((match = toolPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    const legacyResultPattern = /System:\s*<results>[\s\S]*?<\/results>/g
    while ((match = legacyResultPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    const funcResultPattern = /<function_results>[\s\S]*?<\/function_results>/g
    while ((match = funcResultPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    invisibleRegions.sort((a, b) => a.start - b.start)
    
    if (invisibleRegions.length === 0) {
      const visible = fullChunk.trim()
      return visible ? [{ prefix: '', visible }] : []
    }
    
    const segments: ContentSegment[] = []
    let currentPos = 0
    let currentPrefix = ''
    
    for (const region of invisibleRegions) {
      const visibleBefore = fullChunk.slice(currentPos, region.start).trim()
      
      if (visibleBefore) {
        segments.push({ prefix: currentPrefix, visible: visibleBefore })
        currentPrefix = region.text
      } else {
        currentPrefix += region.text
      }
      
      currentPos = region.end
    }
    
    const remainingVisible = fullChunk.slice(currentPos).trim()
    
    if (remainingVisible) {
      segments.push({ prefix: currentPrefix, visible: remainingVisible })
    } else if (currentPrefix && segments.length > 0) {
      segments[segments.length - 1]!.suffix = currentPrefix
    } else if (currentPrefix) {
    }
    
    return segments
  }
  
  private extractAllInvisible(fullChunk: string): string {
    const segments = this.parseIntoSegments(fullChunk)
    
    let allInvisible = ''
    for (const seg of segments) {
      allInvisible += seg.prefix
    }
    if (segments.length > 0 && segments[segments.length - 1]!.suffix) {
      allInvisible += segments[segments.length - 1]!.suffix
    }
    
    return allInvisible
  }
  
  private truncateSegmentsAtPosition(segments: ContentSegment[], position: number): ContentSegment[] {
    const result: ContentSegment[] = []
    let accumulatedLength = 0
    
    for (const segment of segments) {
      const segmentEnd = accumulatedLength + segment.visible.length
      
      if (segmentEnd <= position) {
        result.push(segment)
        accumulatedLength = segmentEnd
      } else if (accumulatedLength < position) {
        const keepLength = position - accumulatedLength
        result.push({
          prefix: segment.prefix,
          visible: segment.visible.slice(0, keepLength).trim(),
        })
        break
      } else {
        break
      }
    }
    
    return result
  }
  
  private async sendSegments(
    channelId: string,
    segments: ContentSegment[],
    replyToMessageId: string | undefined,
    markdownCarry: MarkdownCarry
  ): Promise<{
    sentMessageIds: string[]
    messageContexts: Record<string, MessageContext>
    endCarry: MarkdownCarry
  }> {
    const sentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    let carry = markdownCarry
    let replyConsumed = false

    for (const segment of segments) {
      if (!segment.visible) continue

      const replyTo = replyConsumed ? undefined : replyToMessageId
      const { chunks, endCarry } = await this.connector.sendSegmentChunks(
        channelId, segment.visible, replyTo, carry
      )
      carry = exclusiveOnly(endCarry)
      if (chunks.length > 0) replyConsumed = true

      for (let ci = 0; ci < chunks.length; ci++) {
        const ch = chunks[ci]!
        sentMessageIds.push(ch.id)
        this.botMessageIds.add(ch.id)

        const ctx: MessageContext = { prefix: ci === 0 ? segment.prefix : '' }
        if (ch.bridgeOpen) ctx.bridgeOpen = ch.bridgeOpen
        if (ch.bridgeClose) ctx.bridgeClose = ch.bridgeClose
        if (ci === chunks.length - 1 && segment.suffix) ctx.suffix = segment.suffix
        messageContexts[ch.id] = ctx
      }
    }

    return { sentMessageIds, messageContexts, endCarry: carry }
  }

  private async processBatch(events: Event[]): Promise<void> {
    const batchStart = Date.now()
    logger.debug({ count: events.length, types: events.map((e) => e.type) }, 'Processing batch')

    const firstEvent = events[0]
    if (!firstEvent) return

    const { channelId, guildId } = firstEvent

    if (this.activeChannels.has(channelId)) {
      this.deferChannelEvents(channelId, events)
      return
    }

    const eventReceivedAt = (firstEvent as any).receivedAt
    if (eventReceivedAt) {
      logger.debug({ eventAgeMs: batchStart - eventReceivedAt }, 'Event age (discord.js + queue poll)')
    }
    
    const shouldActivateStart = Date.now()
    const decidingEvent = await this.shouldActivate(events, channelId, guildId)
    logger.debug({ durationMs: Date.now() - shouldActivateStart }, 'shouldActivate completed')
    const consumed = decidingEvent ? events.slice(0, events.indexOf(decidingEvent) + 1) : events
    if (consumed.length < events.length) {
      this.queue.prepend(events.slice(consumed.length))
    }

    for (const event of consumed) {
      if (event.type === 'delete') {
        const message = event.data as any
        if (message.author?.id === this.botUserId) {
          await this.toolSystem.removeEntriesByBotMessageId(
            this.botId,
            event.channelId,
            message.id
          )
        }
      }
    }

    if (!decidingEvent) {
      logger.debug('No activation needed')
      return
    }

    const triggeringEvent = decidingEvent.type === 'message'
      ? decidingEvent
      : this.findTriggeringMessageEvent(consumed)
    const triggeringMessageId = triggeringEvent?.data?.id

    const mCommandEvent = decidingEvent.type === 'message' && (decidingEvent.data as any)._isMCommand
      ? decidingEvent
      : undefined
    if (mCommandEvent) {
      const message = mCommandEvent.data as any
      const mContent = (message.content?.trim() || '') as string

      const getContextMatch = mContent.match(/^m\s+get_context(?:\s+(\d+))?/i)
      if (getContextMatch) {
        const requestedMessages = getContextMatch[1] ? parseInt(getContextMatch[1]) : undefined
        try { await this.connector.deleteMessage(channelId, message.id) } catch {}
        try {
          await this.handleGetContext(channelId, guildId, requestedMessages, message.id)
        } catch (error: any) {
          logger.error({ error: error.message, channelId }, 'Failed to handle m get_context')
          await this.connector.sendMessage(channelId, `.error: get_context failed — ${error.message}`)
        }
        return
      }

      try {
        const pinnedConfigs = await this.connector.fetchPinnedConfigs(channelId)
        const modeCheckConfig = this.configSystem.loadConfig({
          botName: this.botId,
          guildId,
          channelConfigs: pinnedConfigs,
        })
        if (modeCheckConfig.supports_continuation === false) {
          const lastMsg = await this.connector.getMessageBefore(channelId, message.id)
          if (lastMsg && lastMsg.author.id === this.botUserId) {
            logger.info({ channelId, botId: this.botId, lastMessageAuthor: lastMsg.author.id },
              'm continue rejected — bot does not support continuation and last message is its own')
            await this.connector.deleteMessage(channelId, message.id)
              .catch((err: any) => logger.debug({ error: err.message }, 'Failed to delete rejected m continue'))
            await this.connector.reactToLatestMessage(channelId, '🚫')
            return
          }
        }
      } catch (error: any) {
        logger.warn({ error: error.message }, 'Failed to check continuation support for m continue — proceeding')
      }

      try {
        await this.connector.deleteMessage(channelId, message.id)
        logger.info({
          messageId: message.id,
          channelId,
          author: message.author?.username,
          content: message.content?.substring(0, 50)
        }, 'Deleted m command message')
      } catch (error: any) {
        logger.error({
          error: error.message,
          code: error.code,
          messageId: message.id,
          channelId,
          author: message.author?.username
        }, '⚠️  FAILED TO DELETE m COMMAND MESSAGE - Check bot permissions (needs MANAGE_MESSAGES)')
      }
    }

    const reactionEvent = decidingEvent.type === 'reaction' && (decidingEvent.data as any)._isReactionContinue
      ? decidingEvent
      : undefined
    if (reactionEvent) {
      const reaction = reactionEvent.data as any

      try {
        const pinnedConfigs = await this.connector.fetchPinnedConfigs(channelId)
        const modeCheckConfig = this.configSystem.loadConfig({
          botName: this.botId,
          guildId,
          channelConfigs: pinnedConfigs,
        })
        if (modeCheckConfig.supports_continuation === false) {
          logger.info({ channelId, botId: this.botId },
            'Reaction continuation rejected — bot does not support continuation')
          return
        }
      } catch (error: any) {
        logger.warn({ error: error.message }, 'Failed to check continuation support for reaction — proceeding')
      }

      logger.info({ channelId, emoji: reaction.emoji, messageId: reaction.messageId },
        'Processing reaction-triggered continuation')
    }

    if (this.deferredQueue?.hasPendingActivation(channelId)) {
      this.deferredQueue.cancelActivation(channelId)
      logger.debug({ channelId }, 'Cancelled pending deferred activation due to new activity')
    }

    this.activeChannels.add(channelId)
    
    const activationReason = this.determineActivationReason(consumed)

    const deferredEvent = consumed.find((e) => (e.data as any)?.type === 'deferred_retry')
    const deferredRetryState = deferredEvent
      ? { retryAttempt: (deferredEvent.data as any).retryAttempt ?? 0, createdAt: (deferredEvent.data as any).createdAt }
      : undefined

    const somaStart = Date.now()
    const somaCheckResult = await this.checkSomaCredits(
      triggeringEvent ? [triggeringEvent] : consumed,
      channelId,
      guildId,
      activationReason.reason,
      triggeringMessageId
    )
    logger.debug({ durationMs: Date.now() - somaStart }, 'Soma credit check completed')

    if (somaCheckResult.status === 'blocked') {
      this.completeChannelActivation(channelId)
      return
    }

    const somaTransactionId = somaCheckResult.transactionId

    logger.debug({ durationMs: Date.now() - batchStart }, 'processBatch overhead (event→handleActivation)')

    const activationPromise = triggeringMessageId
      ? withActivationLogging(channelId, triggeringMessageId, async () => {
          const channelMeta = await this.connector.getChannelMeta(channelId)
          const channelName = channelMeta.name

          const { trace, error: traceError } = await withTrace(
            channelId,
            triggeringMessageId,
            this.botId,
            async (traceCollector) => {
              traceCollector.setGuildId(guildId)
              if (this.botUserId) {
                traceCollector.setBotUserId(this.botUserId)
              }
              traceCollector.setThreadInfo(channelMeta.isThread, channelMeta.parentChannelId)
              traceCollector.recordActivation({
                reason: activationReason.reason,
                triggerEvents: activationReason.events,
              })
              
              return this.handleActivation(channelId, guildId, triggeringMessageId, traceCollector, deferredRetryState)
            },
            channelName
          )
          
          try {
            const writer = getTraceWriter()
            writer.writeTrace(trace, undefined, undefined, channelName)
            logger.info({ 
              traceId: trace.traceId, 
              channelId,
              channelName,
              hadError: !!traceError 
            }, traceError ? 'Trace saved (with error)' : 'Trace saved')
          } catch (writeError) {
            logger.error({ writeError }, 'Failed to write trace')
          }
          
          if (traceError && somaTransactionId && this.somaClient) {
            logger.info({ 
              transactionId: somaTransactionId,
              error: traceError.message 
            }, 'Soma: refunding due to activation failure')
            
            try {
              await this.somaClient.refund({
                transactionId: somaTransactionId,
                reason: 'inference_failed',
              })
            } catch (refundError) {
              logger.error({ refundError, transactionId: somaTransactionId }, 'Failed to refund Soma transaction')
            }
          }
          
          if (traceError) {
            throw traceError
          }
        })
      : this.handleActivation(channelId, guildId, triggeringMessageId, undefined, deferredRetryState)
    
    activationPromise
      .catch((error) => {
        logger.error({
          error: {
            message: error?.message,
            name: error?.name,
            code: error?.code,
            type: error?.type,
            status: error?.status,
            stack: error?.stack?.split('\n').slice(0, 5).join('\n'),
          },
          channelId,
          guildId
        }, 'Failed to handle activation')
      })
      .finally(() => {
        this.completeChannelActivation(channelId)
      })
  }

  private deferChannelEvents(channelId: string, events: Event[]): void {
    const pending = this.pendingChannelEvents.get(channelId) ?? { events: [], dropped: 0 }
    pending.events.push(...events)
    const excess = pending.events.length - AgentLoop.MAX_PENDING_CHANNEL_EVENTS
    if (excess > 0) {
      const droppedTypes = [...new Set(pending.events.splice(0, excess).map((event) => event.type))]
      const droppedBefore = pending.dropped
      pending.dropped += excess
      if (droppedBefore === 0 || Math.floor(droppedBefore / 100) !== Math.floor(pending.dropped / 100)) {
        logger.warn({
          channelId,
          dropped: pending.dropped,
          droppedTypes,
          kept: pending.events.length,
        }, 'Deferred-event buffer full while the channel is active: dropped the oldest held events, which are never handled')
      }
    }
    this.pendingChannelEvents.set(channelId, pending)
    logger.debug({ channelId, pendingEventCount: pending.events.length }, 'Channel active, deferred events')
  }

  private recordAnsweredContext(channelId: string, newestId: string | undefined): void {
    if (newestId !== undefined) this.answeredContextNewestId.set(channelId, newestId)
  }

  private completeChannelActivation(channelId: string): void {
    this.activeChannels.delete(channelId)

    const pending = this.pendingChannelEvents.get(channelId)
    if (!pending) return
    this.pendingChannelEvents.delete(channelId)

    this.queue.prepend(pending.events)
    logger.debug({ channelId, pendingEventCount: pending.events.length }, 'Requeued deferred channel events')
  }
  
  private determineActivationReason(events: Event[]): {
    reason: 'mention' | 'reply' | 'random' | 'm_command' | 'reaction' | 'timer',
    events: Array<{ type: string; messageId?: string; authorId?: string; authorName?: string; contentPreview?: string }>
  } {
    const triggerEvents: Array<{ type: string; messageId?: string; authorId?: string; authorName?: string; contentPreview?: string }> = []
    let reason: 'mention' | 'reply' | 'random' | 'm_command' | 'reaction' | 'timer' = 'mention'

    for (const event of events) {
      if (event.type === 'self_activation') {
        reason = 'timer'
        triggerEvents.push({
          type: 'timer',
          messageId: event.data?.originalMessageId,
          contentPreview: event.data?.contextNote?.slice(0, 100),
        })
      } else if (event.type === 'reaction' && (event.data as any)._isReactionContinue) {
        reason = 'reaction'
        triggerEvents.push({
          type: 'reaction',
          messageId: event.data?.messageId,
          authorId: event.data?.userId,
          contentPreview: `${event.data?.emoji} on bot message`,
        })
      } else if (event.type === 'message') {
        const message = event.data as any
        if (message.author?.id === this.botUserId) continue
        const content = message.content?.trim() || ''

        if ((event.data as any)._isMCommand) {
          reason = 'm_command'
        } else if (message.reference?.messageId && this.botMessageIds.has(message.reference.messageId)) {
          reason = 'reply'
        } else if (this.botUserId && message.mentions?.has(this.botUserId)) {
          reason = 'mention'
        } else {
          reason = 'random'
        }

        triggerEvents.push({
          type: event.type,
          messageId: message.id,
          authorId: message.author?.id,
          authorName: message.author?.username,
          contentPreview: content.slice(0, 100),
        })
      }
    }

    return { reason, events: triggerEvents }
  }

  private async checkSomaCredits(
    events: Event[],
    channelId: string,
    guildId: string,
    triggerReason: 'mention' | 'reply' | 'random' | 'm_command' | 'reaction' | 'timer',
    triggeringMessageId?: string
  ): Promise<{ status: 'allowed' | 'blocked'; transactionId?: string }> {
    let config: any
    try {
      const pinnedConfigs = await this.connector.fetchPinnedConfigs(channelId)
      config = this.configSystem.loadConfig({
        botName: this.botId,
        guildId,
        channelConfigs: pinnedConfigs,
      })
    } catch (error) {
      logger.warn({ error }, 'Failed to load config for Soma check - allowing activation')
      return { status: 'allowed' }
    }

    if (!config.soma?.enabled || !config.soma?.url) {
      return { status: 'allowed' }
    }

    if (!shouldChargeTrigger(triggerReason)) {
      logger.debug({ triggerReason }, 'Soma: trigger type is free')
      return { status: 'allowed' }
    }

    if (!this.somaClient) {
      this.somaClient = new SomaClient(config.soma)
      logger.info({ url: config.soma.url }, 'Soma client initialized')
    }

    const triggeringUser = this.findTriggeringUser(events)
    if (!triggeringUser) {
      logger.warn('Could not identify triggering user for Soma check - allowing activation')
      return { status: 'allowed' }
    }

    const result = await this.somaClient.checkAndDeduct({
      userId: triggeringUser.id,
      serverId: guildId,
      channelId: channelId,
      botId: this.botUserId || '',
      messageId: triggeringMessageId || '',
      triggerType: triggerReason as SomaTriggerType,
      userRoles: triggeringUser.roles || [],
    })

    if (result.allowed) {
      logger.info({
        userId: triggeringUser.id,
        cost: result.cost,
        balanceAfter: result.balanceAfter,
        triggerType: triggerReason,
        transactionId: result.transactionId,
      }, 'Soma: ichor deducted, activation allowed')
      return { status: 'allowed', transactionId: result.transactionId }
    }

    // Soma can't react for a bot it hasn't registered, so ChapterX adds this reaction itself.
    if (result.reason === 'bot_not_configured') {
      logger.warn({
        botId: this.botUserId,
        serverId: guildId,
        triggerType: triggerReason,
      }, 'Soma: bot not configured, activation blocked')

      if (triggeringMessageId) {
        try {
          await this.connector.addReaction(channelId, triggeringMessageId, '⚙️')
        } catch (error) {
          logger.warn({ error }, 'Failed to add bot-not-configured reaction')
        }
      }

      return { status: 'blocked' }
    }

    // Soma's bot posts the 💸 reaction and the DM for insufficient funds.
    logger.info({
      userId: triggeringUser.id,
      cost: result.cost,
      currentBalance: result.currentBalance,
      timeToAfford: result.timeToAfford,
      triggerType: triggerReason,
    }, 'Soma: insufficient ichor, activation blocked')

    return { status: 'blocked' }
  }

  private findTriggeringUser(events: Event[]): { id: string; roles?: string[] } | null {
    for (const event of events) {
      if (event.type === 'message') {
        const message = event.data as any
        if (message.author && !message.author.bot) {
          return {
            id: message.author.id,
            roles: message.member?.roles?.cache 
              ? Array.from(message.member.roles.cache.keys())
              : [],
          }
        }
      }
    }
    return null
  }

  private async replaceMentions(
    text: string,
    messages: any[],
    config: BotConfig,
    carry: MarkdownCarry = [],
  ): Promise<string> {
    const steerVisible = config.steer_visible === true
    const ignoreDotted = config.ignore_dotted_messages !== false
    const shown = filterDotMessages(messages, steerVisible, ignoreDotted)
    const authors = shown
      .filter((msg) => msg.author && msg.author.id !== this.botUserId && msg.author.id !== SYSTEM_PLACEHOLDER_ID)
      .map((msg) => ({ ...msg.author, webhook: Boolean(msg.webhookId) }))
    const botName = this.connector.getBotUsername() || config.name
    const merged = config.preserve_thinking_context
      ? messages
      : mergeConsecutiveBotMessages(
          messages.filter((msg) => msg.author).map((msg) => ({ ...msg, attachments: [...(msg.attachments ?? [])] })),
          botName,
        )
    const heldByNoOne = { id: '', bot: false, webhook: true }
    for (const msg of filterDotMessages(merged, steerVisible, ignoreDotted)) {
      const { name } = characterOverride(typeof msg.content === 'string' ? msg.content : '')
      if (name) authors.push({ ...heldByNoOne, username: name, displayName: name })
    }
    return mentionsToIds(text, authors, config, carry)
  }

  private async replaceMentionsInSegments(
    segments: ContentSegment[],
    messages: any[],
    config: BotConfig,
    carry: MarkdownCarry,
  ): Promise<void> {
    for (const segment of segments) {
      if (!segment.visible) continue
      segment.visible = await this.replaceMentions(segment.visible, messages, config, carry)
      carry = exclusiveOnly(scanMarkdown(segment.visible, carry))
    }
  }

  private determineTriggerType(triggeringMessageId?: string): TriggerType {
    if (!triggeringMessageId) {
      return 'random'
    }
    return 'mention'
  }

  private findTriggeringMessageEvent(events: Event[]): (Event & { data: any }) | undefined {
    const fromOthers = events.filter((event) => event.type === 'message' && event.data?.author?.id !== this.botUserId)
    return fromOthers.find((event) => !this.isSystemDiscordMessage(event.data)) || fromOthers[0]
  }

  private isSystemDiscordMessage(message: any): boolean {
    return Boolean(message?.system)
  }

  private async collectPinnedConfigsWithInheritance(channelId: string, baseConfigs: string[]): Promise<string[]> {
    const mergedConfigs: string[] = []
    const parentChain = await this.buildParentChannelChain(channelId)
    const seen = new Set<string>([channelId])

    for (const ancestorId of parentChain) {
      if (seen.has(ancestorId)) {
        continue
      }
      seen.add(ancestorId)
      const ancestorConfigs = await this.connector.fetchPinnedConfigs(ancestorId)
      if (ancestorConfigs.length > 0) {
        mergedConfigs.push(...ancestorConfigs)
      }
    }

    mergedConfigs.push(...baseConfigs)
    return mergedConfigs
  }

  private async collectPinnedSteersWithInheritance(
    channelId: string,
    baseSteers: PinnedSteer[]
  ): Promise<PinnedSteer[]> {
    const mergedSteers: PinnedSteer[] = []
    const parentChain = await this.buildParentChannelChain(channelId)
    const seen = new Set<string>([channelId])

    for (const ancestorId of parentChain) {
      if (seen.has(ancestorId)) {
        continue
      }
      seen.add(ancestorId)
      const ancestorSteers = await this.connector.fetchPinnedSteerMessages(ancestorId)
      if (ancestorSteers.length > 0) {
        mergedSteers.push(...ancestorSteers)
      }
    }

    mergedSteers.push(...baseSteers)
    return mergedSteers
  }

  private resolveSteerMessages(
    steerMessages: PinnedSteer[],
    config: BotConfig,
    channelId: string,
  ): ChannelSteering | null {
    const botDiscordUsername = this.connector.getBotUsername()
    const identity = {
      botId: this.botId,
      configName: config.name,
      discordUsername: botDiscordUsername ?? undefined,
      discordUserId: this.botUserId ?? undefined,
    }
    const ownRoleIds = this.connector.getOwnRoleIds(channelId) ?? undefined
    const matchesBot = (steer: PinnedSteer, target: string) =>
      pinAddressesBot(
        { targetText: target, mentionedPersonaIds: steer.mentionedPersonaIds, mentionedRoleIds: steer.mentionedRoleIds },
        identity,
        ownRoleIds,
      )

    let mergedDirectives: Record<string, number> = {}
    let mergedReadoutProbes: string[] = []
    let lastSetBy = ''

    for (const steer of steerMessages) {
      const { content, authorId } = steer
      const result = parseSteerMessage(content)
      if (!result.ok) {
        logger.debug({ error: result.error, content: content.slice(0, 80) }, 'Steer parse failed')
        continue
      }

      if ('clear' in result) {
        if (matchesBot(steer, result.target)) {
          mergedDirectives = {}
          mergedReadoutProbes = []
          logger.info({ clearedBy: authorId }, 'Steering cleared via pinned .steer clear')
        }
        continue
      }

      const parsed = result.data
      if (!matchesBot(steer, parsed.target)) {
        continue
      }

      for (const [key, value] of Object.entries(parsed.directives)) {
        mergedDirectives[key] = value
      }

      mergedReadoutProbes.push(...parsed.readout_probes)
      lastSetBy = authorId
    }

    if (Object.keys(mergedDirectives).length === 0) {
      return null
    }

    const catalog = loadCatalog(config.continuation_model)
    if (!catalog) {
      logger.warn({ model: config.continuation_model }, 'No probe catalog for model — .steer ignored')
      return null
    }

    const { interventions, errors } = resolveDirective(catalog, mergedDirectives)
    if (errors.length > 0) {
      logger.warn({ errors, available: listAvailableLabels(catalog).length }, 'Some .steer labels could not be resolved')
    }

    if (interventions.length === 0) {
      return null
    }

    const resolvedProbes = [...new Set(interventions.map(i => i.probe))]

    return {
      interventions,
      readout_probes: resolvedProbes.length > 0 ? resolvedProbes : [...new Set(mergedReadoutProbes)],
      updated_at: new Date().toISOString(),
      set_by: lastSetBy,
      model: config.continuation_model,
    }
  }

  private async buildParentChannelChain(channelId: string, maxDepth: number = 10): Promise<string[]> {
    const chain: string[] = []
    const visited = new Set<string>([channelId])
    let currentId = channelId

    for (let depth = 0; depth < maxDepth; depth++) {
      const parentId = await this.connector.getParentChannelId(currentId)
      if (!parentId || visited.has(parentId)) {
        break
      }
      chain.push(parentId)
      visited.add(parentId)
      currentId = parentId
    }

    return chain.reverse()
  }

  private stripThinkingBlocks(text: string): { stripped: string; content: string[] } {
    const content: string[] = []
    
    const pattern = /<thinking>([\s\S]*?)<\/thinking>/g
    let result = text
    let match
    
    const matches: Array<{ full: string; content: string; index: number }> = []
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ full: match[0], content: match[1] || '', index: match.index })
    }
    
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]!
      const before = text.slice(0, m.index)
      const after = text.slice(m.index + m.full.length)
      
      const isEscaped = (
        (before.endsWith('`') && after.startsWith('`')) ||
        (before.endsWith('```') || before.match(/```[^\n]*\n[^`]*$/))
      )
      
      if (!isEscaped) {
        content.unshift(m.content.trim())
        result = result.slice(0, m.index) + result.slice(m.index + m.full.length)
      }
    }
    
    return { stripped: result, content }
  }

  private async shouldActivate(events: Event[], channelId: string, guildId: string): Promise<Event | undefined> {
    // NEVER hit the pins API here — this is the hot path (every message batch).
    // Hitting the API triggers Cloudflare 1015 rate limiting on servers with many bots.
    let config: any = null
    const loadConfig = () => {
      if (!config) {
        try {
          const cachedPins = this.connector.getCachedPinnedConfigs(channelId)
          let channelConfigs: string[] = []
          if (cachedPins !== null) {
            channelConfigs = cachedPins
          }
          config = this.configSystem.loadConfig({
            botName: this.botId,
            guildId,
            channelConfigs,
          })
        } catch (error) {
          logger.warn({ error }, 'Failed to load config for activation check')
          return false
        }
      }
      return true
    }

    if (!loadConfig()) return undefined
    if (config?.api_only) {
      logger.debug('API-only mode enabled - skipping activation')
      return undefined
    }

    if (Array.isArray(config?.may_speak)) {
      const botIdLower = this.botId.toLowerCase()
      const displayNameLower = typeof config.name === 'string' ? config.name.toLowerCase() : ''
      const allowed = config.may_speak.some((raw: unknown) => {
        if (typeof raw !== 'string') return false
        const target = raw.trim().replace(/^<@!?([^>]+)>$/, '$1').toLowerCase()
        return target === botIdLower || (displayNameLower !== '' && target === displayNameLower)
      })
      if (!allowed) {
        logger.debug({ channelId, botId: this.botId, may_speak: config.may_speak }, 'Skipping activation — bot not in may_speak list')
        return undefined
      }
    }

    const sleepPinIds = this.sleepState.sleepPinsForBot(channelId)

    for (const event of events) {
      if (event.type === 'self_activation') {
        const sleepingNow = sleepPinIds.length > 0
          && this.sleepState.isSleeping(channelId, Date.now())
        if (sleepingNow) {
          logger.debug({
            channelId,
            botId: this.botId,
            timerId: event.data?.timerId,
            deferredType: event.data?.type,
          }, 'Skipping self_activation — bot is sleeping')
          continue
        }
        logger.info({
          channelId,
          timerId: event.data?.timerId,
          contextNote: event.data?.contextNote?.slice(0, 50),
        }, 'Activated by timer (self_activation)')
        return event
      }

      if (event.type === 'reaction') {
        const reaction = event.data as any
        if (!loadConfig()) continue

        if (reaction.userId === this.botUserId) continue

        if (config.continuation_emoji
          && reaction.emoji === config.continuation_emoji
          && reaction.messageAuthorId === this.botUserId) {
          logger.debug({ messageId: reaction.messageId, emoji: reaction.emoji, userId: reaction.userId },
            'Activated by continuation emoji on bot message')
          event.data._isReactionContinue = true
          return event
        }
        continue
      }

      if (event.type !== 'message') {
        continue
      }

      const message = event.data as any

      if (this.isSystemDiscordMessage(message)) {
        continue
      }

      const content = message.content?.trim()
      const contentForDotCheck = content
        ?.replace(/^(<@[!&]?\d+>\s*)+/, '')
        ?.replace(/^<reply:@[^>]+>\s*/, '')
      const isDotMessage = !!(contentForDotCheck && /^\.(?!\.)/.test(contentForDotCheck))

      const sleepingBeforeThisMessage = sleepPinIds.length > 0
        && this.sleepState.isSleeping(channelId, Date.now())

      if (!isDotMessage) {
        for (const pinId of sleepPinIds) {
          this.sleepState.observeMessage(channelId, pinId)
        }
      }

      if (sleepingBeforeThisMessage) {
        logger.debug({ channelId, botId: this.botId, messageId: message.id }, 'Skipping activation — bot is sleeping')
        continue
      }

      if (message.author?.id === this.botUserId) {
        continue
      }

      const hasShowReaction = message.reactions?.cache?.some(
        (r: any) => r.emoji?.name === '👁‍🗨' || r.emoji?.name === '👁️‍🗨️' || r.emoji?.name === 'eye_in_speech_bubble'
      )
      if (isDotMessage && config.ignore_dotted_messages !== false && !hasShowReaction) {
        continue
      }

      if (content?.startsWith('m ')) {
        const mentionsUs = this.botUserId && message.mentions?.has(this.botUserId)
        const repliesTo = message.reference?.messageId && this.botMessageIds.has(message.reference.messageId)

        if (mentionsUs || repliesTo) {
          logger.debug({ messageId: message.id, command: content, mentionsUs, repliesTo }, 'Activated by m command addressed to us')
          event.data._isMCommand = true
          return event
        }
        logger.debug({ messageId: message.id, command: content }, 'm command not addressed to us - ignoring')
        continue
      }

      if (snowflakeAtOrBefore(message.id, this.answeredContextNewestId.get(channelId))) {
        continue
      }

      if (this.botUserId && message.mentions?.has(this.botUserId)) {
        const chainDepth = await this.connector.getBotReplyChainDepth(channelId, message)

        if (!loadConfig()) return undefined

        if (chainDepth >= config.max_bot_reply_chain_depth) {
          logger.info({
            messageId: message.id,
            chainDepth,
            limit: config.max_bot_reply_chain_depth
          }, 'Bot reply chain depth limit reached, blocking activation')

          await this.connector.addReaction(channelId, message.id, config.bot_reply_chain_depth_emote)
          continue
        }

        logger.debug({ messageId: message.id, chainDepth }, 'Activated by mention')
        return event
      }

      // A reply with ping on puts the bot in message.mentions, so the mention check above covers it.

      if (!loadConfig()) return undefined

      if (config.reply_on_random > 0) {
        const chance = Math.random()
        if (chance < 1 / config.reply_on_random) {
          logger.debug({ messageId: message.id, chance, threshold: 1 / config.reply_on_random }, 'Activated by random chance')
          return event
        }
      }
    }

    return undefined
  }

  private messagesNotCoveredByToolCache(
    messages: DiscordMessage[],
    toolCache: Array<{ call: ToolCall; result: any }>,
    config: BotConfig
  ): DiscordMessage[] {
    if (config.preserve_thinking_context) {
      logger.debug('Skipping tool cache message filter (preserve_thinking_context enabled)')
      return messages
    }
    const covered = collectCoveredToolMessageIds(toolCache, messages)
    if (covered.size === 0) return messages
    const remaining = messages.filter((message) => !covered.has(message.id))
    logger.debug({
      filtered: messages.length - remaining.length,
      remaining: remaining.length,
    }, 'Filtered Discord messages covered by tool cache')
    return remaining
  }

  private async handleActivation(
    channelId: string,
    guildId: string,
    triggeringMessageId?: string,
    trace?: TraceCollector,
    deferredRetryState?: { retryAttempt: number; createdAt?: number }
  ): Promise<void> {
    logger.info({ botId: this.botId, channelId, guildId, triggeringMessageId, traceId: trace?.getTraceId() }, 'Bot activated')

    const timings: Record<string, number> = {}
    const startProfile = (name: string) => {
      timings[`_start_${name}`] = Date.now()
    }
    const endProfile = (name: string) => {
      const start = timings[`_start_${name}`]
      if (start) {
        timings[name] = Date.now() - start
        delete timings[`_start_${name}`]
      }
    }
    const profileStart = Date.now()

    startProfile('typing')
    this.connector.startTyping(channelId).catch(() => {})
    endProfile('typing')

    try {
      startProfile('toolCacheLoad')
      const toolCacheWithResults = await this.toolSystem.loadCacheWithResults(this.botId, channelId)
      const toolCache = toolCacheWithResults.map(e => e.call)
      endProfile('toolCacheLoad')
      
      startProfile('stateInit')
      const state = await this.stateManager.getOrInitialize(this.botId, channelId, toolCache)
      endProfile('stateInit')

      startProfile('pinnedConfigFetch')
      const pinnedConfigs = await this.connector.fetchPinnedConfigs(channelId)
      const inheritedPinnedConfigs = await this.collectPinnedConfigsWithInheritance(
        channelId,
        pinnedConfigs
      )
      const preConfig = this.configSystem.loadConfig({
        botName: this.botId,
        guildId,
        channelConfigs: inheritedPinnedConfigs,
      })
      endProfile('pinnedConfigFetch')
      
      const recencyWindow = preConfig.recency_window_messages || 200
      const rollingBuffer = preConfig.rolling_threshold || 50
      const historyBoundaryTolerance = 50
      let fetchDepth = recencyWindow + rollingBuffer + historyBoundaryTolerance
      
      logger.debug({ 
        recencyWindow, 
        rollingBuffer, 
        fetchDepth,
        configSource: 'pinned + bot yaml'
      }, 'Calculated fetch depth from config')
      
      const promptCachingEnabled = preConfig.prompt_caching !== false
      
      startProfile('fetchContext')
      const maxImagesFetch = Math.max((preConfig.max_images || 5) * 2, 10)
      const discordContext = await this.connector.fetchContext({
        channelId,
        depth: fetchDepth,
        // With prompt caching on, anchored so the oldest message doesn't slide forward
        // as new messages arrive, which would invalidate the cached prompt prefix on
        // every activation.
        firstMessageId: promptCachingEnabled ? (state.cacheOldestMessageId || undefined) : undefined,
        authorized_roles: [],  // Will apply after loading config
        pinnedConfigs,
        maxImages: maxImagesFetch,
        displayNames: displayNameClasses(preConfig),
      })
      endProfile('fetchContext')
      const newestFetchedId = discordContext.messages[discordContext.messages.length - 1]?.id

      if (promptCachingEnabled) {
        const cacheOldestId = state.cacheOldestMessageId
        const fetchedOldestId = discordContext.messages[0]?.id

        if (discordContext.inheritanceInfo?.historyDidClear && fetchedOldestId) {
          logger.debug({
            oldCacheMarker: cacheOldestId,
            newCacheMarker: fetchedOldestId,
          }, 'Resetting cache anchor after .history clear')
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
        } else if (!cacheOldestId && fetchedOldestId) {
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
          logger.debug({ channelId, oldestMessageId: fetchedOldestId }, 'Initialized cache anchor for prompt stability')
        } else if (cacheOldestId && fetchedOldestId) {
          const cacheIdx = discordContext.messages.findIndex(m => m.id === cacheOldestId)

          if (cacheIdx > 0) {
            logger.debug({
              oldCacheMarker: cacheOldestId,
              newCacheMarker: fetchedOldestId,
              olderMessagesIncluded: cacheIdx,
            }, 'Expanding cache anchor to include .history context')
            this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
          } else if (cacheIdx === -1) {
            logger.warn({
              cacheOldestId,
              fetchedMessages: discordContext.messages.length,
            }, 'Cache anchor not found in fetch — resetting')
            this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
          }
        }
      } else {
        logger.debug({ channelId }, 'Prompt caching disabled — skipping cache anchor logic')
      }
      
      if (trace) {
        const rawMessages: RawDiscordMessage[] = discordContext.messages.map(msg => ({
          id: msg.id,
          author: {
            id: msg.author.id,
            username: msg.author.username,
            displayName: msg.author.displayName,
            bot: msg.author.bot,
          },
          content: msg.content,
          timestamp: msg.timestamp,
          attachments: msg.attachments.map(att => ({
            url: att.url,
            contentType: att.contentType,
            filename: att.filename || 'unknown',
            size: att.size || 0,
          })),
          replyTo: msg.referencedMessage,
        }))
        traceRawDiscordMessages(rawMessages)
      }
      
      startProfile('configLoad')
      const config = this.configSystem.loadConfig({
        botName: this.botId,
        guildId: discordContext.guildId,
        channelConfigs: inheritedPinnedConfigs,
      })
      endProfile('configLoad')

      startProfile('steerLoad')

      const pinnedSteers = await this.connector.fetchPinnedSteerMessages(channelId)
      const inheritedSteers = await this.collectPinnedSteersWithInheritance(channelId, pinnedSteers)

      const authorizedSteers: PinnedSteer[] = []
      for (const steer of inheritedSteers) {
        if (config.steer_roles && config.steer_roles.length > 0) {
          const roles = await this.connector.fetchMemberRoles(steer.authorId, guildId) ?? undefined
          if (!roles) {
            logger.debug({ authorId: steer.authorId, guildId }, 'Steer role check: could not fetch member roles — skipping')
            continue
          }
          if (!config.steer_roles.some(r => roles.some(role => role.toLowerCase() === r.toLowerCase()))) {
            logger.debug({ authorId: steer.authorId, roles, required: config.steer_roles }, 'Steer role check failed — skipping')
            continue
          }
        }
        authorizedSteers.push(steer)
      }

      const activeSteering = this.resolveSteerMessages(authorizedSteers, config, channelId)

      if (activeSteering && activeSteering.interventions.length > 0) {
        const steeringParams = toProviderParams(activeSteering)
        config.provider_params = {
          ...config.provider_params,
          ...steeringParams,
        }
        logger.info({
          channelId,
          interventions: activeSteering.interventions.length,
          probes: activeSteering.readout_probes,
        }, 'Injected steering into provider_params')
      } else {
        logger.debug({ channelId }, 'No active steering for this channel')
      }

      endProfile('steerLoad')

      traceSetConfig(config)

      if (config.tts_relay?.enabled && this.ttsRelayClient?.isConnected() && this.botUserId) {
        const botDiscordUsername = this.connector.getBotUsername() || config.name
        this.ttsRelayClient.sendActivationStart({
          channelId,
          userId: this.botUserId,
          username: botDiscordUsername,
        })
      }

      if (!this.mcpInitialized && config.mcp_servers && config.mcp_servers.length > 0) {
        startProfile('mcpInit')
        logger.info({ serverCount: config.mcp_servers.length }, 'Initializing MCP servers from config')
        await this.toolSystem.initializeServers(config.mcp_servers)
        this.mcpInitialized = true
        
        setResourceAccessor({
          getMcpResources: () => this.toolSystem.getMcpResources(),
          readMcpResource: (uri) => this.toolSystem.readMcpResource(uri),
        })
        
        endProfile('mcpInit')
      }
      
      startProfile('pluginSetup')
      if (config.tool_plugins && config.tool_plugins.length > 0) {
        this.toolSystem.loadPlugins(config.tool_plugins)
      }
      
      const initialVisibleImages = discordContext.images.map((img, i) => ({
        index: i + 1,
        source: 'discord' as const,
        sourceDetail: 'channel',
        data: img.data.toString('base64'),
        mimeType: img.mediaType,
        description: img.url ? `cached from ${img.url.split('/').pop()?.slice(0, 20)}` : undefined,
      }))
      
      this.toolSystem.setPluginContext({
        botId: this.botId,
        channelId,
        guildId,
        currentMessageId: triggeringMessageId || '',
        config,
        sendMessage: async (content: string) => {
          return await this.connector.sendMessage(channelId, content)
        },
        pinMessage: async (messageId: string) => {
          await this.connector.pinMessage(channelId, messageId)
        },
        addReaction: async (messageId: string, emoji: string) => {
          await this.connector.addReaction(channelId, messageId, emoji)
        },
        uploadFile: async (buffer: Buffer, filename: string, contentType: string, caption?: string) => {
          return await this.connector.sendFileAttachment(channelId, buffer, filename, contentType, caption)
        },
        visibleImages: initialVisibleImages,
      })
      endProfile('pluginSetup')

      const originalCount = discordContext.messages.length
      discordContext.messages = discordContext.messages.filter(msg => {
        const contentWithoutReply = msg.content?.trim().replace(/^<reply:@[^>]+>\s*/, '') || ''
        return !/^m\s+/i.test(contentWithoutReply)
      })
      
      if (discordContext.messages.length < originalCount) {
        logger.debug({ 
          filtered: originalCount - discordContext.messages.length,
          remaining: discordContext.messages.length
        }, 'Filtered m commands from context')
      }

      if (discordContext.messages.length > 0) {
        const oldestMessageId = discordContext.messages[0]!.id
        this.stateManager.pruneToolCache(this.botId, channelId, oldestMessageId)
      }
      
      startProfile('toolCacheReload')
      const existingMessageIds = new Set(discordContext.messages.map(m => m.id))
      const filteredToolCache = await this.toolSystem.loadCacheWithResults(
        this.botId,
        channelId,
        existingMessageIds
      )
      const toolCacheForContext = filteredToolCache
      endProfile('toolCacheReload')

      const thinkingByMessageId = config.preserve_thinking_blocks !== false
        ? loadThinkingBlocks(this.cacheDir, this.botId, channelId, existingMessageIds)
        : undefined
      
      const cachedMcpImages: Array<{ toolName: string; images: Array<{ data: string; mimeType: string }> }> = []
      for (const entry of filteredToolCache) {
        if (entry.result?.images && Array.isArray(entry.result.images) && entry.result.images.length > 0) {
          cachedMcpImages.push({
            toolName: entry.call.name,
            images: entry.result.images,
          })
        }
      }
      
      if (cachedMcpImages.length > 0) {
        const mcpVisibleImages = cachedMcpImages.flatMap(({ toolName, images }) =>
          images.map((img, i) => ({
            index: 0,
            source: 'mcp_tool' as const,
            sourceDetail: toolName,
            data: img.data,
            mimeType: img.mimeType,
            description: `cached result ${i + 1} from ${toolName}`,
          }))
        )
        
        const existingContext = this.toolSystem.getPluginContext()
        const discordImages = (existingContext?.visibleImages || [])
          .filter(img => img.source === 'discord')
        
        const allVisibleImages = [...mcpVisibleImages, ...discordImages]
          .map((img, i) => ({ ...img, index: i + 1 }))
        
        this.toolSystem.setPluginContext({ visibleImages: allVisibleImages })
        logger.debug({ 
          cachedMcpImageCount: mcpVisibleImages.length,
          discordImageCount: discordImages.length 
        }, 'Updated visible images with cached MCP results')
      }
      
      discordContext.messages = this.messagesNotCoveredByToolCache(
        discordContext.messages,
        toolCacheForContext,
        config
      )

      let activationsForContext: Activation[] | undefined
      if (config.preserve_thinking_context) {
        startProfile('activationsLoad')
        activationsForContext = await this.activationStore.loadActivationsForChannel(
          this.botId,
          channelId,
          existingMessageIds
        )
        endProfile('activationsLoad')
        logger.debug({ 
          activationCount: activationsForContext.length 
        }, 'Loaded activations for context')
      }

      startProfile('pluginInjections')
      let pluginInjections: ContextInjection[] = []
      const loadedPlugins = this.toolSystem.getLoadedPluginObjects()
      if (loadedPlugins.size > 0) {
        const messageIds = discordContext.messages.map(m => m.id)
        const pluginContextFactory = new PluginContextFactory({
          cacheDir: this.cacheDir,
          messageIds,
        })
        
        const basePluginContext = {
          botId: this.botId,
          channelId,
          guildId,
          currentMessageId: triggeringMessageId || '',
          config,
          sendMessage: async (content: string) => {
            return await this.connector.sendMessage(channelId, content)
          },
          pinMessage: async (messageId: string) => {
            await this.connector.pinMessage(channelId, messageId)
          },
          addReaction: async (messageId: string, emoji: string) => {
            await this.connector.addReaction(channelId, messageId, emoji)
          },
          uploadFile: async (buffer: Buffer, filename: string, contentType: string, caption?: string) => {
            return await this.connector.sendFileAttachment(channelId, buffer, filename, contentType, caption)
          },
        }
        
        for (const [pluginName, plugin] of loadedPlugins) {
          if (plugin.getContextInjections) {
            try {
              let pluginInstanceConfig = config.plugin_config?.[pluginName]
              if (pluginName === 'character' && pluginInstanceConfig) {
                const recentCount = pluginInstanceConfig.recent_messages || 7
                const recentMsgs = discordContext.messages.slice(-recentCount)
                pluginInstanceConfig = {
                  ...pluginInstanceConfig,
                  _recentMessages: recentMsgs.map((m: any) => `${m.author?.username || 'unknown'}: ${m.content || ''}`),
                }
              }
              
              if (pluginInstanceConfig?.state_scope === 'off') {
                logger.debug({ pluginName }, 'Skipping disabled plugin (state_scope: off)')
                continue
              }
              
              const stateContext = pluginContextFactory.createStateContext(
                pluginName,
                basePluginContext,
                discordContext.inheritanceInfo,
                undefined,
                pluginInstanceConfig
              )
              const injections = await plugin.getContextInjections(stateContext)
              pluginInjections.push(...injections)
              
              if (injections.length > 0) {
                logger.debug({ 
                  pluginName, 
                  injectionCount: injections.length,
                  injectionIds: injections.map(i => i.id),
                }, 'Got context injections from plugin')
              }
            } catch (error) {
              logger.error({ error, pluginName }, 'Failed to get context injections from plugin')
            }
          }
        }
        
        this.toolSystem.setPluginContextFactory(pluginContextFactory, config.plugin_config)
      }
      endProfile('pluginInjections')

      startProfile('contextBuild')
      const buildParams: BuildContextParams = {
        discordContext,
        toolCacheWithResults: toolCacheForContext,
        lastCacheMarker: state.lastCacheMarker,
        messagesSinceRoll: state.messagesSinceRoll,
        config,
        botDiscordUsername: this.connector.getBotUsername(),
        activations: activationsForContext,
        pluginInjections,
        thinkingByMessageId,
      }

      const contextResult = await this.contextBuilder.buildContext(buildParams)

      // With streaming off, membrane runs no tool calls on the native path, so the
      // request goes without tools rather than offer the model tools that can't run.
      const toolMode = resolveToolModeForModel(config.continuation_model, config.mode)
      const streamingOffBlocksTools = config.streaming === false && toolMode === 'native'
      if (config.tools_enabled) {
        const availableTools = this.toolSystem.getAvailableTools()
        if (!streamingOffBlocksTools) {
          contextResult.request.tools = availableTools
          logger.info({ 
            toolCount: availableTools.length,
            toolNames: availableTools.map(t => t.name),
            serverNames: [...new Set(availableTools.map(t => t.serverName))]
          }, 'Tools being sent to LLM')
        } else if (availableTools.length > 0) {
          logger.warn(
            { channelId, model: config.continuation_model, toolCount: availableTools.length },
            'Tools not sent: with streaming off, membrane runs no tool calls on the native tool path. Set tools_enabled: false to stop this warning.'
          )
        }
      }
      endProfile('contextBuild')

      let activation: Activation | undefined
      if (config.preserve_thinking_context) {
        const triggerType: TriggerType = this.determineTriggerType(triggeringMessageId)
        activation = this.activationStore.startActivation(
          this.botId,
          channelId,
          {
            type: triggerType,
            anchorMessageId: triggeringMessageId || discordContext.messages[discordContext.messages.length - 1]?.id || '',
          }
        )
      }

      const preLlmTime = Date.now() - profileStart
      logger.info({ 
        ...timings, 
        totalPreLLM: preLlmTime,
        messagesFetched: discordContext.messages.length,
        imagesFetched: discordContext.images.length,
      }, '⏱️  PROFILING: Pre-LLM phase timings (ms)')

      startProfile('llmCall')

      const hasTools = config.tools_enabled && (contextResult.request.tools?.length ?? 0) > 0

      let executionResult: {
        completion: any;
        toolCallIds: string[];
        fullCompletionText?: string;
        sentMessageIds: string[];
        messageContexts: Record<string, MessageContext>;
      }

      if (toolMode === 'native') {
        logger.debug({ model: config.continuation_model, toolMode, hasTools }, 'Using native tool execution path')
        executionResult = await this.executeWithNativeTools(
          contextResult.request,
          config,
          channelId,
          triggeringMessageId || '',
          activation?.id,
          discordContext.messages
        )
      } else {
        executionResult = await this.executeWithInlineTools(
          contextResult.request,
          config,
          channelId,
          triggeringMessageId || '',
          activation?.id,
          discordContext.messages
        )
      }

      const {
        completion,
        toolCallIds,
        fullCompletionText,
        sentMessageIds: inlineSentMessageIds,
        messageContexts: inlineMessageContexts
      } = executionResult
      endProfile('llmCall')
      this.recordAnsweredContext(channelId, newestFetchedId)

      if (activeSteering && config.steer_readout === true) {
        try {
          const credentials = resolveVendorForModel(config.continuation_model, this.vendorConfigs)
          if (!credentials) {
            logger.debug({ model: config.continuation_model }, 'Readout skipped: no vendor credentials resolved')
          }
          let readoutResponse: Record<string, unknown> = {}

          if (credentials) {
            const completionId = (completion.raw as Record<string, unknown>)?.id as string | undefined
              || (completion as Record<string, unknown>).id as string | undefined

            if (!completionId) {
              logger.debug('Readout skipped: no completion ID in LLM response')
            }

            if (completionId) {
              logger.debug({ completionId }, 'Fetching steering readout from proxy')
              const proxyData = await fetchProxyReadout(completionId, credentials)
              if (!proxyData) {
                logger.debug({ completionId }, 'Readout: proxy returned no data (404 or timeout)')
              }
              if (proxyData) {
                readoutResponse.intervention_applied = proxyData.intervention_applied
                readoutResponse.probe_status = proxyData.probe_status
                readoutResponse.response_token_ids = proxyData.response_token_ids

                if (proxyData.response_token_ids && proxyData.response_token_ids.length > 0 && activeSteering.readout_probes.length > 0) {
                  const encodeResult = await fetchProbeReadout(
                    proxyData.response_token_ids,
                    activeSteering.readout_probes,
                    config.continuation_model,
                    credentials,
                  )
                  if (encodeResult) {
                    readoutResponse.token_probes = encodeResult.token_probes
                    readoutResponse.probe_names = encodeResult.probe_names
                    readoutResponse.probe_status = 'complete'
                  }
                }
              }
            }
          }

          const readout = formatReadout(readoutResponse, activeSteering)
          if (readout) {
            await this.connector.sendMessageWithAttachment(
              channelId,
              '.steer-readout',
              { name: 'steering-readout.txt', content: readout }
            )
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to send steering readout')
        }
      }

      await this.connector.stopTyping(channelId)

      const wasRefused = completion.stopReason === 'refusal'
      if (wasRefused) {
        logger.warn({ stopReason: completion.stopReason }, 'LLM refused to complete request')
      }

      const imageBlocks = completion.content.filter((c: any) => c.type === 'image')
      if (imageBlocks.length > 0) {
        logger.info({ imageCount: imageBlocks.length }, 'Completion contains generated images')

        const imageSentIds: string[] = []
        for (const imageBlock of imageBlocks) {
          try {
            const imageData = imageBlock.source?.data
            const mediaType = imageBlock.source?.media_type || 'image/png'

            if (imageData) {
              const msgIds = await this.connector.sendImageAttachment(
                channelId,
                imageData,
                mediaType,
                undefined,
                triggeringMessageId
              )
              imageSentIds.push(...msgIds)
              logger.debug({ messageId: msgIds[0], mediaType }, 'Sent generated image to Discord')
            }
          } catch (err) {
            logger.error({ err }, 'Failed to send generated image to Discord')
          }
        }

        const textMessageIds = inlineSentMessageIds ?? []
        const allMessageIds = [...new Set([...textMessageIds, ...imageSentIds])]
        const responseText = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')

        if (activation) {
          this.activationStore.addCompletion(
            activation.id,
            responseText || '[Generated image]',
            allMessageIds,
            [],
            []
          )
          if (inlineMessageContexts) {
            for (const [msgId, contextChunk] of Object.entries(inlineMessageContexts)) {
              this.activationStore.setMessageContext(activation.id, msgId, contextChunk)
            }
          }
          await this.activationStore.completeActivation(activation.id)
        }

        const fallbackCoverage = toolMode === 'native'
          ? []
          : [...new Set(textMessageIds)]
        if (toolCallIds.length > 0 && allMessageIds.length > 0) {
          await this.toolSystem.updateBotMessageIds(
            this.botId,
            channelId,
            toolCallIds,
            allMessageIds,
            fallbackCoverage
          )
        }

        if (contextResult.cacheMarker) {
          this.stateManager.updateCacheMarker(this.botId, channelId, contextResult.cacheMarker)
        }

        trace?.recordOutcome({
          success: true,
          responseText: responseText || '[Generated image]',
          responseLength: responseText.length,
          sentMessageIds: allMessageIds,
          messagesSent: allMessageIds.length,
          maxToolDepth: 1,
          hitMaxToolDepth: false,
          stateUpdates: {
            cacheMarkerUpdated: !!contextResult.cacheMarker,
            newCacheMarker: contextResult.cacheMarker || undefined,
            messageCountReset: false,
            newMessageCount: 1,
          }
        })

        return
      }

      const sentMessageIds = inlineSentMessageIds ?? []
      
      const responseText = completion.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      
      logger.debug({
        contentBlocks: completion.content.length,
        textBlocks: completion.content.filter((c: any) => c.type === 'text').length,
        responseLength: responseText.length,
        sentMessageCount: sentMessageIds.length,
        isPhantom: sentMessageIds.length === 0,
      }, 'Collected sent message IDs')

      if (wasRefused) {
        const category = refusalCategory(completion)
        const emoji = (category && REFUSAL_CATEGORY_EMOJI[category]) || REFUSAL_DEFAULT_EMOJI
        if (sentMessageIds.length > 0) {
          for (const msgId of sentMessageIds) {
            await this.connector.addReaction(channelId, msgId, emoji)
          }
          logger.info({ sentMessageIds, category, emoji }, 'Added refusal reaction to sent messages')
        } else if (triggeringMessageId) {
          await this.connector.addReaction(channelId, triggeringMessageId, emoji)
          logger.info({ triggeringMessageId, category, emoji }, 'Added refusal reaction to triggering message (phantom)')
        }
      }
      
      if (activation) {
        const activationCompletionText = fullCompletionText || completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
        
        this.activationStore.addCompletion(
          activation.id,
          activationCompletionText,
          sentMessageIds,
          [],
          []
        )
        
        if (inlineMessageContexts) {
          for (const [msgId, contextChunk] of Object.entries(inlineMessageContexts)) {
            this.activationStore.setMessageContext(activation.id, msgId, contextChunk)
          }
        }
        
        await this.activationStore.completeActivation(activation.id)
      }
      
      const allBotMessageIds = [...new Set(sentMessageIds)]
      const fallbackCoverage = toolMode === 'native'
        ? []
        : allBotMessageIds
      if (toolCallIds.length > 0 && allBotMessageIds.length > 0) {
        await this.toolSystem.updateBotMessageIds(
          this.botId,
          channelId,
          toolCallIds,
          allBotMessageIds,
          fallbackCoverage
        )
      }

      const prevCacheMarker = state.lastCacheMarker
      const prevMessagesSinceRoll = state.messagesSinceRoll

      if (promptCachingEnabled) {
        if (contextResult.cacheMarker && contextResult.cacheMarker !== prevCacheMarker) {
          this.stateManager.updateCacheMarker(this.botId, channelId, contextResult.cacheMarker)
        }

        if (contextResult.didRoll) {
          const oldestMessageId =
            contextResult.request.messages.find((m) => m.messageId)?.messageId ?? null
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, oldestMessageId)
          logger.debug({ channelId, oldestMessageId }, 'Context rolled, recorded oldest message for cache stability')
        }
      }

      if (contextResult.didRoll) {
        this.stateManager.resetMessageCount(this.botId, channelId)
      } else {
        this.stateManager.incrementMessageCount(this.botId, channelId)
      }

      if (trace) {
        trace.recordOutcome({
          success: true,
          responseText,
          responseLength: responseText.length,
          sentMessageIds,
          messagesSent: sentMessageIds.length,
          maxToolDepth: trace.getLLMCallCount(),
          hitMaxToolDepth: false,
          stateUpdates: {
            cacheMarkerUpdated: contextResult.cacheMarker !== prevCacheMarker,
            newCacheMarker: contextResult.cacheMarker || undefined,
            messageCountReset: contextResult.didRoll,
            newMessageCount: contextResult.didRoll ? 0 : prevMessagesSinceRoll + 1,
          },
        })
      }

      if (this.somaClient && sentMessageIds.length > 0 && triggeringMessageId) {
        const triggeringMessage = discordContext.messages.find(m => m.id === triggeringMessageId)
        const triggerUserId = triggeringMessage?.author?.id
        
        if (triggerUserId && !triggeringMessage?.author?.bot) {
          for (const messageId of sentMessageIds) {
            try {
              await this.somaClient.trackMessage({
                messageId,
                channelId,
                serverId: guildId,
                botId: this.botUserId || '',
                triggerUserId,
                triggerMessageId: triggeringMessageId,
              })
            } catch (trackError) {
              logger.warn({ trackError, messageId }, 'Failed to track message for Soma')
            }
          }
        }
      }

      logger.info({ channelId, tokens: completion.usage, didRoll: contextResult.didRoll }, 'Activation complete')
    } catch (error) {
      await this.connector.stopTyping(channelId)

      if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
        this.ttsRelayClient.sendActivationEnd({
          channelId: this.ttsStreamContext.channelId,
          userId: this.ttsStreamContext.userId,
          username: this.ttsStreamContext.username,
          reason: 'error',
        })
      }
      this.ttsStreamContext = undefined

      if (this.deferredQueue && isTransientError(error)) {
        const queued = this.deferredQueue.queueActivation({
          botId: this.botId,
          channelId,
          guildId,
          error: error instanceof Error ? error : new Error(String(error)),
          originalTriggerId: triggeringMessageId,
          retryAttempt: deferredRetryState?.retryAttempt ?? 0,
          originalCreatedAt: deferredRetryState?.createdAt,
        })

        if (queued) {
          logger.warn({ channelId, error: error instanceof Error ? error.message : String(error) },
            'Transient API error - queued for retry')

          if (triggeringMessageId) {
            try {
              await this.connector.addReaction(channelId, triggeringMessageId, '⏳')
            } catch (reactionError) {
              logger.debug({ reactionError }, 'Failed to add retry reaction')
            }
          }

          if (trace) {
            trace.captureLog('warn', 'Queued for deferred retry', {
              errorType: (error as any)?.type,
              retryable: true,
            })
          }

          return
        }
      }

      if (trace) {
        trace.recordError('llm_call', error instanceof Error ? error : new Error(String(error)))
      }

      throw error
    }
  }

  private ttsStreamContext?: {
    channelId: string
    userId: string
    username: string
    abortController: AbortController
    interruptedText?: string
  }

  private async completeLLM(request: any, config: BotConfig): Promise<any> {
    if (!this.membraneProvider) {
      throw new Error('Membrane not initialized - call setMembrane() before processing requests')
    }

    const shouldStreamToTTS =
      config.tts_relay?.enabled &&
      this.ttsRelayClient?.isConnected() &&
      this.ttsStreamContext

    const streamOptions: any = {}

    if (shouldStreamToTTS) {
      const ctx = this.ttsStreamContext!
      const relay = this.ttsRelayClient!

      streamOptions.signal = ctx.abortController.signal

      streamOptions.onChunk = (text: string, meta: any) => {
        const blockType = meta?.type ?? 'text'
        const visible = meta?.visible ?? true
        logger.info({
          textPreview: text.substring(0, 80),
          blockIndex: meta?.blockIndex,
          blockType,
          visible,
          hasThinkingTag: text.includes('<thinking>') || text.includes('</thinking>'),
        }, `TTS chunk: type=${blockType} visible=${visible}`)

        relay.sendChunk({
          channelId: ctx.channelId,
          userId: ctx.userId,
          username: ctx.username,
          text,
          blockIndex: meta?.blockIndex ?? 0,
          blockType,
          visible,
        })
      }

      streamOptions.onBlock = (event: any) => {
        const blockIndex = event?.index ?? 0
        const blockType = event?.block?.type ?? 'text'
        const blockContent = (event?.block as any)?.content ?? ''

        logger.info({
          eventType: event?.event,
          blockIndex,
          blockType,
          contentPreview: blockContent.substring(0, 80),
        }, `TTS block: ${event?.event} type=${blockType}`)

        if (event?.event === 'block_start') {
          relay.sendBlockStart({
            channelId: ctx.channelId,
            userId: ctx.userId,
            username: ctx.username,
            blockIndex,
            blockType,
          })
        } else if (event?.event === 'block_complete') {
          relay.sendBlockComplete({
            channelId: ctx.channelId,
            userId: ctx.userId,
            username: ctx.username,
            blockIndex,
            blockType,
            content: blockContent,
          })
        }
      }
    }

    logger.debug({
      model: request.config?.model,
      tts: !!shouldStreamToTTS,
    }, 'Using membrane stream for LLM completion')

    try {
      const result = await this.membraneProvider.stream(request, streamOptions)

      if (shouldStreamToTTS) {
        logger.info({
          contentBlockCount: result?.content?.length,
          contentBlockTypes: result?.content?.map((b: any) => b.type),
          stopReason: result?.stopReason,
        }, 'Stream complete - membrane result summary')
      }

      return result
    } catch (error: any) {
      if (shouldStreamToTTS && this.ttsStreamContext?.interruptedText &&
          (error.name === 'AbortError' || this.ttsStreamContext.abortController.signal.aborted)) {
        logger.info(
          { channelId: this.ttsStreamContext.channelId, textLength: this.ttsStreamContext.interruptedText.length },
          'Stream aborted due to TTS interruption, using interrupted text'
        )
        return {
          content: [{ type: 'text', text: this.ttsStreamContext.interruptedText }],
          stopReason: 'interrupted',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'interrupted',
        }
      }
      throw error
    }
  }

  /** Membrane runs the multi-turn tool loop itself, through onToolCalls. */
  private async executeWithNativeTools(
    llmRequest: any,
    config: BotConfig,
    channelId: string,
    triggeringMessageId: string,
    _activationId?: string,
    discordMessages?: DiscordMessage[]
  ): Promise<{
    completion: any;
    toolCallIds: string[];
    fullCompletionText?: string;
    sentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
  }> {
    const allToolCallIds: string[] = []
    const allSentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    const pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }> = []
    let accumulatedPreToolText = ''
    // Not membrane's preamble, which includes the round's thinking.
    let roundPostedText = ''
    let roundPostedMessageIds: string[] = []
    // Membrane's final native response includes all text from every tool round,
    // including prose already delivered through onPreToolContent.
    let flushedPreToolText = ''
    let markdownCarry: MarkdownCarry = []

    if (config.tts_relay?.enabled && this.ttsRelayClient?.isConnected() && this.botUserId) {
      this.ttsStreamContext = {
        channelId,
        userId: this.botUserId,
        username: this.connector.getBotUsername() || config.name,
        abortController: new AbortController(),
      }
    }

    const ttsCtx = this.ttsStreamContext
    const ttsRelay = this.ttsRelayClient

    try {
      const result = await this.membraneProvider!.stream(llmRequest, {
        signal: ttsCtx?.abortController.signal,
        maxToolDepth: config.max_tool_depth,

        ...(ttsCtx && ttsRelay?.isConnected() ? {
          onChunk: (text: string, meta: any) => {
            const blockType = meta?.type ?? 'text'
            const visible = meta?.visible ?? true
            ttsRelay.sendChunk({
              channelId: ttsCtx.channelId,
              userId: ttsCtx.userId,
              username: ttsCtx.username,
              text,
              blockIndex: meta?.blockIndex ?? 0,
              blockType,
              visible,
            })
          },
          onBlock: (event: any) => {
            const blockIndex = event?.index ?? 0
            const blockType = event?.block?.type ?? 'text'
            const blockContent = (event?.block as any)?.content ?? ''
            if (event?.event === 'block_start') {
              ttsRelay.sendBlockStart({
                channelId: ttsCtx.channelId,
                userId: ttsCtx.userId,
                username: ttsCtx.username,
                blockIndex,
                blockType,
              })
            } else if (event?.event === 'block_complete') {
              ttsRelay.sendBlockComplete({
                channelId: ttsCtx.channelId,
                userId: ttsCtx.userId,
                username: ttsCtx.username,
                blockIndex,
                blockType,
                content: blockContent,
              })
            }
          },
        } : {}),

        onPreToolContent: async (text: string) => {
          accumulatedPreToolText += text
          const segments = this.parseIntoSegments(accumulatedPreToolText)
          if (segments.length > 0) {
            if (discordMessages) {
              const fullVisibleText = segments.map(s => s.visible).join('')
              const truncResult = this.truncateAtParticipant(
                fullVisibleText,
                discordMessages,
                this.connector.getBotUsername() || config.name,
                llmRequest.stop_sequences,
                config
              )
              if (truncResult.truncatedAt) {
                logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncating native pre-tool text at participant')
                return
              }
            }

            const postedVisibleText = segments.map(s => s.visible).join(' ')
            if (discordMessages) {
              await this.replaceMentionsInSegments(segments, discordMessages, config, markdownCarry)
            }

            const sendResult = await this.sendSegments(
              channelId,
              segments,
              allSentMessageIds.length === 0 ? triggeringMessageId : undefined,
              markdownCarry
            )
            markdownCarry = sendResult.endCarry
            allSentMessageIds.push(...sendResult.sentMessageIds)
            roundPostedMessageIds.push(...sendResult.sentMessageIds)
            for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
              messageContexts[msgId] = ctx
            }
            flushedPreToolText += accumulatedPreToolText
            roundPostedText = roundPostedText ? `${roundPostedText} ${postedVisibleText}` : postedVisibleText
            accumulatedPreToolText = ''
          }
        },

        onToolCalls: async (calls, context) => {
          const results: Array<{ toolUseId: string; content: string; isError?: boolean }> = []

          logger.debug({
            toolCount: calls.length,
            depth: context.depth,
          }, 'Executing native tools')

          for (const call of calls) {
            const toolStartTime = Date.now()

            const cxCall: ToolCall = {
              id: call.id,
              name: call.name,
              input: call.input as Record<string, any>,
              messageId: triggeringMessageId,
              timestamp: new Date(),
              originalCompletionText: roundPostedText,
              coveredMessageIds: [...roundPostedMessageIds],
            }

            const toolResult = await this.toolSystem.executeTool(cxCall)
            const toolDurationMs = Date.now() - toolStartTime

            allToolCallIds.push(call.id)

            const outputStr = toolOutputText(toolResult.output)

            let content: string
            let isError = false
            if (toolResult.error) {
              content = `Error executing ${call.name}: ${toolResult.error}`
              isError = true
            } else {
              content = outputStr
            }

            pendingToolPersistence.push({ call: cxCall, result: toolResult })

            const traceOutput = toolResult.error
              ? `[ERROR] ${toolResult.error}`
              : (outputStr.length > 1000 ? outputStr.slice(0, 1000) + '...' : outputStr)
            traceToolExecution({
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
              output: traceOutput,
              outputTruncated: !toolResult.error && outputStr.length > 1000,
              fullOutputLength: toolResult.error ? traceOutput.length : outputStr.length,
              durationMs: toolDurationMs,
              sentToDiscord: config.tool_output_visible,
              error: toolResult.error ? String(toolResult.error) : undefined,
              imageCount: toolResult.images?.length,
            })

            if (config.tool_output_visible) {
              const inputStr = JSON.stringify(call.input)
              const rawOutput = toolOutputText(toolResult.output)
              const flatOutput = rawOutput.replace(/\n/g, ' ').replace(/\s+/g, ' ')
              const maxLen = 200
              const trimmedOutput = flatOutput.length > maxLen
                ? `${flatOutput.slice(0, maxLen)}... (${rawOutput.length} chars)`
                : flatOutput
              const toolMessage = `.${config.name}>[${call.name}]: ${inputStr}\n.${config.name}<[${call.name}]: ${trimmedOutput}`
              await this.connector.sendWebhook(channelId, toolMessage, config.name)

              if (toolResult.images && toolResult.images.length > 0) {
                for (let i = 0; i < toolResult.images.length; i++) {
                  const img = toolResult.images[i]!
                  try {
                    await this.connector.sendImageAttachment(
                      channelId,
                      img.data,
                      img.mimeType,
                      `.${config.name}<[${call.name}] image ${i + 1}/${toolResult.images.length}`,
                      undefined
                    )
                  } catch (err) {
                    logger.warn({ err, toolName: call.name, imageIndex: i }, 'Failed to send MCP tool image to Discord')
                  }
                }
              }
            }

            logger.debug({
              toolName: call.name,
              durationMs: toolDurationMs,
              hasError: !!toolResult.error,
              outputLength: outputStr.length,
            }, 'Native tool executed')

            results.push({
              toolUseId: call.id,
              content,
              isError,
            })
          }

          roundPostedText = ''
          roundPostedMessageIds = []
          return results
        },
      })

      for (const { call, result } of pendingToolPersistence) {
        await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
      }

      const completionText = (result?.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')

      // Membrane doesn't pass onPreToolContent a round whose text is blank but keeps
      // that text in the response, so the match skips whitespace.
      let remainingCompletionText = completionText
      if (flushedPreToolText) {
        const postedEnd = endOfPostedPrefix(completionText, flushedPreToolText)
        if (postedEnd !== undefined) {
          remainingCompletionText = completionText.slice(postedEnd)
        } else if (completionText) {
          logger.warn({
            completionLength: completionText.length,
            flushedLength: flushedPreToolText.length,
          }, 'Native tool response did not start with the prose already posted; sending all of it')
        }
      }

      const generatedImageBlocks: ContentBlock[] = (result?.content || [])
        .filter((c: any) => c.type === 'image')

      // Signature-only blocks (display:'omitted') carry the encrypted reasoning and
      // must round-trip verbatim.
      const nativeThinkingBlocks: ThinkingBlock[] = (result?.content || [])
        .filter((c: any): c is ThinkingBlock => c.type === 'thinking' || c.type === 'redacted_thinking')

      const { stripped, content: textThinkingContent } = this.stripThinkingBlocks(
        this.toolSystem.stripToolXml(completionText)
      )
      const { stripped: remainingStripped } = this.stripThinkingBlocks(
        this.toolSystem.stripToolXml(remainingCompletionText)
      )

      const thinkingContent = [
        ...nativeThinkingBlocks
          .filter((b): b is ThinkingBlock & { type: 'thinking' } => b.type === 'thinking')
          .map(b => b.thinking)
          .filter(t => t && t.trim()),
        ...textThinkingContent,
      ]

      if (config.debug_thinking && thinkingContent.length > 0) {
        for (const thinking of thinkingContent) {
          if (thinking.trim()) {
            try {
              if (thinking.length <= 1900) {
                await this.connector.sendMessage(channelId, `.💭 ${thinking}`)
              } else {
                await this.connector.sendMessageWithAttachment(
                  channelId,
                  '.💭 thinking trace attached',
                  { name: 'thinking.md', content: thinking }
                )
              }
            } catch (err) {
              logger.warn({ err }, 'Failed to send debug thinking message')
            }
          }
        }
      }

      let displayText = stripped
      let remainingDisplayText = remainingStripped
      if (discordMessages) {
        const truncResult = this.truncateAtParticipant(
          displayText,
          discordMessages,
          this.connector.getBotUsername() || config.name,
          llmRequest.stop_sequences,
          config
        )
        if (truncResult.truncatedAt) {
          logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncated native output at participant')
          displayText = truncResult.text
        }

        const remainingTruncResult = this.truncateAtParticipant(
          remainingDisplayText,
          discordMessages,
          this.connector.getBotUsername() || config.name,
          llmRequest.stop_sequences,
          config
        )
        if (remainingTruncResult.truncatedAt) {
          remainingDisplayText = remainingTruncResult.text
        }
      }

      if (remainingDisplayText.trim()) {
        const segments = this.parseIntoSegments(remainingDisplayText)
        if (segments.length > 0) {
          if (discordMessages) {
            await this.replaceMentionsInSegments(segments, discordMessages, config, markdownCarry)
          }
          const sendResult = await this.sendSegments(
            channelId,
            segments,
            allSentMessageIds.length === 0 ? triggeringMessageId : undefined,
            markdownCarry
          )
          markdownCarry = sendResult.endCarry
          allSentMessageIds.push(...sendResult.sentMessageIds)
          for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
            messageContexts[msgId] = ctx
          }
        }
      }

      if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
        this.ttsRelayClient.sendActivationEnd({
          channelId: this.ttsStreamContext.channelId,
          userId: this.ttsStreamContext.userId,
          username: this.ttsStreamContext.username,
          reason: 'complete',
        })
      }
      this.ttsStreamContext = undefined

      const nativeContentBlocks: ContentBlock[] = [{ type: 'text', text: displayText }]
      if (generatedImageBlocks.length > 0) {
        nativeContentBlocks.push(...generatedImageBlocks)
      }

      // Only the FINAL response's blocks: the turn is rebuilt from Discord as
      // one assistant message, and the API rejects a latest turn carrying
      // thinking from several tool-loop responses.
      const persistedThinkingBlocks = finalStepThinkingBlocks(result?.content || [])
      if (config.preserve_thinking_blocks !== false && persistedThinkingBlocks.length > 0 && allSentMessageIds.length > 0) {
        persistThinkingBlocks(this.cacheDir, this.botId, channelId, allSentMessageIds, persistedThinkingBlocks, config.continuation_model)
      }

      return {
        completion: {
          content: nativeContentBlocks,
          stopReason: (result?.stopReason || 'end_turn') as any,
          usage: result?.usage || { inputTokens: 0, outputTokens: 0 },
          model: result?.model || '',
          raw: result?.raw ?? null,
        },
        toolCallIds: allToolCallIds,
        fullCompletionText: completionText,
        sentMessageIds: allSentMessageIds,
        messageContexts,
      }
    } catch (error: any) {
      if (ttsCtx?.interruptedText && (error.name === 'AbortError' || ttsCtx.abortController.signal.aborted)) {
        logger.info(
          { channelId: ttsCtx.channelId, textLength: ttsCtx.interruptedText.length },
          'Native stream aborted due to TTS interruption, using interrupted text'
        )

        if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
          this.ttsRelayClient.sendActivationEnd({
            channelId: this.ttsStreamContext.channelId,
            userId: this.ttsStreamContext.userId,
            username: this.ttsStreamContext.username,
            reason: 'abort',
          })
        }
        this.ttsStreamContext = undefined

        return {
          completion: {
            content: [{ type: 'text', text: ttsCtx.interruptedText }],
            stopReason: 'interrupted',
            usage: { inputTokens: 0, outputTokens: 0 },
            model: 'interrupted',
          },
          toolCallIds: allToolCallIds,
          fullCompletionText: ttsCtx.interruptedText,
          sentMessageIds: allSentMessageIds,
          messageContexts,
        }
      }

      if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
        this.ttsRelayClient.sendActivationEnd({
          channelId: this.ttsStreamContext.channelId,
          userId: this.ttsStreamContext.userId,
          username: this.ttsStreamContext.username,
          reason: 'error',
        })
      }
      this.ttsStreamContext = undefined

      throw error
    }
  }

  // Stop sequence for inline tool execution (assembled to avoid stop sequence in source)
  private static readonly FUNC_CALLS_CLOSE = '</' + 'function_calls>'

  private async executeWithInlineTools(
    llmRequest: any,
    config: BotConfig,
    channelId: string,
    triggeringMessageId: string,
    _activationId?: string,
    discordMessages?: DiscordMessage[]
  ): Promise<{ 
    completion: any; 
    toolCallIds: string[]; 
    fullCompletionText?: string;
    sentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
  }> {
    let accumulatedOutput = ''
    let toolDepth = 0
    let markdownCarry: MarkdownCarry = []
    const allToolCallIds: string[] = []
    const allSentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    const maxToolDepth = config.max_tool_depth
    const pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }> = []
    
    let pendingToolImages: Array<{ toolName: string; images: Array<{ data: string; mimeType: string }> }> = []

    const generatedImageBlocks: ContentBlock[] = []
    
    const thinkingWasPrefilled = this.wasThinkingPrefilled(llmRequest, config)
    
    let lastContextEndPos = 0
    
    const baseRequest = {
      ...llmRequest,
      stop_sequences: [
        ...(llmRequest.stop_sequences || []),
        AgentLoop.FUNC_CALLS_CLOSE
      ]
    }

    if (config.tts_relay?.enabled && this.ttsRelayClient?.isConnected() && this.botUserId) {
      this.ttsStreamContext = {
        channelId,
        userId: this.botUserId,
        username: this.connector.getBotUsername() || config.name,
        abortController: new AbortController(),
      }
    }

    while (toolDepth < maxToolDepth) {
      const continuationRequest = this.buildInlineContinuationRequest(
        baseRequest, 
        accumulatedOutput,
        config,
        pendingToolImages.length > 0 ? pendingToolImages : undefined
      )
      
      let completion = await this.completeLLM(continuationRequest, config)

      if (completion.stopReason === 'stop_sequence') {
        // rawAssistantText keeps the XML tags membrane parses into structured blocks
        // (thinking, tool_use), which function_calls counting needs.
        const completionText = completion.rawAssistantText
          ?? completion.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('')

        const triggeredStopSequence = completion.raw?.stop_sequence
        
        const funcCallsOpen = (completionText.match(/<function_calls>/g) || []).length
        const funcCallsClose = (completionText.match(/<\/function_calls>/g) || []).length
        const insideFunctionCalls = funcCallsOpen > funcCallsClose
        
        if (insideFunctionCalls && triggeredStopSequence && 
            triggeredStopSequence !== AgentLoop.FUNC_CALLS_CLOSE) {
          logger.debug({ triggeredStopSequence }, 'Stop sequence inside function_calls, continuing')
          completion = await this.continueCompletionAfterStopSequence(
            continuationRequest,
            completion,
            triggeredStopSequence,
            config,
            thinkingWasPrefilled
          )
        } else if (triggeredStopSequence === AgentLoop.FUNC_CALLS_CLOSE) {
          let unclosedTag = this.detectUnclosedXmlTag(completionText)
          const hasThinkingBlock = completion.content.some((c: any) => c.type === 'thinking')
          if (!unclosedTag && thinkingWasPrefilled && !completionText.includes('</thinking>') && !hasThinkingBlock) {
            unclosedTag = 'thinking'
          }
          if (unclosedTag) {
            completion = await this.continueCompletionAfterStopSequence(
              continuationRequest,
              completion,
              triggeredStopSequence,
              config,
              thinkingWasPrefilled
            )
          }
        }
      }
      
      // parseAnthropicToolCalls needs the raw <function_calls> XML, which membrane
      // strips into tool_use blocks.
      const newText = completion.rawAssistantText
        ?? completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')

      accumulatedOutput += newText

      for (const block of completion.content) {
        if (block.type === 'image') {
          generatedImageBlocks.push(block)
        }
      }

      // The stop sequence consumes the matched text, though rawAssistantText may
      // already include it.
      if (completion.stopReason === 'stop_sequence' &&
          completion.raw?.stop_sequence === AgentLoop.FUNC_CALLS_CLOSE &&
          !accumulatedOutput.endsWith(AgentLoop.FUNC_CALLS_CLOSE)) {
        accumulatedOutput += AgentLoop.FUNC_CALLS_CLOSE
      }
      
      if (completion.stopReason === 'stop_sequence' && 
          completion.raw?.stop_sequence !== AgentLoop.FUNC_CALLS_CLOSE) {
        const funcCallsOpen = (accumulatedOutput.match(/<function_calls>/g) || []).length
        const funcCallsClose = (accumulatedOutput.match(/<\/function_calls>/g) || []).length
        const insideFunctionCalls = funcCallsOpen > funcCallsClose
        
        if (!insideFunctionCalls) {
          logger.debug({ 
            stopSequence: completion.raw?.stop_sequence 
          }, 'Stopped on participant name outside function_calls, returning')
          
          return this.finalizeInlineExecution({
            accumulatedOutput,
            pendingToolPersistence,
            allToolCallIds,
            allSentMessageIds,
            messageContexts,
            lastContextEndPos,
            markdownCarry,
            channelId,
            triggeringMessageId,
            config,
            llmRequest,
            discordMessages,
            stopReason: completion.stopReason,
            raw: completion.raw,
            generatedImageBlocks,
          })
        }
        logger.debug({
          stopSequence: completion.raw?.stop_sequence
        }, 'Stopped on participant name inside function_calls, continuing to parse')
      }
      
      const toolParse = this.toolSystem.parseAnthropicToolCalls(accumulatedOutput)
      
      if (!toolParse || toolParse.calls.length === 0) {
        if (this.toolSystem.hasIncompleteToolCall(accumulatedOutput)) {
          logger.warn('Incomplete tool call detected in non-streaming mode')
        }
        
        return this.finalizeInlineExecution({
          accumulatedOutput,
          pendingToolPersistence,
          allToolCallIds,
          allSentMessageIds,
          messageContexts,
          lastContextEndPos,
          markdownCarry,
          channelId,
          triggeringMessageId,
          config,
          llmRequest,
          discordMessages,
          stopReason: completion.stopReason,
          raw: completion.raw,
          generatedImageBlocks,
        })
      }
      
      logger.debug({ 
        toolCount: toolParse.calls.length, 
        toolDepth 
      }, 'Executing inline tools')
      
      let segments = this.parseIntoSegments(toolParse.beforeText)
      let sentMsgIdsThisRound: string[] = []
      
      if (segments.length > 0 && discordMessages && toolDepth === 0) {
        const fullVisibleText = segments.map(s => s.visible).join('')
        const truncResult = this.truncateAtParticipant(
          fullVisibleText,
          discordMessages,
          this.connector.getBotUsername() || config.name,
          llmRequest.stop_sequences,
          config
        )
        if (truncResult.truncatedAt?.startsWith('start_hallucination:')) {
          logger.warn({ truncatedAt: truncResult.truncatedAt }, 'Aborting inline execution - response started with hallucinated participant')
          return this.finalizeInlineExecution({
            accumulatedOutput: '',
            pendingToolPersistence,
            allToolCallIds,
            allSentMessageIds,
            messageContexts,
            lastContextEndPos,
            markdownCarry,
            channelId,
            triggeringMessageId,
            config,
            llmRequest,
            discordMessages,
            stopReason: 'hallucination',
            generatedImageBlocks: [],
          })
        }
        if (truncResult.truncatedAt) {
          logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncating pre-tool text at participant')
          segments = this.truncateSegmentsAtPosition(segments, truncResult.text.length)
        }
      }

      if (discordMessages) {
        await this.replaceMentionsInSegments(segments, discordMessages, config, markdownCarry)
      }
      
      if (segments.length > 0) {
        const sendResult = await this.sendSegments(
          channelId,
          segments,
          toolDepth === 0 ? triggeringMessageId : undefined,
          markdownCarry
        )
        markdownCarry = sendResult.endCarry
        sentMsgIdsThisRound = sendResult.sentMessageIds
        allSentMessageIds.push(...sentMsgIdsThisRound)
        
        for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
          messageContexts[msgId] = ctx
        }
        
        logger.debug({ 
          messageIds: sentMsgIdsThisRound, 
          segmentCount: segments.length 
        }, 'Sent pre-tool segments to Discord')
      }
      
      const resultsTexts: string[] = []
      
      for (const call of toolParse.calls) {
        call.messageId = triggeringMessageId
        
        const toolStartTime = Date.now()
        const result = await this.toolSystem.executeTool(call)
        const toolDurationMs = Date.now() - toolStartTime
        
        allToolCallIds.push(call.id)
        
        const outputStr = toolOutputText(result.output)
        
        let resultText = ''
        if (result.error) {
          resultText = `Error executing ${call.name}: ${result.error}`
        } else {
          resultText = outputStr
          if (result.images && result.images.length > 0) {
            pendingToolImages.push({
              toolName: call.name,
              images: result.images,
            })
            
            const mcpVisibleImages = pendingToolImages.flatMap(({ toolName, images }) =>
              images.map((img, i) => ({
                index: 0,
                source: 'mcp_tool' as const,
                sourceDetail: toolName,
                data: img.data,
                mimeType: img.mimeType,
                description: `result ${i + 1} from ${toolName}`,
              }))
            ).reverse()
            
            const existingContext = this.toolSystem.getPluginContext()
            const discordImages = (existingContext?.visibleImages || [])
              .filter(img => img.source === 'discord')
            
            const allVisibleImages = [...mcpVisibleImages, ...discordImages]
              .map((img, i) => ({ ...img, index: i + 1 }))
            
            this.toolSystem.setPluginContext({ visibleImages: allVisibleImages })
            
            const imageNote = result.images.map((img, i) => 
              `[Image ${i + 1}: ${img.mimeType}]`
            ).join('\n')
            resultText += '\n\n' + imageNote
          }
        }
        resultsTexts.push(resultText)
        
        pendingToolPersistence.push({ call, result })
        
        const traceOutput = result.error 
          ? `[ERROR] ${result.error}` 
          : (outputStr.length > 1000 ? outputStr.slice(0, 1000) + '...' : outputStr)
        traceToolExecution({
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          output: traceOutput,
          outputTruncated: !result.error && outputStr.length > 1000,
          fullOutputLength: result.error ? traceOutput.length : outputStr.length,
          durationMs: toolDurationMs,
          sentToDiscord: config.tool_output_visible,
          error: result.error ? String(result.error) : undefined,
          imageCount: result.images?.length,
        })
        
        if (config.tool_output_visible) {
          const inputStr = JSON.stringify(call.input)
          const rawOutput = toolOutputText(result.output)
          const flatOutput = rawOutput.replace(/\n/g, ' ').replace(/\s+/g, ' ')
          const maxLen = 200
          const trimmedOutput = flatOutput.length > maxLen 
            ? `${flatOutput.slice(0, maxLen)}... (${rawOutput.length} chars)`
            : flatOutput
          
          const toolMessage = `.${config.name}>[${call.name}]: ${inputStr}\n.${config.name}<[${call.name}]: ${trimmedOutput}`
          await this.connector.sendWebhook(channelId, toolMessage, config.name)
          
          if (result.images && result.images.length > 0) {
            for (let i = 0; i < result.images.length; i++) {
              const img = result.images[i]!
              try {
                await this.connector.sendImageAttachment(
                  channelId,
                  img.data,
                  img.mimeType,
                  `.${config.name}<[${call.name}] image ${i + 1}/${result.images.length}`,
                  undefined
                )
                logger.debug({ toolName: call.name, imageIndex: i }, 'Sent MCP tool image to Discord')
              } catch (err) {
                logger.warn({ err, toolName: call.name, imageIndex: i }, 'Failed to send MCP tool image to Discord')
              }
            }
          }
        }
      }
      
      const resultsText = resultsTexts.join('\n\n---\n\n')
      const newAccumulated = toolParse.beforeText + toolParse.fullMatch + 
        this.toolSystem.formatToolResultForInjection('', resultsText)
      
      if (sentMsgIdsThisRound.length > 0) {
        lastContextEndPos = newAccumulated.length
      }
      
      accumulatedOutput = newAccumulated
      
      toolDepth++
    }
    
    logger.warn('Reached max inline tool depth')
    
    return this.finalizeInlineExecution({
      accumulatedOutput,
      pendingToolPersistence,
      allToolCallIds,
      allSentMessageIds,
      messageContexts,
      lastContextEndPos,
      markdownCarry,
      channelId,
      triggeringMessageId,
      config,
      llmRequest,
      discordMessages,
      suffix: '[Max tool depth reached]',
      generatedImageBlocks,
    })
  }
  
  
  private async finalizeInlineExecution(params: {
    accumulatedOutput: string;
    pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }>;
    allToolCallIds: string[];
    allSentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
    lastContextEndPos: number;
    channelId: string;
    triggeringMessageId: string;
    config: BotConfig;
    llmRequest: any;
    discordMessages?: DiscordMessage[];
    suffix?: string;
    stopReason?: string;
    raw?: unknown;
    generatedImageBlocks?: ContentBlock[];
    markdownCarry: MarkdownCarry;
  }): Promise<{
    completion: any;
    toolCallIds: string[];
    fullCompletionText: string;
    sentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
    actualSentText: string;
  }> {
    let { accumulatedOutput } = params
    const { 
      pendingToolPersistence, allToolCallIds,
      allSentMessageIds, messageContexts, lastContextEndPos,
      channelId, triggeringMessageId, config, llmRequest, discordMessages,
      suffix, stopReason, generatedImageBlocks, markdownCarry
    } = params
    
    const remainingOutput = accumulatedOutput.slice(lastContextEndPos)
    
    let truncatedRemaining = remainingOutput
    if (discordMessages && remainingOutput) {
      const truncResult = this.truncateAtParticipant(
        remainingOutput,
        discordMessages,
        this.connector.getBotUsername() || config.name,
        llmRequest.stop_sequences,
        config
      )
      if (truncResult.truncatedAt) {
        logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncated inline output at participant')
        truncatedRemaining = truncResult.text
        accumulatedOutput = accumulatedOutput.slice(0, lastContextEndPos) + truncatedRemaining
      }
    }
    
    for (const { call, result } of pendingToolPersistence) {
      call.originalCompletionText = accumulatedOutput
      await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
    }
    
    const suffixText = suffix ? `\n${suffix}` : ''
    let segments = this.parseIntoSegments(truncatedRemaining + suffixText)
    
    const replyPattern = /^\s*<reply:@[^>]+>\s*/
    if (segments.length > 0 && replyPattern.test(segments[0]!.visible)) {
      segments[0]!.visible = segments[0]!.visible.replace(replyPattern, '').trim()
      if (!segments[0]!.visible) {
        if (segments.length > 1) {
          segments[1]!.prefix = segments[0]!.prefix + segments[1]!.prefix
        }
        segments.shift()
      }
    }

    if (discordMessages) {
      await this.replaceMentionsInSegments(segments, discordMessages, config, markdownCarry)
    }
    
    const { stripped, content: thinkingContent } = this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput))
    if (config.debug_thinking && thinkingContent.length > 0) {
      for (const thinking of thinkingContent) {
        if (thinking.trim()) {
          try {
            if (thinking.length <= 1900) {
              await this.connector.sendMessage(channelId, `.💭 ${thinking}`)
            } else {
              await this.connector.sendMessageWithAttachment(
                channelId,
                '.💭 thinking trace attached',
                { name: 'thinking.md', content: thinking }
              )
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to send debug thinking message')
          }
        }
      }
    }
    
    let actualSentText = ''
    if (segments.length > 0) {
      const sendResult = await this.sendSegments(
        channelId,
        segments,
        allSentMessageIds.length === 0 ? triggeringMessageId : undefined,
        markdownCarry
      )
      allSentMessageIds.push(...sendResult.sentMessageIds)

      for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
        messageContexts[msgId] = ctx
      }
      
      actualSentText = segments.map(s => s.visible).join('')
    }
    
    const allInvisible = this.extractAllInvisible(truncatedRemaining)
    if (!segments.length && allInvisible && allSentMessageIds.length > 0) {
      const lastMsgId = allSentMessageIds[allSentMessageIds.length - 1]!
      const existing = messageContexts[lastMsgId]
      messageContexts[lastMsgId] = {
        prefix: existing?.prefix ?? '',
        suffix: (existing?.suffix || '') + allInvisible
      }
    }
    
    const displayText = stripped
    
    const fullCompletionText = accumulatedOutput + suffixText

    if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
      this.ttsRelayClient.sendActivationEnd({
        channelId: this.ttsStreamContext.channelId,
        userId: this.ttsStreamContext.userId,
        username: this.ttsStreamContext.username,
        reason: 'complete',
      })
    }
    this.ttsStreamContext = undefined

    const contentBlocks: ContentBlock[] = [{ type: 'text', text: displayText + suffixText }]
    if (generatedImageBlocks && generatedImageBlocks.length > 0) {
      contentBlocks.push(...generatedImageBlocks)
    }

    return {
      completion: {
        content: contentBlocks,
        stopReason: (stopReason || 'end_turn') as any,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: '',
        raw: params.raw ?? null,
      },
      toolCallIds: allToolCallIds,
      fullCompletionText,
      sentMessageIds: allSentMessageIds,
      messageContexts,
      actualSentText,
    }
  }
  
  /** Anthropic allows images only in user messages, so MCP tool result images go in as user turns. */
  private buildInlineContinuationRequest(
    baseRequest: any,
    accumulatedOutput: string,
    config: BotConfig,
    toolResultImages?: Array<{ toolName: string; images: Array<{ data: string; mimeType: string }> }>
  ): any {
    if (!accumulatedOutput && (!toolResultImages || toolResultImages.length === 0)) {
      return baseRequest
    }
    
    // Trim trailing whitespace - Anthropic API rejects assistant prefill ending with whitespace
    const trimmedOutput = accumulatedOutput.trimEnd()
    
    const request = {
      ...baseRequest,
      messages: [...baseRequest.messages],
    }
    
    const lastMsgIndex = request.messages.length - 1
    const lastMsg = request.messages[lastMsgIndex]
    
    if (lastMsg && lastMsg.participant === config.name) {
      request.messages[lastMsgIndex] = {
        ...lastMsg,
        content: [{ type: 'text', text: trimmedOutput }],
      }
    } else if (trimmedOutput) {
      request.messages.push({
        participant: config.name,
        content: [{ type: 'text', text: trimmedOutput }],
      })
    }
    
    if (toolResultImages && toolResultImages.length > 0) {
      const imageMessages: any[] = []
      
      for (const { toolName, images } of toolResultImages) {
        if (images.length === 0) continue
        
        const imageContent: any[] = [
          { type: 'text', text: `[Tool result images from ${toolName}]` }
        ]
        
        for (const img of images) {
          imageContent.push({
            type: 'image',
            source: {
              type: 'base64',
              data: img.data,
              media_type: img.mimeType,
            },
          })
        }
        
        imageMessages.push({
          participant: `System<[${toolName}]`,
          content: imageContent,
        })
      }
      
      if (imageMessages.length > 0) {
        const insertIndex = request.messages.length - 1
        request.messages.splice(insertIndex, 0, ...imageMessages)
        
        logger.debug({ 
          imageMessageCount: imageMessages.length,
          totalImages: toolResultImages.reduce((sum, t) => sum + t.images.length, 0)
        }, 'Inserted MCP tool result images into continuation request')
      }
    }
    
    return request
  }

  /** Must mirror membrane's logic for whether the request prefilled thinking. */
  private wasThinkingPrefilled(request: any, config: BotConfig): boolean {
    if (!config.prefill_thinking) {
      return false
    }
    
    const messages = request.messages || []
    if (messages.length === 0) {
      return false
    }
    
    const lastMsg = messages[messages.length - 1]
    const botName = config.name
    
    if (lastMsg.participant !== botName) {
      return false
    }
    
    const lastContent = lastMsg.content || []
    const lastHasContent = lastContent.some((c: any) => {
      if (c.type === 'text') {
        return c.text && c.text.trim().length > 0
      }
      return false
    })
    
    const lastHasToolResult = lastContent.some((c: any) => c.type === 'tool_result')
    
    if (lastHasContent) {
      return false
    }
    
    let lastNonEmptyParticipant: string | null = null
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i]
      const content = msg.content || []
      const hasContent = content.some((c: any) => {
        if (c.type === 'text') return c.text && c.text.trim().length > 0
        return false
      })
      const hasToolResult = content.some((c: any) => c.type === 'tool_result')
      
      if (hasContent && !hasToolResult) {
        lastNonEmptyParticipant = msg.participant
      }
    }
    
    const prevMsg = messages.length >= 2 ? messages[messages.length - 2] : null
    const prevIsBotMessage = prevMsg && prevMsg.participant === botName
    const prevContent = prevMsg?.content || []
    const prevHasToolResult = prevContent.some((c: any) => c.type === 'tool_result')
    
    const isContinuation = !lastHasToolResult && (
      lastNonEmptyParticipant === botName ||
      (prevIsBotMessage && !prevHasToolResult)
    )
    
    return !isContinuation
  }

  private detectUnclosedXmlTag(text: string): string | null {
    const thinkingOpen = text.lastIndexOf('<thinking>')
    const thinkingClose = text.lastIndexOf('</thinking>')
    if (thinkingOpen !== -1 && thinkingOpen > thinkingClose) {
      return 'thinking'
    }
    
    const toolNames = this.toolSystem.getToolNames()
    
    for (const toolName of toolNames) {
      const openTag = `<${toolName}>`
      const closeTag = `</${toolName}>`
      
      const lastOpenIndex = text.lastIndexOf(openTag)
      const lastCloseIndex = text.lastIndexOf(closeTag)
      
      if (lastOpenIndex !== -1 && lastOpenIndex > lastCloseIndex) {
        return toolName
      }
    }
    
    return null
  }

  private async continueCompletionAfterStopSequence(
    originalRequest: any,
    partialCompletion: any,
    stopSequence: string,
    config: BotConfig,
    thinkingWasPrefilled: boolean = false,
    maxContinuations: number = 5
  ): Promise<any> {
    let accumulatedText = partialCompletion.rawAssistantText
      ?? partialCompletion.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')

    let continuationCount = 0
    let lastCompletion = partialCompletion
    
    while (continuationCount < maxContinuations) {
      accumulatedText += stopSequence
      
      const continuationRequest = { ...originalRequest }
      
      const lastMessage = continuationRequest.messages[continuationRequest.messages.length - 1]
      if (lastMessage?.participant === config.name) {
        const existingText = lastMessage.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')
        lastMessage.content = [{ type: 'text', text: existingText + accumulatedText }]
      } else {
        continuationRequest.messages.push({
          participant: config.name,
          content: [{ type: 'text', text: accumulatedText }],
        })
      }
      
      logger.debug({ 
        continuationCount: continuationCount + 1, 
        accumulatedLength: accumulatedText.length,
        stopSequence 
      }, 'Continuing completion after stop sequence')
      
      const continuation = await this.completeLLM(continuationRequest, config)
      
      const continuationText = continuation.rawAssistantText
        ?? continuation.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')

      accumulatedText += continuationText
      lastCompletion = continuation
      
      if (continuation.stopReason === 'stop_sequence') {
        let unclosedTag = this.detectUnclosedXmlTag(accumulatedText)
        if (!unclosedTag && thinkingWasPrefilled && !accumulatedText.includes('</thinking>')) {
          unclosedTag = 'thinking'
        }
        const newStopSequence = continuation.raw?.stop_sequence
        
        if (unclosedTag && newStopSequence) {
          logger.debug({ unclosedTag, newStopSequence }, 'Still mid-XML-block, continuing again')
          stopSequence = newStopSequence
          continuationCount++
          continue
        }
      }
      
      break
    }
    
    if (continuationCount >= maxContinuations) {
      logger.warn({ maxContinuations }, 'Reached max continuations for stop sequence recovery')
    }
    
    return {
      ...lastCompletion,
      content: [{ type: 'text', text: accumulatedText }],
    }
  }

  private truncateAtParticipant(
    text: string,
    messages: DiscordMessage[],
    botName: string,
    additionalStopSequences?: string[],
    config?: BotConfig
  ): { text: string; truncatedAt: string | null } {
    const botsUseDisplay = config?.use_display_names_bots ?? config?.use_display_names ?? true
    const humansUseDisplay = config?.use_display_names_humans ?? config?.use_display_names ?? false
    const participants = new Set<string>()
    for (const msg of messages) {
      const name = (msg.author?.bot ? botsUseDisplay : humansUseDisplay) ? msg.author?.displayName : msg.author?.username
      if (name && name !== botName) {
        participants.add(name)
      }
    }

    for (const participant of participants) {
      const startPattern = `${participant}:`
      if (text.startsWith(startPattern)) {
        logger.warn({ participant, responseStart: text.substring(0, 100) }, 
          'Response starts with another participant - complete hallucination, discarding')
        return { text: '', truncatedAt: `start_hallucination:${participant}` }
      }
    }

    let earliestIndex = -1
    let truncatedAt: string | null = null

    for (const participant of participants) {
      const pattern = `\n${participant}:`
      const index = text.indexOf(pattern)
      if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
        earliestIndex = index
        truncatedAt = `participant:${participant}`
      }
    }

    if (additionalStopSequences) {
      for (const stopSeq of additionalStopSequences) {
        const index = text.indexOf(stopSeq)
        if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
          earliestIndex = index
          truncatedAt = `stop:${stopSeq.replace(/\n/g, '\\n')}`
        }
      }
    }

    if (earliestIndex !== -1) {
      logger.info({ truncatedAt, position: earliestIndex, originalLength: text.length }, 'Truncated completion at stop sequence')
      return { text: text.substring(0, earliestIndex), truncatedAt }
    }

    return { text, truncatedAt: null }
  }

  private async handleGetContext(
    channelId: string,
    guildId: string,
    requestedMessages?: number,
    triggeringMessageId?: string
  ): Promise<void> {
    const pinnedConfigs = await this.connector.fetchPinnedConfigs(channelId)
    const inheritedPinnedConfigs = await this.collectPinnedConfigsWithInheritance(channelId, pinnedConfigs)
    const config = this.configSystem.loadConfig({
      botName: this.botId,
      guildId,
      channelConfigs: inheritedPinnedConfigs,
    })

    const messageCount = requestedMessages || config.recency_window_messages || 200
    const fetchDepth = messageCount + HISTORY_AND_FILTER_BUFFER

    const discordContext = await this.connector.fetchContext({
      channelId,
      depth: fetchDepth,
      maxImages: config.include_images ? Math.max((config.max_images || 5) * 2, 10) : 0,
      displayNames: displayNameClasses(config),
    })

    if (discordContext.messages.length === 0) {
      await this.connector.sendMessage(channelId, '.get_context: no messages found')
      return
    }

    const overriddenConfig = {
      ...config,
      recency_window_messages: messageCount,
      recency_window_characters: undefined,
      hard_max_characters: undefined,
    }

    const botUsername = this.connector.getBotUsername()

    const contextResult = await this.contextBuilder.buildContext({
      discordContext,
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config: overriddenConfig,
      botDiscordUsername: botUsername || undefined,
    })

    const lines: string[] = []
    lines.push(`# Context for ${config.name} in #${channelId}`)
    lines.push(`# Messages: ${contextResult.request.messages.length} (requested: ${messageCount})`)
    lines.push(`# Model: ${config.continuation_model}`)
    lines.push(`# Mode: ${config.mode || 'prefill'}`)
    lines.push(`# Stop sequences: ${JSON.stringify(contextResult.request.stop_sequences)}`)
    if (config.system_prompt) {
      lines.push(`\n# === SYSTEM PROMPT ===`)
      lines.push(config.system_prompt)
    }
    if (config.context_prefix) {
      lines.push(`\n# === CONTEXT PREFIX ===`)
      lines.push(config.context_prefix)
    }
    lines.push(`\n# === MESSAGES ===`)

    for (const msg of contextResult.request.messages) {
      const textContent = msg.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('\n')
      const imageCount = msg.content.filter(b => b.type === 'image').length
      const imageTag = imageCount > 0 ? ` [${imageCount} image${imageCount > 1 ? 's' : ''}]` : ''

      lines.push(`\n${msg.participant}:${imageTag}`)
      lines.push(textContent)
    }

    const output = lines.join('\n')

    await this.connector.sendMessageWithAttachment(
      channelId,
      `.context dump (${contextResult.request.messages.length} messages)`,
      { name: `context-${config.name}-${Date.now()}.txt`, content: output },
      triggeringMessageId
    )
  }
}
