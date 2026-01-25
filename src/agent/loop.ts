/**
 * Agent Loop
 * Main orchestrator that coordinates all components
 */

import { EventQueue } from './event-queue.js'
import { ChannelStateManager } from './state-manager.js'
import { DiscordConnector } from '../discord/connector.js'
import { ConfigSystem } from '../config/system.js'
import { ContextBuilder, BuildContextParams } from '../context/builder.js'
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
import { setResourceAccessor } from '../tools/plugins/mcp-resources.js'
import { SomaClient, shouldChargeTrigger, SomaTriggerType } from '../soma/index.js'
import { MembraneProvider } from '../llm/membrane/index.js'
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
   * Set membrane instance for LLM calls
   * When set, can be enabled per-bot with use_membrane: true in config
   */
  setMembrane(membrane: Membrane): void {
    this.membraneProvider = new MembraneProvider(membrane, this.botId)
    logger.info({ botId: this.botId }, 'Membrane provider set')
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
  
  // NOTE: extractAllInvisible() removed - only used by legacy finalizeInlineExecution

  /**
   * Truncate segments at a given position in the combined visible text.
   * Returns segments up to (and including partial) that position.
   * Used for mid-response hallucination truncation.
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
    
    // ===== SOMA CREDIT CHECK =====
    // Check if user has sufficient ichor before proceeding with activation
    // Only charge for human-initiated triggers (mention, reply, m_command) - not random
    const somaCheckResult = await this.checkSomaCredits(
      events,
      channelId,
      guildId,
      activationReason.reason,
      triggeringMessageId
    )
    
    if (somaCheckResult.status === 'blocked') {
      // User doesn't have enough ichor - message already sent
      this.activeChannels.delete(channelId)
      return
    }
    
    // Store transaction ID for potential refund if activation fails
    const somaTransactionId = somaCheckResult.transactionId
    // ===== END SOMA CHECK =====
    
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
    triggerReason: 'mention' | 'reply' | 'random' | 'm_command',
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
        
        if (!cacheOldestId && fetchedOldestId) {
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

      // 6. Call LLM (with inline tool execution via membrane)
      // Membrane handles all tool parsing, continuation, false-positive detection
      startProfile('llmCall')
      
      if (!this.membraneProvider) {
        throw new Error('Membrane provider required for tool execution. Ensure setMembrane() was called.')
      }
      
      logger.debug({ model: contextResult.request.config?.model }, 'Using membrane tool loop')
      const { 
        completion, 
        toolCallIds, 
        preambleMessageIds, 
        fullCompletionText,
        sentMessageIds: inlineSentMessageIds,
        messageContexts: inlineMessageContexts
      } = await this.executeWithMembraneTools(
        contextResult.request,
        config,
        channelId,
        triggeringMessageId || '',
        activation?.id,
        discordContext.messages
      )
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
        
        // Record activation if enabled
        if (activation) {
          this.activationStore.addCompletion(
            activation.id,
            '[Generated image]',
            imageSentIds,
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
          responseText: '[Generated image]',
          responseLength: 0,
          sentMessageIds: imageSentIds,
          messagesSent: imageSentIds.length,
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
      
      // Record error to trace
      if (trace) {
        trace.recordError('llm_call', error instanceof Error ? error : new Error(String(error)))
      }
      
      throw error
    }
  }

  // ============================================================================
  // DEPRECATED CODE REMOVED
  // The following methods were excised as part of membrane tool use migration:
  // - completeLLM() - membrane.stream() handles LLM calls directly
  // - completeLLMWithShadow() - shadow mode validation no longer needed  
  // - logShadowComparison() - shadow mode helper
  // - extractTextFromCompletion() - shadow mode helper
  // - calculateSimilarity() - shadow mode helper
  // - executeWithInlineTools() - replaced by executeWithMembraneTools()
  // - FUNC_CALLS_CLOSE constant - membrane handles stop sequences
  // ============================================================================

  // ============================================================================
  // LEGACY TOOL EXECUTION CODE REMOVED
  // ============================================================================
  // Methods excised as part of membrane tool use migration:
  // - completeLLM(), completeLLMWithShadow(), logShadowComparison()
  // - FUNC_CALLS_CLOSE constant, executeWithInlineTools(), finalizeInlineExecution()
  // - buildInlineContinuationRequest(), wasThinkingPrefilled(), detectUnclosedXmlTag()
  // - continueCompletionAfterStopSequence(), extractAllInvisible(), truncateSegmentsAtPosition()
  //
  // Membrane now handles: tool parsing, false-positive detection, continuation,
  // and result injection via its streaming API with onToolCalls callback.
  // ============================================================================

  /**
   * Execute with membrane's tool loop.
   * 
   * This method uses membrane's streaming with onToolCalls callback to handle
   * the tool execution loop. Membrane handles:
   * - XML tool parsing
   * - False-positive stop sequence detection
   * - Tool result injection
   * - Continuation management
   * 
   * ChapterX handles:
   * - Tool execution (MCP plugins, system tools)
   * - Discord progressive sending
   * - Tool result persistence
   */
  private async executeWithMembraneTools(
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
    if (!this.membraneProvider) {
      throw new Error('Membrane provider not configured but executeWithMembraneTools called')
    }
    
    const allToolCallIds: string[] = []
    const allPreambleMessageIds: string[] = []
    const allSentMessageIds: string[] = []
    const messageContexts: Record<string, MessageContext> = {}
    const pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }> = []
    
    // Track accumulated visible content for progressive display
    let currentChunkBuffer = ''
    
    // Track MCP tool result images for plugin context
    let pendingToolImages: Array<{ toolName: string; images: Array<{ data: string; mimeType: string }> }> = []
    
    /**
     * Send buffered content to Discord
     */
    const flushToDiscord = async (forceFlush: boolean = false) => {
      // Parse buffer into segments and send visible content
      if (!currentChunkBuffer) return
      
      // Only flush if we have significant content or are forcing
      let segments = this.parseIntoSegments(currentChunkBuffer)
      const visibleText = segments.map(s => s.visible).join('')
      
      // Flush when we have enough visible content or on force
      if (forceFlush || visibleText.length > 50) {
        if (segments.length > 0 && segments.some(s => s.visible.trim())) {
          // Check for hallucinated participant in visible text
          if (discordMessages) {
            const truncResult = this.truncateAtParticipant(
              visibleText,
              discordMessages,
              this.connector.getBotUsername() || config.name,
              llmRequest.stop_sequences
            )
            if (truncResult.truncatedAt?.startsWith('start_hallucination:')) {
              // Complete hallucination - don't send anything
              logger.warn({ truncatedAt: truncResult.truncatedAt }, 'Detected hallucination in membrane output')
              return
            }
            // Handle mid-response hallucination - truncate segments
            if (truncResult.truncatedAt) {
              logger.info({ truncatedAt: truncResult.truncatedAt }, 'Truncating output at participant hallucination')
              segments = this.truncateSegmentsAtPosition(segments, truncResult.text.length)
            }
          }
          
          // Replace <@username> with <@USER_ID> for Discord mentions in segments
          if (discordMessages) {
            for (const segment of segments) {
              segment.visible = await this.replaceMentions(segment.visible, discordMessages)
            }
          }
          
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
        }
        
        // Reset buffer after flush
        currentChunkBuffer = ''
      }
    }
    
    /**
     * onChunk callback - accumulate chunks for progressive display
     */
    const onChunk = (chunk: string) => {
      currentChunkBuffer += chunk
      // We'll flush in onPreToolContent or at the end
    }
    
    /**
     * onPreToolContent callback - send visible content before tool execution
     */
    const onPreToolContent = async (text: string) => {
      // Parse and send any visible content before tool calls
      await flushToDiscord(true)
      
      logger.debug({ textLength: text.length }, 'Flushed pre-tool content to Discord')
    }
    
    /**
     * onToolCalls callback - execute tools and return results
     */
    const onToolCalls = async (
      calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
      context: { depth: number; accumulated: string; previousResults: Array<{ toolUseId: string; content: string | any[]; isError?: boolean }> }
    ): Promise<Array<{ toolUseId: string; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } }>; isError?: boolean }>> => {
      
      logger.debug({ toolCount: calls.length, depth: context.depth }, 'Membrane tool calls callback')
      
      const results: Array<{ toolUseId: string; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } }>; isError?: boolean }> = []
      
      for (const call of calls) {
        // Convert to ChapterX ToolCall format
        const cxCall: ToolCall = {
          id: call.id,
          name: call.name,
          input: call.input as Record<string, any>,
          messageId: triggeringMessageId,
          timestamp: new Date(),
          originalCompletionText: context.accumulated,
        }
        
        const toolStartTime = Date.now()
        const result = await this.toolSystem.executeTool(cxCall)
        const toolDurationMs = Date.now() - toolStartTime
        
        allToolCallIds.push(call.id)
        
        // Build result content
        let resultContent: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } }>
        let resultText: string
        
        if (result.error) {
          resultText = `Error executing ${call.name}: ${result.error}`
          resultContent = resultText
        } else {
          resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
          
          // If images were returned, build structured content for membrane
          if (result.images && result.images.length > 0) {
            // Collect images for LLM context injection
            pendingToolImages.push({
              toolName: call.name,
              images: result.images,
            })
            
            // Update plugin context with new visible images
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
            
            // Build structured content with images for membrane
            const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } }> = [
              { type: 'text', text: resultText }
            ]
            
            for (const img of result.images) {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  data: img.data,
                  mediaType: img.mimeType,
                },
              })
            }
            
            resultContent = contentBlocks
          } else {
            resultContent = resultText
          }
        }
        
        // Store for persistence
        pendingToolPersistence.push({ call: cxCall, result })
        
        // Record to trace
        const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
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
                  undefined
                )
              } catch (err) {
                logger.warn({ err, toolName: call.name, imageIndex: i }, 'Failed to send MCP tool image to Discord')
              }
            }
          }
        }
        
        results.push({
          toolUseId: call.id,
          content: resultContent,
          isError: !!result.error,
        })
      }
      
      return results
    }
    
    // Stream with membrane's tool loop
    const streamResult = await this.membraneProvider.stream(llmRequest, {
      onChunk,
      onPreToolContent,
      onToolCalls,
      maxToolDepth: config.max_tool_depth,
    })
    
    // Flush any remaining content to Discord
    await flushToDiscord(true)
    
    // Handle abort case
    if (streamResult.aborted) {
      logger.warn({ reason: streamResult.abortReason }, 'Membrane stream was aborted')
      // Still persist what we have
    }
    
    // Get the full raw text from membrane
    const fullCompletionText = streamResult.rawAssistantText
    
    // Persist all tool calls with the final accumulated output
    for (const { call, result } of pendingToolPersistence) {
      call.originalCompletionText = fullCompletionText
      await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
    }
    
    // Extract thinking content and post debug messages
    const { stripped, content: thinkingContent } = this.stripThinkingBlocks(this.toolSystem.stripToolXml(fullCompletionText))
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
    
    // Build final completion for return
    // Replace mentions in display text
    let displayText = stripped
    if (discordMessages) {
      displayText = await this.replaceMentions(displayText, discordMessages)
    }
    
    return {
      completion: {
        content: [{ type: 'text', text: displayText }],
        stopReason: streamResult.completion.stopReason,
        usage: streamResult.completion.usage,
        model: streamResult.completion.model,
        raw: streamResult.completion.raw,
      },
      toolCallIds: allToolCallIds,
      preambleMessageIds: allPreambleMessageIds,
      fullCompletionText,
      sentMessageIds: allSentMessageIds,
      messageContexts,
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

