/**
 * Agent Loop
 * Main orchestrator that coordinates all components
 */

import { EventQueue } from './event-queue.js'
import { DeferredQueue, isTransientError } from './deferred-queue.js'
import { ChannelStateManager } from './state-manager.js'
import { DiscordConnector } from '../discord/connector.js'
import { ConfigSystem } from '../config/system.js'
import { ContextBuilder, BuildContextParams } from '../context/builder.js'
import { ToolSystem } from '../tools/system.js'
import { Event, BotConfig, ContentBlock, DiscordMessage, ToolCall, ToolResult } from '../types.js'
import { logger, withActivationLogging } from '../utils/logger.js'
import { sleep } from '../utils/retry.js'
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
// Use any for Membrane type to avoid version mismatch issues between
// our local interface and the actual membrane package
type Membrane = any

/**
 * A segment of content: invisible prefix followed by visible text.
 * The last segment in a generation may also have a suffix (trailing invisible).
 */
interface ContentSegment {
  prefix: string    // invisible content before the visible text
  visible: string   // visible text (what gets sent to Discord)
  suffix?: string   // trailing invisible (only for last segment)
}

export class AgentLoop {
  private running = false
  private botUserId?: string
  private botMessageIds = new Set<string>()  // Track bot's own message IDs
  private mcpInitialized = false
  private activeChannels = new Set<string>()  // Track channels currently being processed
  private activationStore: ActivationStore
  private cacheDir: string
  private somaClient?: SomaClient  // Optional Soma credit system client
  
  // Membrane integration (optional)
  private membraneProvider?: MembraneProvider

  // TTS relay integration (optional)
  private ttsRelayClient?: TTSRelayClient

