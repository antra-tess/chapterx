/**
 * Agent Loop
 * Main orchestrator that coordinates all components
 */

import { EventQueue } from './event-queue.js'
import { ChannelStateManager } from './state-manager.js'
import { DiscordConnector } from '../discord/connector.js'
import { ConfigSystem } from '../config/system.js'
import { ContextBuilder, BuildContextParams } from '../context/builder.js'
import { LLMMiddleware } from '../llm/middleware.js'
import { ToolSystem } from '../tools/system.js'
import { Event, BotConfig, DiscordMessage, ToolCall, ToolResult } from '../types.js'
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

  constructor(
    private botId: string,
    private queue: EventQueue,
    private connector: DiscordConnector,
    private stateManager: ChannelStateManager,
    private configSystem: ConfigSystem,
    private contextBuilder: ContextBuilder,
    private llmMiddleware: LLMMiddleware,
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
   * Start the agent loop
   */
  async run(): Promise<void> {
    this.running = true

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
    logger.debug({ count: events.length, types: events.map((e) => e.type) }, 'Processing batch')

    // Get first event to access channel for config (for random check)
    const firstEvent = events[0]
    if (!firstEvent) return
    
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
    if (!await this.shouldActivate(events, firstEvent.channelId, firstEvent.guildId)) {
      logger.debug('No activation needed')
      return
    }

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

    // Check if this channel is already being processed
    if (this.activeChannels.has(channelId)) {
      logger.debug({ channelId }, 'Channel already being processed, skipping')
      return
    }

    // Mark channel as active and process asynchronously (don't await)
    this.activeChannels.add(channelId)
    
    // Determine activation reason for tracing
    const activationReason = this.determineActivationReason(events)
    
    // Wrap activation in both logging and trace context
    const activationPromise = triggeringMessageId
      ? withActivationLogging(channelId, triggeringMessageId, async () => {
          // Get channel name for trace indexing
          const channelName = await this.connector.getChannelName(channelId)
          
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
          
          // Re-throw the original error if there was one
          if (traceError) {
            throw traceError
          }
        })
      : this.handleActivation(channelId, guildId, triggeringMessageId)
    
    activationPromise
      .catch((error) => {
        logger.error({ error, channelId, guildId }, 'Failed to handle activation')
      })
      .finally(() => {
        this.activeChannels.delete(channelId)
      })
  }
  
  private determineActivationReason(events: Event[]): { 
    reason: 'mention' | 'reply' | 'random' | 'm_command', 
    events: Array<{ type: string; messageId?: string; authorId?: string; authorName?: string; contentPreview?: string }> 
  } {
    const triggerEvents: Array<{ type: string; messageId?: string; authorId?: string; authorName?: string; contentPreview?: string }> = []
    let reason: 'mention' | 'reply' | 'random' | 'm_command' = 'mention'
    
    for (const event of events) {
      if (event.type === 'message') {
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
            const configFetch = await this.connector.fetchContext({ channelId, depth: 10 })
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
          const configFetch = await this.connector.fetchContext({ channelId, depth: 10 })
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
    // Start typing indicator
    await this.connector.startTyping(channelId)
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
      
      startProfile('fetchContext')
      // 3. Fetch context with calculated depth (messages + images), reusing pinned configs
      const discordContext = await this.connector.fetchContext({
        channelId,
        depth: fetchDepth,
        // Note: We no longer pass firstMessageId here. Cache stability is now based on
        // the first message in the FINAL request (after context building), not the fetch.
        // This avoids anchoring to messages that slide out of the fetchable window.
        authorized_roles: [],  // Will apply after loading config
        pinnedConfigs,  // Reuse pre-fetched pinned configs (avoids second API call)
      })
      endProfile('fetchContext')
      
      // Note: Cache stability anchor is now set AFTER context building, based on the first 
      // message in the final request (not the first fetched message). This ensures we only
      // anchor to content we're actually sending to the LLM. See the cacheOldestMessageId
      // update after context building below.
      
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

      // Initialize MCP servers from config (once per bot)
      if (!this.mcpInitialized && config.mcp_servers && config.mcp_servers.length > 0) {
        startProfile('mcpInit')
        logger.info({ serverCount: config.mcp_servers.length }, 'Initializing MCP servers from config')
        await this.toolSystem.initializeServers(config.mcp_servers)
        this.mcpInitialized = true
        endProfile('mcpInit')
      }
      
      startProfile('pluginSetup')
      // Load tool plugins from config
      if (config.tool_plugins && config.tool_plugins.length > 0) {
        this.toolSystem.loadPlugins(config.tool_plugins)
      }
      
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
        contextResult.request.tools = this.toolSystem.getAvailableTools()
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

      // 6. Call LLM (with inline tool execution)
      startProfile('llmCall')
      
      const { 
        completion, 
        toolCallIds, 
        preambleMessageIds, 
        fullCompletionText,
        sentMessageIds: inlineSentMessageIds,
        messageContexts: inlineMessageContexts
      } = await this.executeWithInlineTools(
        contextResult.request, 
        config, 
        channelId,
        triggeringMessageId || '',
        activation?.id,
        discordContext.messages  // For post-hoc participant truncation
      )
      endProfile('llmCall')

      // 7. Stop typing
      await this.connector.stopTyping(channelId)

      // 7.5. Check for refusal
      const wasRefused = completion.stopReason === 'refusal'
      if (wasRefused) {
        logger.warn({ stopReason: completion.stopReason }, 'LLM refused to complete request')
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
      if (config.prompt_caching !== false) {
      // Update cache marker if it changed
        if (contextResult.cacheMarker && contextResult.cacheMarker !== prevCacheMarker) {
        this.stateManager.updateCacheMarker(this.botId, channelId, contextResult.cacheMarker)
        }

        // ALWAYS update cacheOldestMessageId to match the first message in the actual request
        // This ensures cache stability is based on what we're actually sending, not what we fetched
        const oldestMessageId =
          contextResult.request.messages.find((m) => m.messageId)?.messageId ?? null
        const prevOldestId = state.cacheOldestMessageId
        
        if (oldestMessageId !== prevOldestId) {
          this.stateManager.updateCacheOldestMessageId(this.botId, channelId, oldestMessageId)
          logger.debug({ 
            channelId, 
            oldestMessageId, 
            prevOldestId,
            didRoll: contextResult.didRoll 
          }, 'Updated cache anchor to first message in request')
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

      logger.info({ channelId, tokens: completion.usage, didRoll: contextResult.didRoll }, 'Activation complete')
    } catch (error) {
      await this.connector.stopTyping(channelId)
      
      // Record error to trace
      if (trace) {
        trace.recordError('llm_call', error instanceof Error ? error : new Error(String(error)))
      }
      
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
    
    while (toolDepth < maxToolDepth) {
      // Build continuation request with accumulated output as prefill
      const continuationRequest = this.buildInlineContinuationRequest(
        baseRequest, 
        accumulatedOutput,
        config
      )
      
      // Get completion
      let completion = await this.llmMiddleware.complete(continuationRequest)
      
      // Handle stop sequence continuation - only if we're inside an unclosed tag
      if (completion.stopReason === 'stop_sequence' && config.mode === 'prefill') {
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
      
      // Prepend thinking tag if it was actually prefilled
      if (thinkingWasPrefilled && accumulatedOutput === '') {
        const firstTextBlock = completion.content.find((c: any) => c.type === 'text') as any
        if (firstTextBlock?.text) {
          firstTextBlock.text = '<thinking>' + firstTextBlock.text
        }
      }
      
      // Get new completion text
      const newText = completion.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
      
      accumulatedOutput += newText
      
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
        if (result.error) {
          resultsTexts.push(`Error executing ${call.name}: ${result.error}`)
        } else {
          resultsTexts.push(outputStr)
        }
        
        // Store for later persistence (with final accumulatedOutput)
        pendingToolPersistence.push({ call, result })
        
        // Record to trace
        traceToolExecution({
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          output: outputStr.length > 1000 ? outputStr.slice(0, 1000) + '...' : outputStr,
          outputTruncated: outputStr.length > 1000,
          fullOutputLength: outputStr.length,
          durationMs: toolDurationMs,
          sentToDiscord: config.tool_output_visible,
          error: result.error ? String(result.error) : undefined,
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
      suffix, stopReason
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
    
    return {
      completion: {
        content: [{ type: 'text', text: displayText + suffixText }],
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
   */
  private buildInlineContinuationRequest(
    baseRequest: any,
    accumulatedOutput: string,
    config: BotConfig
  ): any {
    if (!accumulatedOutput) {
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
    const lastMsg = request.messages[request.messages.length - 1]
    // Bot's participant name in LLM context is always config.name
    
    if (lastMsg && lastMsg.participant === config.name) {
      // Replace the last empty message with accumulated output
      request.messages[request.messages.length - 1] = {
        ...lastMsg,
        content: [{ type: 'text', text: trimmedOutput }],
      }
    } else {
      // Add accumulated output as new message
      request.messages.push({
        participant: config.name,
        content: [{ type: 'text', text: trimmedOutput }],
      })
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
      
      const continuation = await this.llmMiddleware.complete(continuationRequest)
      
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