  // Deferred activation queue for transient API errors
  private deferredQueue?: DeferredQueue

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
  }

  /**
   * Set bot's Discord user ID (called after Discord connects)
   */
  setBotUserId(userId: string): void {
    this.botUserId = userId
    logger.info({ botUserId: userId }, 'Bot user ID set')
  }
  
  /**
   * Set membrane instance for LLM calls (required)
   */
  setMembrane(membrane: Membrane): void {
    this.membraneProvider = new MembraneProvider(membrane)
    logger.info({ botId: this.botId }, 'Membrane provider set')
  }

  /**
   * Set up TTS relay client for streaming text to local TTS clients.
   * Requires membrane to be enabled for streaming support.
   */
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

    // Set up interruption handler
    this.ttsRelayClient.onInterruption((event: InterruptionEvent) => {
      this.handleTTSInterruption(event)
    })

    await this.ttsRelayClient.connect()
    logger.info({ botId: this.botId, url: config.url }, 'TTS relay connected')
  }

  /**
   * Handle interruption events from TTS clients.
   * The spokenText is used to identify which message to edit - we find the recent
   * message in the channel that starts with the spoken text and truncate it.
   */
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

    // Abort the stream and record the interrupted text
    if (this.ttsStreamContext && this.ttsStreamContext.channelId === event.channelId) {
      this.ttsStreamContext.interruptedText = spokenText
      this.ttsStreamContext.abortController.abort()
      // Notify relay that activation was aborted
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

  /**
   * Disconnect TTS relay client
   */
  disconnectTTSRelay(): void {
    if (this.ttsRelayClient) {
      this.ttsRelayClient.disconnect()
      this.ttsRelayClient = undefined
      logger.info({ botId: this.botId }, 'TTS relay disconnected')
    }
  }

  /**
   * Start the agent loop
   */
  async run(): Promise<void> {
    this.running = true

    // Initialize deferred queue for handling transient API failures
    this.deferredQueue = new DeferredQueue()
    await this.deferredQueue.initialize(this.botId, (event) => this.queue.push(event))

    logger.info({ botId: this.botId }, 'Agent loop started')

    while (this.running) {
      try {
        const batch = this.queue.pollBatch()

        if (batch.length > 0) {
          logger.debug({ batchSize: batch.length, queueSize: this.queue.size() }, 'Polled batch from queue')
          await this.processBatch(batch)
        } else {
          // Avoid busy-waiting
          await sleep(100)
        }
      } catch (error) {
        logger.error({ error }, 'Error in agent loop')
        await sleep(1000)  // Back off on error
      }
    }

    logger.info('Agent loop stopped')
  }

  /**
   * Stop the agent loop
   */
  stop(): void {
    this.running = false
    this.deferredQueue?.stop()
  }

  /**
   * Parse a chunk into segments, splitting at invisible content boundaries.
   * Each segment has a prefix (preceding invisible) and visible text.
   * 
   * Example: "<thinking>A</thinking>hello<thinking>B</thinking>world"
   * Returns: [
   *   { prefix: "<thinking>A</thinking>", visible: "hello" },
   *   { prefix: "<thinking>B</thinking>", visible: "world" }
   * ]
   * 
   * If the chunk ends with invisible content, the last segment gets a suffix.
   */
  private parseIntoSegments(fullChunk: string): ContentSegment[] {
    // Find all invisible regions with their positions
    interface Region { start: number; end: number; text: string }
    const invisibleRegions: Region[] = []
    
    // Thinking blocks
    const thinkingPattern = /<thinking>[\s\S]*?<\/thinking>/g
    let match
    while ((match = thinkingPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    // Tool calls (function_calls blocks)
    const toolPattern = /<function_calls>[\s\S]*?<\/function_calls>/g
    while ((match = toolPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    // Tool results - multiple formats:
    // 1. System: <results>...</results> (legacy format)
    // 2. <function_results>...</function_results> (current format)
    const legacyResultPattern = /System:\s*<results>[\s\S]*?<\/results>/g
    while ((match = legacyResultPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    const funcResultPattern = /<function_results>[\s\S]*?<\/function_results>/g
    while ((match = funcResultPattern.exec(fullChunk)) !== null) {
      invisibleRegions.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    }
    
    // Sort by position
    invisibleRegions.sort((a, b) => a.start - b.start)
    
    // If no invisible content, return single segment with all visible
    if (invisibleRegions.length === 0) {
      const visible = fullChunk.trim()
      return visible ? [{ prefix: '', visible }] : []
    }
    
    // Build segments by walking through the chunk
    const segments: ContentSegment[] = []
    let currentPos = 0
    let currentPrefix = ''
    
    for (const region of invisibleRegions) {
      // Get visible text between currentPos and this invisible region
      const visibleBefore = fullChunk.slice(currentPos, region.start).trim()
      
      if (visibleBefore) {
        // We have visible text - create a segment
        segments.push({ prefix: currentPrefix, visible: visibleBefore })
        currentPrefix = region.text  // This invisible becomes prefix for next segment
      } else {
        // No visible text - accumulate invisible into current prefix
        currentPrefix += region.text
      }
      
      currentPos = region.end
    }
    
    // Handle remaining content after last invisible region
    const remainingVisible = fullChunk.slice(currentPos).trim()
    
    if (remainingVisible) {
      // There's visible text after the last invisible
      segments.push({ prefix: currentPrefix, visible: remainingVisible })
    } else if (currentPrefix && segments.length > 0) {
      // Trailing invisible with no visible after - becomes suffix of last segment
      segments[segments.length - 1]!.suffix = currentPrefix
    } else if (currentPrefix) {
      // Only invisible content, no visible at all - phantom segment
      // Return empty array (caller handles phantoms separately)
    }
    
    return segments
  }
  
  /**
   * Extract ALL invisible content from a chunk, preserving order.
   * This is a compatibility helper - prefer parseIntoSegments for proper segment-based sending.
   */
  private extractAllInvisible(fullChunk: string): string {
    const segments = this.parseIntoSegments(fullChunk)
    
    // Collect all prefixes and the suffix
    let allInvisible = ''
    for (const seg of segments) {
      allInvisible += seg.prefix
    }
    // Add suffix from last segment if present
    if (segments.length > 0 && segments[segments.length - 1]!.suffix) {
      allInvisible += segments[segments.length - 1]!.suffix
    }
    
    return allInvisible
  }
  
  /**
   * Truncate segments at a given position in the combined visible text.
   * Returns segments up to (and including partial) that position.
   */
  private truncateSegmentsAtPosition(segments: ContentSegment[], position: number): ContentSegment[] {
    const result: ContentSegment[] = []
    let accumulatedLength = 0
    
    for (const segment of segments) {
      const segmentEnd = accumulatedLength + segment.visible.length
      
      if (segmentEnd <= position) {
        // This segment is fully within the truncation point
        result.push(segment)
        accumulatedLength = segmentEnd
      } else if (accumulatedLength < position) {
        // This segment spans the truncation point - truncate it
        const keepLength = position - accumulatedLength
        result.push({
          prefix: segment.prefix,
          visible: segment.visible.slice(0, keepLength).trim(),
          // Don't keep suffix - we're truncating
        })
        break
      } else {
        // We've passed the truncation point
        break
      }
    }
    
    return result
  }
  
  /**
   * Send segments to Discord, preserving invisible content associations.
   * Each segment's visible text is sent as a Discord message (may be chunked if >2000 chars).
   * Returns all sent message IDs and their context (prefix/suffix).
   * 
   * For segments with no visible text (phantom), the invisible content is stored
   * as suffix of the previous message, or returned as orphanedInvisible if no messages sent.
   */
  private async sendSegments(
    channelId: string,
    segments: ContentSegment[],
    replyToMessageId?: string
  ): Promise<{
    sentMessageIds: string[]
    messageContexts: Record<string, MessageContext>
    orphanedInvisible: string  // Invisible content with no message to attach to
  }> {
    const sentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    let orphanedInvisible = ''
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!
      
      // Send this segment's visible text
      const msgIds = await this.connector.sendMessage(
        channelId,
        segment.visible,
        i === 0 ? replyToMessageId : undefined  // Only reply on first segment
      )
      
      // Track message IDs
      sentMessageIds.push(...msgIds)
      msgIds.forEach(id => this.botMessageIds.add(id))
      
      if (msgIds.length > 0) {
        // First message of this segment gets the prefix
        const firstMsgId = msgIds[0]!
        messageContexts[firstMsgId] = { prefix: segment.prefix }
        
        // Middle messages get empty context
        for (let j = 1; j < msgIds.length - 1; j++) {
          messageContexts[msgIds[j]!] = { prefix: '' }
        }
        
        // Last message (if different from first) - will get suffix if present
        const lastMsgId = msgIds[msgIds.length - 1]!
        if (lastMsgId !== firstMsgId) {
          messageContexts[lastMsgId] = { prefix: '' }
        }
        
        // If this segment has a suffix, add it to the last message
        if (segment.suffix) {
          const existing = messageContexts[lastMsgId]
          messageContexts[lastMsgId] = { 
            prefix: existing?.prefix ?? '',
            suffix: segment.suffix 
          }
        }
      }
    }
    
    // If we have orphaned invisible (from phantom segments at the start), track it
    // This shouldn't happen often, but handle it for completeness
    if (segments.length === 0) {
      // Caller should handle this case - no visible content at all
    }
    
    return { sentMessageIds, messageContexts, orphanedInvisible }
  }

  private async processBatch(events: Event[]): Promise<void> {
    const batchStart = Date.now()
    logger.debug({ count: events.length, types: events.map((e) => e.type) }, 'Processing batch')

    // Get first event to access channel for config (for random check)
    const firstEvent = events[0]
    if (!firstEvent) return

    // Profile: time from Discord event receipt to batch processing
    const eventReceivedAt = (firstEvent as any).receivedAt
    if (eventReceivedAt) {
      logger.debug({ eventAgeMs: batchStart - eventReceivedAt }, 'Event age (discord.js + queue poll)')
    }
    
    // Handle delete events - remove tool cache entries for deleted bot messages
    for (const event of events) {
      if (event.type === 'delete') {
        const message = event.data as any
        // Check if this is one of our bot messages
        if (message.author?.id === this.botUserId) {
          await this.toolSystem.removeEntriesByBotMessageId(
            this.botId,
            event.channelId,
            message.id
          )
        }
      }
    }

    // Check if activation is needed
    const shouldActivateStart = Date.now()
    if (!await this.shouldActivate(events, firstEvent.channelId, firstEvent.guildId)) {
      logger.debug('No activation needed')
      return
    }
    logger.debug({ durationMs: Date.now() - shouldActivateStart }, 'shouldActivate completed')

    const { channelId, guildId } = firstEvent

    // Get triggering message ID for tool tracking (prefer non-system messages)
    const triggeringEvent = this.findTriggeringMessageEvent(events)
    const triggeringMessageId = triggeringEvent?.data?.id

    // Check for m command and delete it
    const mCommandEvent = events.find((e) => e.type === 'message' && (e.data as any)._isMCommand)
    if (mCommandEvent) {
      const message = mCommandEvent.data as any
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

    // Cancel any pending deferred activation - new activity supersedes it
    if (this.deferredQueue?.hasPendingActivation(channelId)) {
      this.deferredQueue.cancelActivation(channelId)
      logger.debug({ channelId }, 'Cancelled pending deferred activation due to new activity')
    }

    // Check if this channel is already being processed
    if (this.activeChannels.has(channelId)) {
      logger.debug({ channelId }, 'Channel already being processed, skipping')
      return
    }

    // Mark channel as active and process asynchronously (don't await)
    this.activeChannels.add(channelId)
    
    // Determine activation reason for tracing
    const activationReason = this.determineActivationReason(events)
    
    // ===== SOMA CREDIT CHECK =====
    // Check if user has sufficient ichor before proceeding with activation
    // Only charge for human-initiated triggers (mention, reply, m_command) - not random
    const somaStart = Date.now()
    const somaCheckResult = await this.checkSomaCredits(
      events,
      channelId,
      guildId,
      activationReason.reason,
      triggeringMessageId
    )
    logger.debug({ durationMs: Date.now() - somaStart }, 'Soma credit check completed')

    if (somaCheckResult.status === 'blocked') {
      // User doesn't have enough ichor - message already sent
      this.activeChannels.delete(channelId)
      return
    }

    // Store transaction ID for potential refund if activation fails
    const somaTransactionId = somaCheckResult.transactionId
    // ===== END SOMA CHECK =====

    logger.debug({ durationMs: Date.now() - batchStart }, 'processBatch overhead (event→handleActivation)')

    // Wrap activation in both logging and trace context
    const activationPromise = triggeringMessageId
      ? withActivationLogging(channelId, triggeringMessageId, async () => {
          // Get channel metadata for trace indexing
          const channelMeta = await this.connector.getChannelMeta(channelId)
          const channelName = channelMeta.name

          // Run with trace context
          const { trace, error: traceError } = await withTrace(
            channelId,
            triggeringMessageId,
            this.botId,
            async (traceCollector) => {
              // Record activation info
              traceCollector.setGuildId(guildId)
              if (this.botUserId) {
                traceCollector.setBotUserId(this.botUserId)
              }
              traceCollector.setThreadInfo(channelMeta.isThread, channelMeta.parentChannelId)
              traceCollector.recordActivation({
                reason: activationReason.reason,
                triggerEvents: activationReason.events,
              })
              
              return this.handleActivation(channelId, guildId, triggeringMessageId, traceCollector)
            },
            channelName
          )
          
          // Write trace to disk (even if activation failed - we want to see what happened)
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
          
          // If there was an error and we charged the user, refund them
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
          
          // Re-throw the original error if there was one
          if (traceError) {
            throw traceError
          }
        })
      : this.handleActivation(channelId, guildId, triggeringMessageId)
    
    activationPromise
      .catch((error) => {
        // Only log essential error info to avoid massive JSON dumps from MembraneError
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
        this.activeChannels.delete(channelId)
      })
  }
  
  private determineActivationReason(events: Event[]): {
    reason: 'mention' | 'reply' | 'random' | 'm_command' | 'timer',
    events: Array<{ type: string; messageId?: string; authorId?: string; authorName?: string; contentPreview?: string }>
  } {
    const triggerEvents: Array<{ type: string; messageId?: string; authorId?: string; authorName?: string; contentPreview?: string }> = []
    let reason: 'mention' | 'reply' | 'random' | 'm_command' | 'timer' = 'mention'

    for (const event of events) {
      if (event.type === 'self_activation') {
        // Timer-triggered activation
        reason = 'timer'
        triggerEvents.push({
          type: 'timer',
          messageId: event.data?.originalMessageId,
          contentPreview: event.data?.contextNote?.slice(0, 100),
        })
      } else if (event.type === 'message') {
        const message = event.data as any
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

  /**
   * Check Soma credits if enabled
   * Returns status and transaction ID (for refunds if activation fails)
   * 
   * Design decisions:
   * - Fails open: API errors allow activation (prevents Soma outages from blocking bots)
   * - Only charges for direct triggers (mention, reply, m_command) - not random activations
   * - Soma is optional: if not configured, always allows
   * - Returns transactionId so we can refund if LLM inference fails
   */
  private async checkSomaCredits(
    events: Event[],
    channelId: string,
    guildId: string,
    triggerReason: 'mention' | 'reply' | 'random' | 'm_command' | 'timer',
    triggeringMessageId?: string
  ): Promise<{ status: 'allowed' | 'blocked'; transactionId?: string }> {
    // Load config to check if Soma is enabled
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

    // Check if Soma is enabled
    if (!config.soma?.enabled || !config.soma?.url) {
      return { status: 'allowed' }
    }

    // Random activations are free
    if (!shouldChargeTrigger(triggerReason)) {
      logger.debug({ triggerReason }, 'Soma: trigger type is free')
      return { status: 'allowed' }
    }

    // Initialize Soma client if needed
    if (!this.somaClient) {
      this.somaClient = new SomaClient(config.soma)
      logger.info({ url: config.soma.url }, 'Soma client initialized')
    }

    // Find the triggering user
    const triggeringUser = this.findTriggeringUser(events)
    if (!triggeringUser) {
      logger.warn('Could not identify triggering user for Soma check - allowing activation')
      return { status: 'allowed' }
    }

    // Call Soma API (include channelId so Soma bot can add reactions)
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

    // Bot not configured in Soma - ChapterX adds ⚙️ reaction
    // (Soma can't handle this since the bot isn't registered)
    if (result.reason === 'bot_not_configured') {
      logger.warn({
        botId: this.botUserId,
        serverId: guildId,
        triggerType: triggerReason,
      }, 'Soma: bot not configured, activation blocked')

      // Add gear reaction to indicate configuration needed
      if (triggeringMessageId) {
        try {
          await this.connector.addReaction(channelId, triggeringMessageId, '⚙️')
        } catch (error) {
          logger.warn({ error }, 'Failed to add bot-not-configured reaction')
        }
      }

      return { status: 'blocked' }
    }

    // Insufficient funds - Soma bot handles 💸 reaction and DM notification
    // ChapterX just silently blocks activation
    logger.info({
      userId: triggeringUser.id,
      cost: result.cost,
      currentBalance: result.currentBalance,
      timeToAfford: result.timeToAfford,
      triggerType: triggerReason,
    }, 'Soma: insufficient ichor, activation blocked')

    return { status: 'blocked' }
  }

  /**
   * Find the user who triggered the activation
   */
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

  private async replaceMentions(text: string, messages: any[]): Promise<string> {
    // Build username -> user ID mapping from recent messages
    // Use actual username (not displayName) for chapter2 compatibility
    const userMap = new Map<string, string>()
    
    for (const msg of messages) {
      if (msg.author && !msg.author.bot) {
        userMap.set(msg.author.username, msg.author.id)
      }
    }
    
    // Replace <@username> with <@USER_ID>
    let result = text
    for (const [name, userId] of userMap.entries()) {
      const pattern = new RegExp(`<@${name}>`, 'gi')
      result = result.replace(pattern, `<@${userId}>`)
    }
    
    return result
  }

  /**
   * Determine the trigger type based on context
   * For now, we use 'mention' as default since most activations come from mentions
   */
  private determineTriggerType(triggeringMessageId?: string): TriggerType {
    // TODO: Could be enhanced to detect reply vs mention vs random
    // For now, use 'mention' as the default
    if (!triggeringMessageId) {
      return 'random'
    }
    return 'mention'
  }

  private findTriggeringMessageEvent(events: Event[]): (Event & { data: any }) | undefined {
    return events.find((event) => event.type === 'message' && !this.isSystemDiscordMessage(event.data))
      || events.find((event) => event.type === 'message')
  }

  private isSystemDiscordMessage(message: any): boolean {
    // NOTE: Keep this conservative for now. We previously tried to infer
    // system-ness from Discord's type codes, but that misclassified
    // legitimate replies. If we see regressions, revisit the more
    // elaborate version that inspects message.type for non-0/19 values.
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

  /**
   * Strip thinking blocks from text, respecting backtick escaping
   * e.g., "<thinking>foo</thinking>" -> ""
   * e.g., "`<thinking>foo</thinking>`" -> "`<thinking>foo</thinking>`" (preserved)
   */
  private stripThinkingBlocks(text: string): { stripped: string; content: string[] } {
    const content: string[] = []
    
    // Match thinking blocks that are NOT inside backticks
    // Strategy: find all thinking blocks, check if they're escaped
    const pattern = /<thinking>([\s\S]*?)<\/thinking>/g
    let result = text
    let match
    
    // Collect matches first to avoid mutation during iteration
    const matches: Array<{ full: string; content: string; index: number }> = []
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ full: match[0], content: match[1] || '', index: match.index })
    }
    
    // Process in reverse order to preserve indices
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]!
      const before = text.slice(0, m.index)
      const after = text.slice(m.index + m.full.length)
      
      // Check if it's inside backticks (single or triple)
      const isEscaped = (
        (before.endsWith('`') && after.startsWith('`')) ||
        (before.endsWith('```') || before.match(/```[^\n]*\n[^`]*$/)) // Inside code block
      )
      
      if (!isEscaped) {
        content.unshift(m.content.trim())
        result = result.slice(0, m.index) + result.slice(m.index + m.full.length)
      }
    }
    
    return { stripped: result, content }
  }

  private async shouldActivate(events: Event[], channelId: string, guildId: string): Promise<boolean> {
    // Check for self_activation events first (timer-triggered)
    for (const event of events) {
      if (event.type === 'self_activation') {
        logger.info({
          channelId,
          timerId: event.data?.timerId,
          contextNote: event.data?.contextNote?.slice(0, 50),
        }, 'Activated by timer (self_activation)')
        return true
      }
    }

    // Load config early for API-only mode check
    let config: any = null
    try {
      config = this.configSystem.loadConfig({
        botName: this.botId,
        guildId,
        channelConfigs: [],  // No channel configs needed for this check
      })
    } catch {
      // Config will be loaded again below if needed
    }

    // Check if API-only mode is enabled
    if (config?.api_only) {
      logger.debug('API-only mode enabled - skipping activation')
      return false
    }

    // Check each message event for activation triggers
    for (const event of events) {
      if (event.type !== 'message') {
        continue
      }

      const message = event.data as any

      // Skip Discord system messages (e.g., thread starter notifications)
      if (this.isSystemDiscordMessage(message)) {
        continue
      }

      // Skip bot's own messages
      if (message.author?.id === this.botUserId) {
        continue
      }

      // 1. Check for m command FIRST (before mention check)
      // This ensures "m continue <@bot>" gets flagged for deletion
      // Only trigger/delete if addressed to THIS bot (mention or reply)
      const content = message.content?.trim()
      if (content?.startsWith('m ')) {
        const mentionsUs = this.botUserId && message.mentions?.has(this.botUserId)
        const repliesTo = message.reference?.messageId && this.botMessageIds.has(message.reference.messageId)
        
        if (mentionsUs || repliesTo) {
          logger.debug({ messageId: message.id, command: content, mentionsUs, repliesTo }, 'Activated by m command addressed to us')
          // Store m command event for deletion (only if addressed to us)
          event.data._isMCommand = true
          return true
        }
        // m command not addressed to us - ignore
        logger.debug({ messageId: message.id, command: content }, 'm command not addressed to us - ignoring')
        return false
      }

      // 2. Check for bot mention
      if (this.botUserId && message.mentions?.has(this.botUserId)) {
        // Check bot reply chain depth to prevent bot loops
        const chainDepth = await this.connector.getBotReplyChainDepth(channelId, message)
        
        // Load config if not already loaded
        if (!config) {
          try {
            const configFetch = await this.connector.fetchContext({ channelId, depth: 10, maxImages: 0 })
            const inheritedPinnedConfigs = await this.collectPinnedConfigsWithInheritance(
              channelId,
              configFetch.pinnedConfigs
            )
            config = this.configSystem.loadConfig({
              botName: this.botId,
              guildId,
              channelConfigs: inheritedPinnedConfigs,
            })
          } catch (error) {
            logger.warn({ error }, 'Failed to load config for chain depth check')
            return false
          }
        }
        
        if (chainDepth >= config.max_bot_reply_chain_depth) {
          logger.info({ 
            messageId: message.id, 
            chainDepth, 
            limit: config.max_bot_reply_chain_depth 
          }, 'Bot reply chain depth limit reached, blocking activation')
          
          // Add reaction to indicate chain depth limit reached
          await this.connector.addReaction(channelId, message.id, config.bot_reply_chain_depth_emote)
          continue  // Check next event instead of returning false (might be random activation)
        }
        
        logger.debug({ messageId: message.id, chainDepth }, 'Activated by mention')
        return true
      }

      // 3. Check for reply to bot's message (but ignore replies from other bots without mention)
      if (message.reference?.messageId && this.botMessageIds.has(message.reference.messageId)) {
        // If the replying user is a bot, only activate if they explicitly mentioned us
        if (message.author?.bot) {
          logger.debug({ messageId: message.id, author: message.author?.username }, 'Ignoring bot reply without mention')
          continue
        }
        logger.debug({ messageId: message.id }, 'Activated by reply')
        return true
      }

      // 4. Random chance activation
      if (!config) {
        // Load config once for this batch
        try {
          const configFetch = await this.connector.fetchContext({ channelId, depth: 10, maxImages: 0 })
          const inheritedPinnedConfigs = await this.collectPinnedConfigsWithInheritance(
            channelId,
            configFetch.pinnedConfigs
          )
          config = this.configSystem.loadConfig({
            botName: this.botId,
            guildId,
            channelConfigs: inheritedPinnedConfigs,
          })
        } catch (error) {
          logger.warn({ error }, 'Failed to load config for random check')
          return false
        }
      }
      
      if (config.reply_on_random > 0) {
        const chance = Math.random()
        if (chance < 1 / config.reply_on_random) {
          logger.debug({ messageId: message.id, chance, threshold: 1 / config.reply_on_random }, 'Activated by random chance')
          return true
        }
      }
    }

    return false
  }

  private async handleActivation(
    channelId: string, 
    guildId: string, 
    triggeringMessageId?: string,
    trace?: TraceCollector
  ): Promise<void> {
    logger.info({ botId: this.botId, channelId, guildId, triggeringMessageId, traceId: trace?.getTraceId() }, 'Bot activated')

    // Profiling helper
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
    // Start typing indicator (fire-and-forget, don't block on Discord API)
    this.connector.startTyping(channelId).catch(() => {})
    endProfile('typing')

    try {
      startProfile('toolCacheLoad')
      // 1. Get or initialize channel state first (for message count)
      const toolCacheWithResults = await this.toolSystem.loadCacheWithResults(this.botId, channelId)
      const toolCache = toolCacheWithResults.map(e => e.call)
      endProfile('toolCacheLoad')
      
      startProfile('stateInit')
      const state = await this.stateManager.getOrInitialize(this.botId, channelId, toolCache)
      endProfile('stateInit')

      // 2. Calculate fetch depth from config (fetch pinned configs first - fast single API call)
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
      
      // Use config values: recency_window + rolling_threshold + buffer for .history commands
      const recencyWindow = preConfig.recency_window_messages || 200
      const rollingBuffer = preConfig.rolling_threshold || 50
      let fetchDepth = recencyWindow + rollingBuffer + 50  // +50 for .history boundary tolerance
      
      logger.debug({ 
        recencyWindow, 
        rollingBuffer, 
        fetchDepth,
        configSource: 'pinned + bot yaml'
      }, 'Calculated fetch depth from config')
      
      const promptCachingEnabled = preConfig.prompt_caching !== false
      
      startProfile('fetchContext')
      // 3. Fetch context with calculated depth (messages + images), reusing pinned configs
      // Cap image fetching to prevent RAM bloat in image-heavy channels
      // Use 2x max_images to give context builder selection room while preventing worst-case loading
      const maxImagesFetch = Math.max((preConfig.max_images || 5) * 2, 10)
      const discordContext = await this.connector.fetchContext({
        channelId,
        depth: fetchDepth,
        // Anchor the start of the fetched window for prompt cache stability (if enabled).
        // This prevents the oldest message from sliding forward as new messages arrive,
        // which would otherwise invalidate the cached prompt prefix on every activation.
        firstMessageId: promptCachingEnabled ? (state.cacheOldestMessageId || undefined) : undefined,
        authorized_roles: [],  // Will apply after loading config
        pinnedConfigs,  // Reuse pre-fetched pinned configs (avoids second API call)
        maxImages: maxImagesFetch,  // Prevents loading all images from image-heavy channels
      })
      endProfile('fetchContext')

      // Cache stability: maintain a consistent starting point for prompt caching
      // Skip if prompt caching is disabled
      if (promptCachingEnabled) {
        const cacheOldestId = state.cacheOldestMessageId
        const fetchedOldestId = discordContext.messages[0]?.id

        // If .history clear was used, reset cache marker to the new oldest message
        // This prevents the next activation from extending backwards past the clear boundary
        if (discordContext.inheritanceInfo?.historyDidClear && fetchedOldestId) {
          logger.debug({
            oldCacheMarker: cacheOldestId,
            newCacheMarker: fetchedOldestId,
          }, 'Resetting cache marker after .history clear')
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
        } else if (!cacheOldestId && fetchedOldestId) {
          // First activation - set cache marker to oldest fetched message
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
          logger.debug({ channelId, oldestMessageId: fetchedOldestId }, 'Initialized cached starting point for cache stability')
        } else if (cacheOldestId && fetchedOldestId) {
          const cacheIdx = discordContext.messages.findIndex(m => m.id === cacheOldestId)
          const historyWasUsed = !!discordContext.inheritanceInfo?.historyOriginChannelId
          
          if (cacheIdx > 0 && historyWasUsed) {
            // .history command brought in older context - expand cache marker to include it
            // This is expected behavior: .history intentionally loads historical messages
            logger.debug({
              oldCacheMarker: cacheOldestId,
              newCacheMarker: fetchedOldestId,
              olderMessagesIncluded: cacheIdx,
              historyOrigin: discordContext.inheritanceInfo?.historyOriginChannelId,
            }, 'Expanding cache marker to include .history context')
            this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
          } else if (cacheIdx > 0) {
            // No .history used, but fetch overshot - trim older messages for cache stability
            // This is overshoot from connector's batch fetching, not intentional context expansion
            logger.debug({
              cacheMarker: cacheOldestId,
              fetchedOldest: fetchedOldestId,
              trimmingCount: cacheIdx,
              totalBefore: discordContext.messages.length,
            }, 'Trimming fetch overshoot to maintain cache stability')
            discordContext.messages = discordContext.messages.slice(cacheIdx)
          } else if (cacheIdx === -1) {
            // Cached oldest message no longer in fetch - cache stability is broken
            logger.warn({
              cacheOldestId,
              fetchedMessages: discordContext.messages.length,
            }, 'Cached oldest message not found in fetch - resetting cached starting point')
            this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
          }
          // If cacheIdx === 0, the cache marker is at the start - perfect, no action needed
        }
      } else {
        logger.debug({ channelId }, 'Prompt caching disabled - skipping cache marker logic')
      }
      
      // Record raw Discord messages to trace (before any transformation)
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
      // 4. Load configuration from the fetched pinned messages
      const config = this.configSystem.loadConfig({
        botName: this.botId,
        guildId: discordContext.guildId,
        channelConfigs: inheritedPinnedConfigs,
      })
      endProfile('configLoad')
      
      // Record config in trace (for debugging)
      traceSetConfig(config)

      // Send TTS activation start as early as possible (for thinking animation/sound)
      // This happens right after config load so Melodeus can show thinking indicator quickly
      if (config.tts_relay?.enabled && this.ttsRelayClient?.isConnected() && this.botUserId) {
        const botDiscordUsername = this.connector.getBotUsername() || config.name
        this.ttsRelayClient.sendActivationStart({
          channelId,
          userId: this.botUserId,
          username: botDiscordUsername,
        })
      }

      // Initialize MCP servers from config (once per bot)
      if (!this.mcpInitialized && config.mcp_servers && config.mcp_servers.length > 0) {
        startProfile('mcpInit')
        logger.info({ serverCount: config.mcp_servers.length }, 'Initializing MCP servers from config')
        await this.toolSystem.initializeServers(config.mcp_servers)
        this.mcpInitialized = true
        
        // Set up MCP resource accessor for the mcp-resources plugin
        setResourceAccessor({
          getMcpResources: () => this.toolSystem.getMcpResources(),
          readMcpResource: (uri) => this.toolSystem.readMcpResource(uri),
        })
        
        endProfile('mcpInit')
      }
      
      startProfile('pluginSetup')
      // Load tool plugins from config
      if (config.tool_plugins && config.tool_plugins.length > 0) {
        this.toolSystem.loadPlugins(config.tool_plugins)
      }
      
      // Build initial visible images from Discord context (newest first)
      // These will be augmented with MCP tool result images during execution
      const initialVisibleImages = discordContext.images.map((img, i) => ({
        index: i + 1,
        source: 'discord' as const,
        sourceDetail: 'channel',
        data: img.data.toString('base64'),
        mimeType: img.mediaType,
        description: img.url ? `cached from ${img.url.split('/').pop()?.slice(0, 20)}` : undefined,
      }))
      
      // Set plugin context for this activation
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
        uploadFile: async (buffer: Buffer, filename: string, contentType: string, caption?: string) => {
          return await this.connector.sendFileAttachment(channelId, buffer, filename, contentType, caption)
        },
        visibleImages: initialVisibleImages,
      })
      endProfile('pluginSetup')

      // Filter out "m " command messages from context (they should be deleted but might still be fetched)
      const originalCount = discordContext.messages.length
      discordContext.messages = discordContext.messages.filter(msg => {
        // Replies are encoded as "<reply:@user> ..." in fetched context.
        // Strip that prefix before checking for m-commands so reply-based
        // commands like "<reply:@Bot> m continue" don't leak into the LLM context.
        const contentWithoutReply = msg.content?.trim().replace(/^<reply:@[^>]+>\s*/, '') || ''
        return !/^m\s+/i.test(contentWithoutReply)
      })
      
      if (discordContext.messages.length < originalCount) {
        logger.debug({ 
          filtered: originalCount - discordContext.messages.length,
          remaining: discordContext.messages.length
        }, 'Filtered m commands from context')
      }

      // 4. Prune tool cache to remove tools older than oldest message
      if (discordContext.messages.length > 0) {
        const oldestMessageId = discordContext.messages[0]!.id
        this.stateManager.pruneToolCache(this.botId, channelId, oldestMessageId)
      }
      
      // 4b. Re-load tool cache filtering by existing Discord messages
      // (removes entries where bot messages were deleted)
      startProfile('toolCacheReload')
      const existingMessageIds = new Set(discordContext.messages.map(m => m.id))
      const filteredToolCache = await this.toolSystem.loadCacheWithResults(
        this.botId, 
        channelId, 
        existingMessageIds
      )
      const toolCacheForContext = filteredToolCache
      endProfile('toolCacheReload')
      
      // 4b2. Extract cached MCP images and add to visible images
      // These are images from previous tool executions that were persisted
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
        // Build visible images: cached MCP images first (newest), then discord images
        const mcpVisibleImages = cachedMcpImages.flatMap(({ toolName, images }) =>
          images.map((img, i) => ({
            index: 0, // Will be re-indexed below
            source: 'mcp_tool' as const,
            sourceDetail: toolName,
            data: img.data,
            mimeType: img.mimeType,
            description: `cached result ${i + 1} from ${toolName}`,
          }))
        )
        
        // Get existing discord images from context
        const existingContext = this.toolSystem.getPluginContext()
        const discordImages = (existingContext?.visibleImages || [])
          .filter(img => img.source === 'discord')
        
        // Combine and re-index (MCP first as they're tool results, then discord)
        const allVisibleImages = [...mcpVisibleImages, ...discordImages]
          .map((img, i) => ({ ...img, index: i + 1 }))
        
        this.toolSystem.setPluginContext({ visibleImages: allVisibleImages })
        logger.debug({ 
          cachedMcpImageCount: mcpVisibleImages.length,
          discordImageCount: discordImages.length 
        }, 'Updated visible images with cached MCP results')
      }
      
      // 4c. Filter out Discord messages that are in tool cache's botMessageIds
      // ONLY when preserve_thinking_context is DISABLED
      // When enabled, the activation store handles full completions and needs the original messages
      if (!config.preserve_thinking_context) {
        const toolCacheBotMessageIds = new Set<string>()
        for (const entry of toolCacheForContext) {
          if (entry.call.botMessageIds) {
            entry.call.botMessageIds.forEach(id => toolCacheBotMessageIds.add(id))
          }
        }
        
        if (toolCacheBotMessageIds.size > 0) {
          const beforeFilter = discordContext.messages.length
          discordContext.messages = discordContext.messages.filter(msg => 
            !toolCacheBotMessageIds.has(msg.id)
          )
          if (discordContext.messages.length < beforeFilter) {
            logger.debug({ 
              filtered: beforeFilter - discordContext.messages.length,
              remaining: discordContext.messages.length
            }, 'Filtered Discord messages covered by tool cache')
          }
        }
      } else {
        logger.debug('Skipping tool cache message filter (preserve_thinking_context enabled)')
      }

      // 4d. Load activations for preserve_thinking_context
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

      // 4e. Gather plugin context injections
      startProfile('pluginInjections')
      let pluginInjections: ContextInjection[] = []
      const loadedPlugins = this.toolSystem.getLoadedPluginObjects()
      if (loadedPlugins.size > 0) {
        // Create plugin context factory with message IDs
        const messageIds = discordContext.messages.map(m => m.id)
        const pluginContextFactory = new PluginContextFactory({
          cacheDir: this.cacheDir,
          messageIds,
        })
        
        // Create base context for plugins
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
          uploadFile: async (buffer: Buffer, filename: string, contentType: string, caption?: string) => {
            return await this.connector.sendFileAttachment(channelId, buffer, filename, contentType, caption)
          },
        }
        
        // Get injections from all plugins that support it
        for (const [pluginName, plugin] of loadedPlugins) {
          if (plugin.getContextInjections) {
            try {
              // Get plugin-specific config
              const pluginInstanceConfig = config.plugin_config?.[pluginName]
              
              // Skip disabled plugins (state_scope: 'off')
              if (pluginInstanceConfig?.state_scope === 'off') {
                logger.debug({ pluginName }, 'Skipping disabled plugin (state_scope: off)')
                continue
              }
              
              const stateContext = pluginContextFactory.createStateContext(
                pluginName,
                basePluginContext,
                discordContext.inheritanceInfo,  // Pass inheritance info for state lookup
                undefined,  // epicReducer
                pluginInstanceConfig  // Pass plugin config
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
        
        // Set plugin context factory for tool execution hooks (each plugin gets its own context)
        this.toolSystem.setPluginContextFactory(pluginContextFactory, config.plugin_config)
      }
      endProfile('pluginInjections')

      // 5. Build LLM context
      startProfile('contextBuild')
      const buildParams: BuildContextParams = {
        discordContext,
        toolCacheWithResults: toolCacheForContext,  // Use filtered version (excludes deleted bot messages)
        lastCacheMarker: state.lastCacheMarker,
        messagesSinceRoll: state.messagesSinceRoll,
        config,
        botDiscordUsername: this.connector.getBotUsername(),  // Bot's actual Discord username for chat mode
        activations: activationsForContext,
        pluginInjections,
      }

      const contextResult = await this.contextBuilder.buildContext(buildParams)

      // Add tools if enabled
      if (config.tools_enabled) {
        const availableTools = this.toolSystem.getAvailableTools()
        contextResult.request.tools = availableTools
        logger.info({ 
          toolCount: availableTools.length,
          toolNames: availableTools.map(t => t.name),
          serverNames: [...new Set(availableTools.map(t => t.serverName))]
        }, 'Tools being sent to LLM')
      }
      endProfile('contextBuild')

      // 5.5. Start activation recording if preserve_thinking_context is enabled
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

      // Log profiling BEFORE LLM call to see pre-LLM timings
      const preLlmTime = Date.now() - profileStart
      logger.info({ 
        ...timings, 
        totalPreLLM: preLlmTime,
        messagesFetched: discordContext.messages.length,
        imagesFetched: discordContext.images.length,
      }, '⏱️  PROFILING: Pre-LLM phase timings (ms)')

      // 6. Call LLM (with tool execution)
      startProfile('llmCall')

      // Route to native tool execution for non-Claude models
      const hasTools = config.tools_enabled && (contextResult.request.tools?.length ?? 0) > 0
      const toolMode = resolveToolModeForModel(config.continuation_model)

      let executionResult: {
        completion: any;
        toolCallIds: string[];
        preambleMessageIds: string[];
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
          discordContext.messages  // For post-hoc participant truncation
        )
      }

      const {
        completion,
        toolCallIds,
        preambleMessageIds,
        fullCompletionText,
        sentMessageIds: inlineSentMessageIds,
        messageContexts: inlineMessageContexts
      } = executionResult
      endProfile('llmCall')

      // 7. Stop typing
      await this.connector.stopTyping(channelId)

      // 7.5. Check for refusal
      const wasRefused = completion.stopReason === 'refusal'
      if (wasRefused) {
        logger.warn({ stopReason: completion.stopReason }, 'LLM refused to complete request')
      }

      // 7.6. Check for image content blocks (from image generation models)
      const imageBlocks = completion.content.filter((c: any) => c.type === 'image')
      if (imageBlocks.length > 0) {
        logger.info({ imageCount: imageBlocks.length }, 'Completion contains generated images')

        // Send each image as a Discord attachment
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
                undefined,  // No caption
                triggeringMessageId
              )
              imageSentIds.push(...msgIds)
              logger.debug({ messageId: msgIds[0], mediaType }, 'Sent generated image to Discord')
            }
          } catch (err) {
            logger.error({ err }, 'Failed to send generated image to Discord')
          }
        }

        // Combine text message IDs (already sent by inline execution) with image IDs
        const allMessageIds = [...(inlineSentMessageIds ?? []), ...imageSentIds]
        const responseText = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')

        // Record activation if enabled
        if (activation) {
          this.activationStore.addCompletion(
            activation.id,
            responseText || '[Generated image]',
            allMessageIds,
            [],
            []
          )
          await this.activationStore.completeActivation(activation.id)
        }

        // Update state and trace for image response
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

        return  // Done - image response handled
      }

      // 8. Collect sent message IDs and handle reactions
      // Inline execution (executeWithInlineTools) already sent messages progressively.
      // For phantoms (all thinking, no visible text), sentMessageIds will be empty -
      // that's fine, the invisible content is stored via addCompletion and injected later.
      const sentMessageIds = inlineSentMessageIds ?? []
      
      // Extract response text for tracing (display text without thinking/tools)
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

      // Handle refusal reactions
      if (wasRefused) {
        if (sentMessageIds.length > 0) {
          for (const msgId of sentMessageIds) {
            await this.connector.addReaction(channelId, msgId, '🛑')
          }
          logger.info({ sentMessageIds }, 'Added refusal reaction to sent messages')
        } else if (triggeringMessageId) {
          // Phantom refusal - react to triggering message
          await this.connector.addReaction(channelId, triggeringMessageId, '🛑')
          logger.info({ triggeringMessageId }, 'Added refusal reaction to triggering message (phantom)')
        }
      }
      
      // Record final completion to activation
      if (activation) {
        // Get the full completion text (with thinking and tool calls, before stripping)
        // For inline tool execution, use the preserved fullCompletionText which includes tool calls/results
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
        
        // Set per-message context chunks if inline execution provided them
        if (inlineMessageContexts) {
          for (const [msgId, contextChunk] of Object.entries(inlineMessageContexts)) {
            this.activationStore.setMessageContext(activation.id, msgId, contextChunk)
          }
        }
        
        // Complete and persist the activation
        await this.activationStore.completeActivation(activation.id)
      }
      
      // Update tool cache entries with bot message IDs (for existence checking on reload)
      // Include both preamble message IDs and final response message IDs
      const allBotMessageIds = [...preambleMessageIds, ...sentMessageIds]
      if (toolCallIds.length > 0 && allBotMessageIds.length > 0) {
        await this.toolSystem.updateBotMessageIds(this.botId, channelId, toolCallIds, allBotMessageIds)
      }

      // 9. Update state
      const prevCacheMarker = state.lastCacheMarker
      const prevMessagesSinceRoll = state.messagesSinceRoll

      // Update cache markers only if prompt caching is enabled
      // Note: Use promptCachingEnabled (from preConfig) for consistency with fetch-stage logic
      if (promptCachingEnabled) {
        // Update cache marker if it changed
        if (contextResult.cacheMarker && contextResult.cacheMarker !== prevCacheMarker) {
          this.stateManager.updateCacheMarker(this.botId, channelId, contextResult.cacheMarker)
        }

        // Record oldest message ID when rolling for cache stability
        // Only update on roll - otherwise keep anchor stable for cache hits
        if (contextResult.didRoll) {
          const oldestMessageId =
            contextResult.request.messages.find((m) => m.messageId)?.messageId ?? null
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, oldestMessageId)
          logger.debug({ channelId, oldestMessageId }, 'Context rolled, recorded oldest message for cache stability')
        }
      }

      // Update message count - increment if we didn't roll, reset if we did
      if (contextResult.didRoll) {
        this.stateManager.resetMessageCount(this.botId, channelId)
      } else {
        this.stateManager.incrementMessageCount(this.botId, channelId)
      }

      // Record successful outcome to trace
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

      // Track bot messages for Soma reaction rewards
      // Only track if we have a triggering user and sent messages
      if (this.somaClient && sentMessageIds.length > 0 && triggeringMessageId) {
        // Find the triggering user from the discord context
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

      // Notify relay of error and clean up TTS context
      if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
        this.ttsRelayClient.sendActivationEnd({
          channelId: this.ttsStreamContext.channelId,
          userId: this.ttsStreamContext.userId,
          username: this.ttsStreamContext.username,
          reason: 'error',
        })
      }
      this.ttsStreamContext = undefined

      // Check for transient API errors and queue for retry
      if (this.deferredQueue && isTransientError(error)) {
        const queued = this.deferredQueue.queueActivation({
          botId: this.botId,
          channelId,
          guildId,
          error: error instanceof Error ? error : new Error(String(error)),
          originalTriggerId: triggeringMessageId,
        })

        if (queued) {
          logger.warn({ channelId, error: error instanceof Error ? error.message : String(error) },
            'Transient API error - queued for retry')

          // Add hourglass reaction to indicate we're queued
          if (triggeringMessageId) {
            try {
              await this.connector.addReaction(channelId, triggeringMessageId, '⏳')
            } catch (reactionError) {
              logger.debug({ reactionError }, 'Failed to add retry reaction')
            }
          }

          // Record to trace but don't throw - we're handling it
          if (trace) {
            trace.captureLog('warn', 'Queued for deferred retry', {
              errorType: (error as any)?.type,
              retryable: true,
            })
          }

          return  // Don't throw - we've queued the retry
        }
      }

      // Record error to trace
      if (trace) {
        trace.recordError('llm_call', error instanceof Error ? error : new Error(String(error)))
      }

      throw error
    }
  }

  /**
   * Context for TTS streaming - passed to completeLLM when we want to stream to TTS
   */
  private ttsStreamContext?: {
    channelId: string
    userId: string
    username: string
    abortController: AbortController
    interruptedText?: string  // If set, stream was interrupted - use this as the response
  }

  /**
   * Make an LLM completion request using membrane.
   *
   * When TTS relay is connected and ttsStreamContext is set, streams chunks
   * to the relay for real-time text-to-speech.
   */
  private async completeLLM(request: any, config: BotConfig): Promise<any> {
    if (!this.membraneProvider) {
      throw new Error('Membrane not initialized - call setMembrane() before processing requests')
    }

    // Check if we should stream to TTS
    const shouldStreamToTTS =
      config.tts_relay?.enabled &&
      this.ttsRelayClient?.isConnected() &&
      this.ttsStreamContext

    // Stream mode: use membrane.stream() with TTS callbacks
    if (shouldStreamToTTS) {
      logger.debug({ model: request.config?.model }, 'Using membrane stream for LLM with TTS')
      return this.completeLLMWithTTSStream(request, config)
    }

    // Standard completion
    logger.debug({ model: request.config?.model }, 'Using membrane for LLM completion')
    return this.membraneProvider.completeFromLLMRequest(request)
  }

  /**
   * Complete LLM request with streaming to TTS relay
   */
  private async completeLLMWithTTSStream(request: any, _config: BotConfig): Promise<any> {
    const ctx = this.ttsStreamContext!
    const relay = this.ttsRelayClient!

    try {
      const result = await this.membraneProvider!.stream(request, {
        signal: ctx.abortController.signal,
        onChunk: (text, meta) => {
          // Log with explicit visibility tracking for debugging thinking detection
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
        },
        onBlock: (event) => {
          // Log block events to see if thinking blocks are separate
          // Note: membrane BlockEvent uses event.index and event.block.type/content
          const blockIndex = event?.index ?? 0
          const blockType = event?.block?.type ?? 'text'
          // content only exists on block_complete events
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
        },
        // Execute tools and record to trace
        onToolCalls: async (calls, _context) => {
          const results: Array<{ toolUseId: string; content: string; isError?: boolean }> = []

          for (const call of calls) {
            const toolStartTime = Date.now()
            // Convert membrane's call format to ChapterX's ToolCall type
            const cxCall: ToolCall = {
              id: call.id,
              name: call.name,
              input: call.input as Record<string, any>,
              messageId: '', // Not available in TTS stream context
              timestamp: new Date(),
              originalCompletionText: _context.accumulated || '',
            }
            const result = await this.toolSystem.executeTool(cxCall)
            const toolDurationMs = Date.now() - toolStartTime

            // Format output string
            const outputStr = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output)

            // Build result content
            let content: string
            let isError = false
            if (result.error) {
              content = `Error executing ${call.name}: ${result.error}`
              isError = true
            } else {
              content = outputStr
              // Note: image handling for TTS mode could be added here if needed
            }

            // Record to trace
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
              sentToDiscord: false, // TTS mode doesn't send tool output to Discord
              error: result.error ? String(result.error) : undefined,
              imageCount: result.images?.length,
            })

            logger.debug({
              toolName: call.name,
              durationMs: toolDurationMs,
              hasError: !!result.error,
              outputLength: outputStr.length,
            }, 'TTS stream tool executed')

            results.push({
              toolUseId: call.id,
              content,
              isError,
            })
          }

          return results
        },
      })

      // Log final result to see content block types
      logger.info({
        contentBlockCount: result?.content?.length,
        contentBlockTypes: result?.content?.map((b: any) => b.type),
        stopReason: result?.stopReason,
      }, 'TTS stream complete - membrane result summary')

      return result
    } catch (error: any) {
      // Check if this was an abort due to TTS interruption
      if (ctx.interruptedText && (error.name === 'AbortError' || ctx.abortController.signal.aborted)) {
        logger.info(
          { channelId: ctx.channelId, textLength: ctx.interruptedText.length },
          'Stream aborted due to TTS interruption, using interrupted text'
        )
        // Return a synthetic completion with just the interrupted text
        // Format matches what fromMembraneResponse returns
        return {
          content: [{ type: 'text', text: ctx.interruptedText }],
          stopReason: 'interrupted',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'interrupted',
        }
      }
      throw error
    }
  }

  /**
   * Execute with native tool calls (OpenAI / non-Anthropic models)
   *
   * Uses membrane's stream() with onToolCalls callback to handle the tool loop
   * natively. No XML parsing, no prefill continuation, no stop sequences.
   * Membrane manages the multi-turn tool loop internally.
   */
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
    preambleMessageIds: string[];
    fullCompletionText?: string;
    sentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
  }> {
    const allToolCallIds: string[] = []
    const allSentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    const pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }> = []
    let accumulatedPreToolText = ''

    // Set up TTS streaming context if relay is enabled and connected
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

        // TTS streaming callbacks
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

        // Progressive display: send accumulated text before tools execute
        onPreToolContent: async (text: string) => {
          accumulatedPreToolText += text
          const segments = this.parseIntoSegments(accumulatedPreToolText)
          if (segments.length > 0) {
            // Truncate at participant names
            if (discordMessages) {
              const fullVisibleText = segments.map(s => s.visible).join('')
              const truncResult = this.truncateAtParticipant(
                fullVisibleText,
                discordMessages,
                this.connector.getBotUsername() || config.name,
                llmRequest.stop_sequences
              )
              if (truncResult.truncatedAt) {
                logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncating native pre-tool text at participant')
                return  // Don't send hallucinated content
              }
            }

            const sendResult = await this.sendSegments(
              channelId,
              segments,
              allSentMessageIds.length === 0 ? triggeringMessageId : undefined
            )
            allSentMessageIds.push(...sendResult.sentMessageIds)
            for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
              messageContexts[msgId] = ctx
            }
            // Reset so we don't re-send
            accumulatedPreToolText = ''
          }
        },

        // Execute tools when membrane detects native tool calls
        onToolCalls: async (calls, context) => {
          const results: Array<{ toolUseId: string; content: string; isError?: boolean }> = []

          logger.debug({
            toolCount: calls.length,
            depth: context.depth,
          }, 'Executing native tools')

          for (const call of calls) {
            const toolStartTime = Date.now()

            // Convert membrane call to ChapterX ToolCall
            const cxCall: ToolCall = {
              id: call.id,
              name: call.name,
              input: call.input as Record<string, any>,
              messageId: triggeringMessageId,
              timestamp: new Date(),
              originalCompletionText: context.accumulated || '',
            }

            const toolResult = await this.toolSystem.executeTool(cxCall)
            const toolDurationMs = Date.now() - toolStartTime

            allToolCallIds.push(call.id)

            // Format output
            const outputStr = typeof toolResult.output === 'string'
              ? toolResult.output
              : JSON.stringify(toolResult.output)

            let content: string
            let isError = false
            if (toolResult.error) {
              content = `Error executing ${call.name}: ${toolResult.error}`
              isError = true
            } else {
              content = outputStr
            }

            // Store for persistence
            pendingToolPersistence.push({ call: cxCall, result: toolResult })

            // Record to trace
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

            // Send tool output to Discord if visible
            if (config.tool_output_visible) {
              const inputStr = JSON.stringify(call.input)
              const rawOutput = typeof toolResult.output === 'string' ? toolResult.output : JSON.stringify(toolResult.output)
              const flatOutput = rawOutput.replace(/\n/g, ' ').replace(/\s+/g, ' ')
              const maxLen = 200
              const trimmedOutput = flatOutput.length > maxLen
                ? `${flatOutput.slice(0, maxLen)}... (${rawOutput.length} chars)`
                : flatOutput
              const toolMessage = `.${config.name}>[${call.name}]: ${inputStr}\n.${config.name}<[${call.name}]: ${trimmedOutput}`
              await this.connector.sendWebhook(channelId, toolMessage, config.name)

              // Send MCP images as dotted attachments if present
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

          return results
        },
      })

      // Persist tool uses
      for (const { call, result } of pendingToolPersistence) {
        await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
      }

      // Extract final text from completion
      const completionText = (result?.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')

      // Strip thinking blocks and tool XML
      const { stripped, content: thinkingContent } = this.stripThinkingBlocks(
        this.toolSystem.stripToolXml(completionText)
      )

      // Post debug thinking if enabled
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

      // Truncate at participant names
      let displayText = stripped
      if (discordMessages) {
        const truncResult = this.truncateAtParticipant(
          displayText,
          discordMessages,
          this.connector.getBotUsername() || config.name,
          llmRequest.stop_sequences
        )
        if (truncResult.truncatedAt) {
          logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncated native output at participant')
          displayText = truncResult.text
        }
      }

      // Replace mentions
      if (discordMessages) {
        displayText = await this.replaceMentions(displayText, discordMessages)
      }

      // Send remaining text to Discord (text not already sent via onPreToolContent)
      if (displayText.trim()) {
        const segments = this.parseIntoSegments(displayText)
        if (segments.length > 0) {
          const sendResult = await this.sendSegments(
            channelId,
            segments,
            allSentMessageIds.length === 0 ? triggeringMessageId : undefined
          )
          allSentMessageIds.push(...sendResult.sentMessageIds)
          for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
            messageContexts[msgId] = ctx
          }
        }
      }

      // Clean up TTS streaming context
      if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
        this.ttsRelayClient.sendActivationEnd({
          channelId: this.ttsStreamContext.channelId,
          userId: this.ttsStreamContext.userId,
          username: this.ttsStreamContext.username,
          reason: 'complete',
        })
      }
      this.ttsStreamContext = undefined

      return {
        completion: {
          content: [{ type: 'text', text: displayText }],
          stopReason: (result?.stopReason || 'end_turn') as any,
          usage: result?.usage || { inputTokens: 0, outputTokens: 0 },
          model: result?.model || '',
        },
        toolCallIds: allToolCallIds,
        preambleMessageIds: [],
        fullCompletionText: completionText,
        sentMessageIds: allSentMessageIds,
        messageContexts,
      }
    } catch (error: any) {
      // Handle TTS interruption abort
      if (ttsCtx?.interruptedText && (error.name === 'AbortError' || ttsCtx.abortController.signal.aborted)) {
        logger.info(
          { channelId: ttsCtx.channelId, textLength: ttsCtx.interruptedText.length },
          'Native stream aborted due to TTS interruption, using interrupted text'
        )

        // Clean up TTS context
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
          preambleMessageIds: [],
          fullCompletionText: ttsCtx.interruptedText,
          sentMessageIds: allSentMessageIds,
          messageContexts,
        }
      }

      // Clean up TTS on unexpected errors too
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

  /**
   * Execute with inline tool injection (Anthropic style)
   *
   * Instead of making separate LLM calls for each tool use, this method:
   * 1. Detects tool calls in the completion stream
   * 2. Executes the tool immediately
   * 3. Injects the result into the assistant's output
   * 4. Continues the completion from there
   * 
   * This saves tokens by avoiding context re-sends and preserves the bot's
   * "train of thought" across tool uses.
   */
  // Stop sequence for inline tool execution (assembled to avoid stop sequence in source)
  private static readonly FUNC_CALLS_CLOSE = '</' + 'function_calls>'

  private async executeWithInlineTools(
    llmRequest: any,
    config: BotConfig,
    channelId: string,
    triggeringMessageId: string,
    _activationId?: string,
    discordMessages?: DiscordMessage[]  // For post-hoc participant truncation
  ): Promise<{ 
    completion: any; 
    toolCallIds: string[]; 
    preambleMessageIds: string[]; 
    fullCompletionText?: string;
    sentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
  }> {
    let accumulatedOutput = ''
    let toolDepth = 0
    const allToolCallIds: string[] = []
    const allPreambleMessageIds: string[] = []
    const allSentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    const maxToolDepth = config.max_tool_depth
    const pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }> = []
    
    // Track MCP tool result images for injection into continuation requests
    // These accumulate across tool iterations so the model can see all images
    let pendingToolImages: Array<{ toolName: string; images: Array<{ data: string; mimeType: string }> }> = []

    // Track generated image blocks from LLM completions (e.g., Gemini image generation)
    // These are non-text content blocks that need to be preserved through finalization
    const generatedImageBlocks: ContentBlock[] = []
    
    // Check if thinking was actually prefilled (not in continuation mode)
    const thinkingWasPrefilled = this.wasThinkingPrefilled(llmRequest, config)
    
    // Track context position for each message
    // Each sent message will get a context chunk from contextStartPos to contextEndPos
    let lastContextEndPos = 0
    
    // Keep track of the base request (without accumulated output)
    // Add </function_calls> as stop sequence so we can intercept and execute tools
    const baseRequest = {
      ...llmRequest,
      stop_sequences: [
        ...(llmRequest.stop_sequences || []),
        AgentLoop.FUNC_CALLS_CLOSE
      ]
    }

    // Set up TTS streaming context if relay is enabled and connected
    // Note: activation_start is sent earlier in processActivation for faster feedback
    if (config.tts_relay?.enabled && this.ttsRelayClient?.isConnected() && this.botUserId) {
      this.ttsStreamContext = {
        channelId,
        userId: this.botUserId,
        username: this.connector.getBotUsername() || config.name,
        abortController: new AbortController(),
      }
    }

    while (toolDepth < maxToolDepth) {
      // Build continuation request with accumulated output as prefill
      // Include any MCP tool result images so the model can see them
      const continuationRequest = this.buildInlineContinuationRequest(
        baseRequest, 
        accumulatedOutput,
        config,
        pendingToolImages.length > 0 ? pendingToolImages : undefined
      )
      
      // Get completion via membrane
      let completion = await this.completeLLM(continuationRequest, config)

      // Handle stop sequence continuation for XML tools format
      // Only applies when using anthropic-xml formatter (detected by presence of XML tags)
      if (completion.stopReason === 'stop_sequence') {
        const completionText = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')
        
        const triggeredStopSequence = completion.raw?.stop_sequence
        
        // Check if we're inside an unclosed <function_calls> block
        // If so, the stop sequence might be inside a tool parameter (e.g., a username)
        // and we should continue to complete the tool call
        const funcCallsOpen = (completionText.match(/<function_calls>/g) || []).length
        const funcCallsClose = (completionText.match(/<\/function_calls>/g) || []).length
        const insideFunctionCalls = funcCallsOpen > funcCallsClose
        
        // Only continue past stop sequences if we're inside an unclosed function_calls block
        // or if we have an unclosed thinking tag and stopped on </function_calls>
        if (insideFunctionCalls && triggeredStopSequence && 
            triggeredStopSequence !== AgentLoop.FUNC_CALLS_CLOSE) {
          // Inside a tool call, participant name in parameter - continue
          logger.debug({ triggeredStopSequence }, 'Stop sequence inside function_calls, continuing')
          completion = await this.continueCompletionAfterStopSequence(
            continuationRequest,
            completion,
            triggeredStopSequence,
            config,
            thinkingWasPrefilled
          )
        } else if (triggeredStopSequence === AgentLoop.FUNC_CALLS_CLOSE) {
          // Check for unclosed thinking tag - need to continue
          // Only assume thinking is open if it was actually prefilled (not in continuation mode)
          let unclosedTag = this.detectUnclosedXmlTag(completionText)
          if (!unclosedTag && thinkingWasPrefilled && !completionText.includes('</thinking>')) {
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
        // If stopped on participant name OUTSIDE function_calls, don't continue
        // The check later will return early
      }
      
      // Note: When prefill_thinking is enabled, membrane's extended thinking API
      // handles thinking blocks, so no manual tag prepending is needed

      // Get new completion text
      const newText = completion.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')

      accumulatedOutput += newText

      // Capture generated image blocks (from image generation models like Gemini)
      for (const block of completion.content) {
        if (block.type === 'image') {
          generatedImageBlocks.push(block)
        }
      }
      
      // If we stopped on </function_calls>, append it back (stop sequence consumes the matched text)
      if (completion.stopReason === 'stop_sequence' && 
          completion.raw?.stop_sequence === AgentLoop.FUNC_CALLS_CLOSE) {
        accumulatedOutput += AgentLoop.FUNC_CALLS_CLOSE
      }
      
      // If we stopped on a participant name (not function_calls), check if we should exit
      // Only exit if we're NOT inside an unclosed function_calls block
      if (completion.stopReason === 'stop_sequence' && 
          completion.raw?.stop_sequence !== AgentLoop.FUNC_CALLS_CLOSE) {
        // Check if we're inside an unclosed function_calls block
        const funcCallsOpen = (accumulatedOutput.match(/<function_calls>/g) || []).length
        const funcCallsClose = (accumulatedOutput.match(/<\/function_calls>/g) || []).length
        const insideFunctionCalls = funcCallsOpen > funcCallsClose
        
        if (!insideFunctionCalls) {
          // Not inside a tool call - model was about to hallucinate, exit
          logger.debug({ 
            stopSequence: completion.raw?.stop_sequence 
          }, 'Stopped on participant name outside function_calls, returning')
          
          return this.finalizeInlineExecution({
            accumulatedOutput,
            pendingToolPersistence,
            allToolCallIds,
            allPreambleMessageIds,
            allSentMessageIds,
            messageContexts,
            lastContextEndPos,
            channelId,
            triggeringMessageId,
            config,
            llmRequest,
            discordMessages,
            stopReason: completion.stopReason,
            generatedImageBlocks,
          })
        }
        // Inside function_calls - the stop sequence was in a parameter, continue
        logger.debug({ 
          stopSequence: completion.raw?.stop_sequence 
        }, 'Stopped on participant name inside function_calls, continuing to parse')
      }
      
      // Try to parse Anthropic-style tool calls
      const toolParse = this.toolSystem.parseAnthropicToolCalls(accumulatedOutput)
      
      if (!toolParse || toolParse.calls.length === 0) {
        // No tool calls - check if incomplete (still generating)
        if (this.toolSystem.hasIncompleteToolCall(accumulatedOutput)) {
          // Incomplete tool call - need to continue
          // This shouldn't happen with non-streaming, but handle it
          logger.warn('Incomplete tool call detected in non-streaming mode')
        }
        
        // Done - finalize and return
        return this.finalizeInlineExecution({
          accumulatedOutput,
          pendingToolPersistence,
          allToolCallIds,
          allPreambleMessageIds,
          allSentMessageIds,
          messageContexts,
          lastContextEndPos,
          channelId,
          triggeringMessageId,
          config,
          llmRequest,
          discordMessages,
          stopReason: completion.stopReason,
          generatedImageBlocks,
        })
      }
      
      // Execute tools and collect results
      logger.debug({ 
        toolCount: toolParse.calls.length, 
        toolDepth 
      }, 'Executing inline tools')
      
      // PROGRESSIVE DISPLAY: Send visible text before tool calls, split at invisible boundaries
      // Parse beforeText into segments (preserves invisible content associations)
      let segments = this.parseIntoSegments(toolParse.beforeText)
      let sentMsgIdsThisRound: string[] = []
      
      // Check for hallucinated participant in combined visible text
      if (segments.length > 0 && discordMessages && toolDepth === 0) {
        const fullVisibleText = segments.map(s => s.visible).join('')
        const truncResult = this.truncateAtParticipant(
          fullVisibleText, 
          discordMessages, 
          this.connector.getBotUsername() || config.name, 
          llmRequest.stop_sequences
        )
        if (truncResult.truncatedAt?.startsWith('start_hallucination:')) {
          // Response started with another participant - complete hallucination
          logger.warn({ truncatedAt: truncResult.truncatedAt }, 'Aborting inline execution - response started with hallucinated participant')
          return this.finalizeInlineExecution({
            accumulatedOutput: '',  // Discard everything
            pendingToolPersistence,
            allToolCallIds,
            allPreambleMessageIds,
            allSentMessageIds,
            messageContexts,
            lastContextEndPos,
            channelId,
            triggeringMessageId,
            config,
            llmRequest,
            discordMessages,
            stopReason: 'hallucination',
            generatedImageBlocks: [],  // Discard images too on hallucination
          })
        }
        // Apply truncation to segments if needed
        if (truncResult.truncatedAt) {
          logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncating pre-tool text at participant')
          segments = this.truncateSegmentsAtPosition(segments, truncResult.text.length)
        }
      }
      
      if (segments.length > 0) {
        // Send segments, preserving invisible content associations
        const sendResult = await this.sendSegments(
          channelId,
          segments,
          toolDepth === 0 ? triggeringMessageId : undefined  // Only reply on first message
        )
        sentMsgIdsThisRound = sendResult.sentMessageIds
        allSentMessageIds.push(...sentMsgIdsThisRound)
        
        // Merge contexts
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
        // Set messageId for tool cache interleaving
        call.messageId = triggeringMessageId
        
        const toolStartTime = Date.now()
        const result = await this.toolSystem.executeTool(call)
        const toolDurationMs = Date.now() - toolStartTime
        
        allToolCallIds.push(call.id)
        
        // Collect result for injection
        const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
        
        // Build result text - include note about images if present
        let resultText = ''
        if (result.error) {
          resultText = `Error executing ${call.name}: ${result.error}`
        } else {
          resultText = outputStr
          // If images were returned, collect them for injection into next LLM call
          // and append a text note so the model knows images are available
          if (result.images && result.images.length > 0) {
            // Collect images for LLM context injection
            pendingToolImages.push({
              toolName: call.name,
              images: result.images,
            })
            
            // Update plugin context with new visible images
            // MCP images come first (newest), then discord images
            const mcpVisibleImages = pendingToolImages.flatMap(({ toolName, images }) =>
              images.map((img, i) => ({
                index: 0, // Will be re-indexed below
                source: 'mcp_tool' as const,
                sourceDetail: toolName,
                data: img.data,
                mimeType: img.mimeType,
                description: `result ${i + 1} from ${toolName}`,
              }))
            ).reverse() // Most recent tool results first
            
            // Get existing discord images from context
            const existingContext = this.toolSystem.getPluginContext()
            const discordImages = (existingContext?.visibleImages || [])
              .filter(img => img.source === 'discord')
            
            // Combine and re-index
            const allVisibleImages = [...mcpVisibleImages, ...discordImages]
              .map((img, i) => ({ ...img, index: i + 1 }))
            
            this.toolSystem.setPluginContext({ visibleImages: allVisibleImages })
            
            // Append text note about the images
            const imageNote = result.images.map((img, i) => 
              `[Image ${i + 1}: ${img.mimeType}]`
            ).join('\n')
            resultText += '\n\n' + imageNote
          }
        }
        resultsTexts.push(resultText)
        
        // Store for later persistence (with final accumulatedOutput)
        pendingToolPersistence.push({ call, result })
        
        // Record to trace - use error message as output when there's an error
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
        
        // Send tool output to Discord if visible
        if (config.tool_output_visible) {
          const inputStr = JSON.stringify(call.input)
          const rawOutput = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
          const flatOutput = rawOutput.replace(/\n/g, ' ').replace(/\s+/g, ' ')
          const maxLen = 200
          const trimmedOutput = flatOutput.length > maxLen 
            ? `${flatOutput.slice(0, maxLen)}... (${rawOutput.length} chars)`
            : flatOutput
          
          const toolMessage = `.${config.name}>[${call.name}]: ${inputStr}\n.${config.name}<[${call.name}]: ${trimmedOutput}`
          await this.connector.sendWebhook(channelId, toolMessage, config.name)
          
          // Send MCP images as dotted attachments if present
          if (result.images && result.images.length > 0) {
            for (let i = 0; i < result.images.length; i++) {
              const img = result.images[i]!
              try {
                await this.connector.sendImageAttachment(
                  channelId,
                  img.data,
                  img.mimeType,
                  `.${config.name}<[${call.name}] image ${i + 1}/${result.images.length}`,
                  undefined  // No reply
                )
                logger.debug({ toolName: call.name, imageIndex: i }, 'Sent MCP tool image to Discord')
              } catch (err) {
                logger.warn({ err, toolName: call.name, imageIndex: i }, 'Failed to send MCP tool image to Discord')
              }
            }
          }
        }
      }
      
      // Inject results after the function_calls block
      const resultsText = resultsTexts.join('\n\n---\n\n')
      const newAccumulated = toolParse.beforeText + toolParse.fullMatch + 
        this.toolSystem.formatToolResultForInjection('', resultsText)
      
      // Context tracking is now handled by sendSegments - the segments already have their 
      // prefixes tracked. The tool call + results become invisible content that will be 
      // the prefix of the next visible segment (when model continues).
      // Update lastContextEndPos to track where we've processed.
      if (sentMsgIdsThisRound.length > 0) {
        // We've sent segments from beforeText. The tool call + results are new invisible
        // content that will be picked up as prefix in the next iteration.
        lastContextEndPos = newAccumulated.length
      }
      
      accumulatedOutput = newAccumulated
      
      // After injecting, we need to continue and get the model's response to the tool results
      // This will either be: more tool calls, final text, or stop on participant
      toolDepth++
      
      // Continue to next iteration to see what the model generates after seeing tool results
      // The loop will exit when:
      // 1. No more tool calls are found (model finished or stopped on participant)
      // 2. Max tool depth reached
    }
    
    logger.warn('Reached max inline tool depth')
    
    return this.finalizeInlineExecution({
      accumulatedOutput,
      pendingToolPersistence,
      allToolCallIds,
      allPreambleMessageIds,
      allSentMessageIds,
      messageContexts,
      lastContextEndPos,
      channelId,
      triggeringMessageId,
      config,
      llmRequest,
      discordMessages,
      suffix: '[Max tool depth reached]',
      generatedImageBlocks,
    })
  }
  
  
  /**
   * Finalize inline tool execution - truncate, persist, send remaining text, and build result.
   * This ensures trace always matches what was actually sent to Discord.
   */
  private async finalizeInlineExecution(params: {
    accumulatedOutput: string;
    pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }>;
    allToolCallIds: string[];
    allPreambleMessageIds: string[];
    allSentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
    lastContextEndPos: number;
    channelId: string;
    triggeringMessageId: string;
    config: BotConfig;
    llmRequest: any;
    discordMessages?: DiscordMessage[];
    suffix?: string;  // e.g., '[Max tool depth reached]'
    stopReason?: string;
    generatedImageBlocks?: ContentBlock[];  // Image blocks from image generation models
  }): Promise<{
    completion: any;
    toolCallIds: string[];
    preambleMessageIds: string[];
    fullCompletionText: string;
    sentMessageIds: string[];
    messageContexts: Record<string, MessageContext>;
    actualSentText: string;  // For trace validation
  }> {
    let { accumulatedOutput } = params
    const { 
      pendingToolPersistence, allToolCallIds, allPreambleMessageIds, 
      allSentMessageIds, messageContexts, lastContextEndPos,
      channelId, triggeringMessageId, config, llmRequest, discordMessages,
      suffix, stopReason, generatedImageBlocks
    } = params
    
    // 1. Get remaining output (after what was already sent)
    const remainingOutput = accumulatedOutput.slice(lastContextEndPos)
    
    // 2. Truncate at participant names (on the remaining output, preserving invisible)
    let truncatedRemaining = remainingOutput
    if (discordMessages && remainingOutput) {
      const truncResult = this.truncateAtParticipant(
        remainingOutput, 
        discordMessages, 
        this.connector.getBotUsername() || config.name, 
        llmRequest.stop_sequences
      )
      if (truncResult.truncatedAt) {
        logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncated inline output at participant')
        truncatedRemaining = truncResult.text
        // Also truncate accumulatedOutput for persistence
        accumulatedOutput = accumulatedOutput.slice(0, lastContextEndPos) + truncatedRemaining
      }
    }
    
    // 3. Persist all pending tool uses with the final (truncated) accumulated output
    for (const { call, result } of pendingToolPersistence) {
      call.originalCompletionText = accumulatedOutput
      await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
    }
    
    // 4. Parse remaining output into segments
    const suffixText = suffix ? `\n${suffix}` : ''
    let segments = this.parseIntoSegments(truncatedRemaining + suffixText)
    
    // 5. Replace <@username> with <@USER_ID> for Discord mentions in segments
    if (discordMessages) {
      for (const segment of segments) {
        segment.visible = await this.replaceMentions(segment.visible, discordMessages)
      }
    }
    
    // 6. Strip <reply:@username> prefix from first segment if present
    const replyPattern = /^\s*<reply:@[^>]+>\s*/
    if (segments.length > 0 && replyPattern.test(segments[0]!.visible)) {
      segments[0]!.visible = segments[0]!.visible.replace(replyPattern, '').trim()
      // Remove segment if it became empty
      if (!segments[0]!.visible) {
        // Move prefix to next segment or track as orphaned
        if (segments.length > 1) {
          segments[1]!.prefix = segments[0]!.prefix + segments[1]!.prefix
        }
        segments.shift()
      }
    }
    
    // 7. Extract thinking content and post debug messages BEFORE the visible response
    const { stripped, content: thinkingContent } = this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput))
    if (config.debug_thinking && thinkingContent.length > 0) {
      for (const thinking of thinkingContent) {
        if (thinking.trim()) {
          try {
            // If thinking is short enough, post as dot-prefixed message
            // Otherwise, post as text file attachment
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
    
    // 8. Send segments to Discord
    let actualSentText = ''
    if (segments.length > 0) {
      const sendResult = await this.sendSegments(
        channelId, 
        segments, 
        allSentMessageIds.length === 0 ? triggeringMessageId : undefined
      )
      allSentMessageIds.push(...sendResult.sentMessageIds)
      
      // Merge contexts
      for (const [msgId, ctx] of Object.entries(sendResult.messageContexts)) {
        messageContexts[msgId] = ctx
      }
      
      actualSentText = segments.map(s => s.visible).join('')
    }
    
    // 9. Handle phantom invisible (only invisible content, no visible)
    // This happens when the model outputs only thinking/tool results at the end
    const allInvisible = this.extractAllInvisible(truncatedRemaining)
    if (!segments.length && allInvisible && allSentMessageIds.length > 0) {
      // Attach invisible as suffix to last sent message
      const lastMsgId = allSentMessageIds[allSentMessageIds.length - 1]!
      const existing = messageContexts[lastMsgId]
      messageContexts[lastMsgId] = {
        prefix: existing?.prefix ?? '',
        suffix: (existing?.suffix || '') + allInvisible
      }
    }
    
    // 10. Calculate full display text for trace
    let displayText = stripped
    if (discordMessages) {
      displayText = await this.replaceMentions(displayText, discordMessages)
    }
    
    // 11. Build final completion text for trace
    const fullCompletionText = accumulatedOutput + suffixText

    // Clean up TTS streaming context and notify relay
    if (this.ttsStreamContext && this.ttsRelayClient?.isConnected()) {
      this.ttsRelayClient.sendActivationEnd({
        channelId: this.ttsStreamContext.channelId,
        userId: this.ttsStreamContext.userId,
        username: this.ttsStreamContext.username,
        reason: 'complete',
      })
    }
    this.ttsStreamContext = undefined

    // Build content blocks: text + any generated images from image generation models
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
      },
      toolCallIds: allToolCallIds,
      preambleMessageIds: allPreambleMessageIds,
      fullCompletionText,
      sentMessageIds: allSentMessageIds,
      messageContexts,
      actualSentText,
    }
  }
  
  /**
   * Build a continuation request with accumulated output as prefill
   * Also handles MCP tool result images - these need to be added as user turns
   * since Anthropic only allows images in user messages.
   */
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
    
    // Clone the request
    const request = {
      ...baseRequest,
      messages: [...baseRequest.messages],
    }
    
    // Find the last message (should be empty bot message for completion)
    const lastMsgIndex = request.messages.length - 1
    const lastMsg = request.messages[lastMsgIndex]
    // Bot's participant name in LLM context is always config.name
    
    if (lastMsg && lastMsg.participant === config.name) {
      // Replace the last empty message with accumulated output
      request.messages[lastMsgIndex] = {
        ...lastMsg,
        content: [{ type: 'text', text: trimmedOutput }],
      }
    } else if (trimmedOutput) {
      // Add accumulated output as new message
      request.messages.push({
        participant: config.name,
        content: [{ type: 'text', text: trimmedOutput }],
      })
    }
    
    // Add tool result images as user turn messages
    // These need to be inserted BEFORE the bot's continuation so the model can see them
    // The middleware will handle converting these to proper user turns with images
    if (toolResultImages && toolResultImages.length > 0) {
      const imageMessages: any[] = []
      
      for (const { toolName, images } of toolResultImages) {
        if (images.length === 0) continue
        
        // Create image content blocks
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
        // Insert image messages BEFORE the last (bot continuation) message
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

  /**
   * Check if thinking was actually prefilled in the request.
   * This must mirror the middleware's logic for determining continuation mode.
   * 
   * The middleware considers it a continuation if:
   *   lastNonEmptyParticipant === botName || (prevIsBotMessage && !prevHasToolResult)
   * 
   * If it's a continuation, thinking is NOT prefilled.
   */
  private wasThinkingPrefilled(request: any, config: BotConfig): boolean {
    // If prefill_thinking is disabled, thinking was never prefilled
    if (!config.prefill_thinking) {
      return false
    }
    
    const messages = request.messages || []
    if (messages.length === 0) {
      return false
    }
    
    const lastMsg = messages[messages.length - 1]
    const botName = config.name
    
    // If last message is not from the bot, something is wrong
    if (lastMsg.participant !== botName) {
      return false
    }
    
    // Check if last message has content
    const lastContent = lastMsg.content || []
    const lastHasContent = lastContent.some((c: any) => {
      if (c.type === 'text') {
        return c.text && c.text.trim().length > 0
      }
      return false
    })
    
    const lastHasToolResult = lastContent.some((c: any) => c.type === 'tool_result')
    
    if (lastHasContent) {
      // Last message already has content - thinking wasn't prefilled
      return false
    }
    
    // Last message is empty (completion placeholder).
    // Mirror the middleware's continuation logic:
    // isContinuation = isBotMessage && !hasToolResult && (lastNonEmptyParticipant === botName || (prevIsBotMessage && !prevHasToolResult))
    
    // Track lastNonEmptyParticipant like the middleware does
    let lastNonEmptyParticipant: string | null = null
    for (let i = 0; i < messages.length - 1; i++) {  // Exclude the last (empty) message
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
    
    // Check previous message
    const prevMsg = messages.length >= 2 ? messages[messages.length - 2] : null
    const prevIsBotMessage = prevMsg && prevMsg.participant === botName
    const prevContent = prevMsg?.content || []
    const prevHasToolResult = prevContent.some((c: any) => c.type === 'tool_result')
    
    // Continuation if: lastNonEmptyParticipant was the bot OR prev message is from bot without tool result
    const isContinuation = !lastHasToolResult && (
      lastNonEmptyParticipant === botName ||
      (prevIsBotMessage && !prevHasToolResult)
    )
    
    // If it's a continuation, thinking was NOT prefilled
    // If it's NOT a continuation, thinking WAS prefilled
    return !isContinuation
  }

  /**
   * Detect if there's an unclosed XML tag in the completion text.
   * Checks for tool calls and thinking blocks.
   * Returns the tag name if found, null otherwise.
   */
  private detectUnclosedXmlTag(text: string): string | null {
    // Check for unclosed thinking tag first
    const thinkingOpen = text.lastIndexOf('<thinking>')
    const thinkingClose = text.lastIndexOf('</thinking>')
    if (thinkingOpen !== -1 && thinkingOpen > thinkingClose) {
      return 'thinking'
    }
    
    // Check for unclosed tool call tags
    const toolNames = this.toolSystem.getToolNames()
    
    for (const toolName of toolNames) {
      const openTag = `<${toolName}>`
      const closeTag = `</${toolName}>`
      
      const lastOpenIndex = text.lastIndexOf(openTag)
      const lastCloseIndex = text.lastIndexOf(closeTag)
      
      // If there's an open tag after the last close tag (or no close tag), it's unclosed
      if (lastOpenIndex !== -1 && lastOpenIndex > lastCloseIndex) {
        return toolName
      }
    }
    
    return null
  }

  /**
   * Continue a completion that was interrupted by a stop sequence mid-tool-call.
   * Appends the stop sequence to the partial completion and continues.
   */
  private async continueCompletionAfterStopSequence(
    originalRequest: any,
    partialCompletion: any,
    stopSequence: string,
    config: BotConfig,
    thinkingWasPrefilled: boolean = false,
    maxContinuations: number = 5
  ): Promise<any> {
    let accumulatedText = partialCompletion.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
    
    let continuationCount = 0
    let lastCompletion = partialCompletion
    
    while (continuationCount < maxContinuations) {
      // Append the stop sequence that was triggered
      accumulatedText += stopSequence
      
      // Create a continuation request with accumulated text as prefill
      const continuationRequest = { ...originalRequest }
      
      // Find and update the last assistant message (the prefill)
      const lastMessage = continuationRequest.messages[continuationRequest.messages.length - 1]
      // Bot's participant name in LLM context is always config.name
      if (lastMessage?.participant === config.name) {
        // Append to existing prefill
        const existingText = lastMessage.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')
        lastMessage.content = [{ type: 'text', text: existingText + accumulatedText }]
      } else {
        // Add new assistant message
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
      
      // Get continuation text
      const continuationText = continuation.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
      
      accumulatedText += continuationText
      lastCompletion = continuation
      
      // Check if we need to continue again
      if (continuation.stopReason === 'stop_sequence') {
        let unclosedTag = this.detectUnclosedXmlTag(accumulatedText)
        // Only assume thinking is open if it was actually prefilled (not in continuation mode)
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
      
      // Done continuing
      break
    }
    
    if (continuationCount >= maxContinuations) {
      logger.warn({ maxContinuations }, 'Reached max continuations for stop sequence recovery')
    }
    
    // Return a merged completion with accumulated text
    return {
      ...lastCompletion,
      content: [{ type: 'text', text: accumulatedText }],
    }
  }

  /**
   * Truncate completion text if the model starts speaking as another participant.
   * Uses the full participant list from the conversation (not just recent ones in stop sequences).
   * Also checks for any additional stop sequences provided.
   */
  private truncateAtParticipant(
    text: string, 
    messages: DiscordMessage[], 
    botName: string,
    additionalStopSequences?: string[]
  ): { text: string; truncatedAt: string | null } {
    // Collect ALL unique participant names from the conversation
    const participants = new Set<string>()
    for (const msg of messages) {
      if (msg.author?.username && msg.author.username !== botName) {
        participants.add(msg.author.username)
      }
    }

    // Check if response STARTS with another participant's name (complete hallucination)
    // This catches cases where the model role-plays as another user from the beginning
    for (const participant of participants) {
      const startPattern = `${participant}:`
      if (text.startsWith(startPattern)) {
        logger.warn({ participant, responseStart: text.substring(0, 100) }, 
          'Response starts with another participant - complete hallucination, discarding')
        return { text: '', truncatedAt: `start_hallucination:${participant}` }
      }
    }

    // Find the earliest occurrence of any stop sequence
    let earliestIndex = -1
    let truncatedAt: string | null = null

    // Check participant patterns (with newline prefix - mid-response hallucination)
    for (const participant of participants) {
      const pattern = `\n${participant}:`
      const index = text.indexOf(pattern)
      if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
        earliestIndex = index
        truncatedAt = `participant:${participant}`
      }
    }

    // Check additional stop sequences
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
}

