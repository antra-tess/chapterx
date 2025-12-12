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
import { ActivationStore, Activation, TriggerType } from '../activation/index.js'
import { PluginContextFactory, ContextInjection } from '../tools/plugins/index.js'

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

  /**
   * Strip tool call XML and thinking blocks from text, leaving any preamble/surrounding text
   * e.g., "Let me check that <read_graph>{}</read_graph>" -> "Let me check that"
   * e.g., "<thinking>reasoning</thinking><tool>{}</tool>" -> ""
   */
  private stripToolCallsFromText(text: string, toolUseBlocks: any[]): string {
    // Strip thinking blocks first (respecting backtick escaping)
    let result = this.stripThinkingBlocks(text).stripped
    
    // Get tool names that were parsed
    const toolNames = toolUseBlocks.map(b => b.name)
    
    // Remove each tool call XML pattern
    for (const name of toolNames) {
      // Pattern matches: <tool_name>...</tool_name> with optional JSON inside
      const pattern = new RegExp(`<${name}>\\s*(?:\\{[\\s\\S]*?\\})?\\s*</${name}>`, 'g')
      result = result.replace(pattern, '')
    }
    
    // Clean up extra whitespace
    result = result.replace(/\n{3,}/g, '\n\n').trim()
    
    return result
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
      
      const promptCachingEnabled = preConfig.prompt_caching !== false
      
      startProfile('fetchContext')
      // 3. Fetch context with calculated depth (messages + images), reusing pinned configs
      const discordContext = await this.connector.fetchContext({
        channelId,
        depth: fetchDepth,
        // Anchor the start of the fetched window for prompt cache stability (if enabled).
        // This prevents the oldest message from sliding forward as new messages arrive,
        // which would otherwise invalidate the cached prompt prefix on every activation.
        firstMessageId: promptCachingEnabled ? (state.cacheOldestMessageId || undefined) : undefined,
        authorized_roles: [],  // Will apply after loading config
        pinnedConfigs,  // Reuse pre-fetched pinned configs (avoids second API call)
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
          
          if (cacheIdx > 0) {
            // Cache marker is NEWER than fetched oldest - .history brought in older context
            // Update cache marker to include the older context instead of trimming it away
            logger.debug({
              oldCacheMarker: cacheOldestId,
              newCacheMarker: fetchedOldestId,
              olderMessagesIncluded: cacheIdx,
            }, 'Expanding cache marker to include .history context')
            this.stateManager.updateCacheOldestMessageId(this.botId, channelId, fetchedOldestId)
            // No trimming needed - keep all fetched messages
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
        const content = msg.content?.trim()
        return !content?.startsWith('m ')
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

      // 6. Call LLM (with tool loop)
      startProfile('llmCall')
      
      // Use inline tool execution if enabled (Anthropic-style, saves tokens)
      const executeMethod = config.inline_tool_execution 
        ? this.executeWithInlineTools.bind(this)
        : this.executeWithTools.bind(this)
      
      const { 
        completion, 
        toolCallIds, 
        preambleMessageIds, 
        fullCompletionText,
        sentMessageIds: inlineSentMessageIds,
        messageContexts: inlineMessageContexts
      } = await executeMethod(
        contextResult.request, 
        config, 
        channelId,
        triggeringMessageId || '',
        activation?.id
      )
      endProfile('llmCall')

      // 7. Stop typing
      await this.connector.stopTyping(channelId)

      // 7.5. Check for refusal
      const wasRefused = completion.stopReason === 'refusal'
      if (wasRefused) {
        logger.warn({ stopReason: completion.stopReason }, 'LLM refused to complete request')
      }

      // 8. Send response
      let responseText = completion.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')

      logger.debug({
        contentBlocks: completion.content.length,
        textBlocks: completion.content.filter((c: any) => c.type === 'text').length,
        responseLength: responseText.length
      }, 'Extracted response text')

      // Truncate if model continues past a stop sequence (post-hoc enforcement)
      // This catches cases where the API ignored stop sequences (e.g., OpenRouter with >4 sequences)
      const truncateResult = this.truncateAtParticipant(
        responseText, 
        discordContext.messages, 
        config.innerName,
        contextResult.request.stop_sequences
      )
      responseText = truncateResult.text

      // Strip ALL <thinking>...</thinking> sections (respecting backtick escaping)
      const { stripped: strippedResponse, content: thinkingContents } = this.stripThinkingBlocks(responseText)
      
      if (thinkingContents.length > 0) {
        const allThinkingContent = thinkingContents.join('\n\n---\n\n')
        
        logger.debug({ 
          thinkingBlocks: thinkingContents.length,
          totalThinkingLength: allThinkingContent.length 
        }, 'Stripped thinking sections from response')
        
        // Send thinking as debug message if enabled
        if (config.debug_thinking && allThinkingContent) {
          const thinkingDebugContent = `.💭 ${allThinkingContent}`
          if (thinkingDebugContent.length <= 1800) {
            // Send as regular message
            await this.connector.sendMessage(channelId, thinkingDebugContent, triggeringMessageId)
          } else {
            // Send as text file attachment
            await this.connector.sendMessageWithAttachment(
              channelId,
              '.💭',
              {
                name: 'thinking.txt',
                content: allThinkingContent,
              },
              triggeringMessageId
            )
          }
        }
        
        // Use the already-stripped response
        responseText = strippedResponse.trim()
      }

      // Strip <reply:@username> prefix if bot included it (bot responses are already Discord replies)
      const replyPattern = /^\s*<reply:@[^>]+>\s*/
      if (replyPattern.test(responseText)) {
        responseText = responseText.replace(replyPattern, '')
        logger.debug('Stripped reply prefix from bot response')
      }

      // Replace <@username> with <@USER_ID> for Discord mentions
      responseText = await this.replaceMentions(responseText, discordContext.messages)

      let sentMessageIds: string[] = []
      
      // Check if inline execution already sent messages
      if (inlineSentMessageIds && inlineSentMessageIds.length > 0) {
        // Inline execution already sent messages progressively
        sentMessageIds = inlineSentMessageIds
        logger.debug({ sentMessageIds }, 'Using message IDs from inline tool execution')
        
        // Handle refusal reactions
        if (wasRefused && sentMessageIds.length > 0) {
          for (const msgId of sentMessageIds) {
            await this.connector.addReaction(channelId, msgId, '🛑')
          }
          logger.info({ sentMessageIds }, 'Added refusal reaction to inline-sent messages')
        }
      } else if (responseText.trim()) {
        // Send as reply to triggering message (legacy path for non-inline execution)
        sentMessageIds = await this.connector.sendMessage(channelId, responseText, triggeringMessageId)
        // Track bot's message IDs for reply detection
        sentMessageIds.forEach((id) => this.botMessageIds.add(id))
        
        // If refusal with content, add reaction to sent message(s)
        if (wasRefused && sentMessageIds.length > 0) {
          for (const msgId of sentMessageIds) {
            await this.connector.addReaction(channelId, msgId, '🛑')
          }
          logger.info({ sentMessageIds }, 'Added refusal reaction to sent messages')
        }
      } else {
        logger.warn('No text content to send in response')
        
        // If refusal with no content, add reaction to triggering message
        if (wasRefused && triggeringMessageId) {
          await this.connector.addReaction(channelId, triggeringMessageId, '🛑')
          logger.info({ triggeringMessageId }, 'Added refusal reaction to triggering message (no content sent)')
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

        // Record oldest message ID when rolling for cache stability
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
    _activationId?: string
  ): Promise<{ 
    completion: any; 
    toolCallIds: string[]; 
    preambleMessageIds: string[]; 
    fullCompletionText?: string;
    sentMessageIds: string[];
    messageContexts: Record<string, string>;
  }> {
    let accumulatedOutput = ''
    let toolDepth = 0
    const allToolCallIds: string[] = []
    const allPreambleMessageIds: string[] = []
    const allSentMessageIds: string[] = []
    const messageContexts: Record<string, string> = {}
    const maxToolDepth = config.max_tool_depth
    const pendingToolPersistence: Array<{ call: ToolCall; result: ToolResult }> = []
    
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
            config
          )
        } else if (triggeredStopSequence === AgentLoop.FUNC_CALLS_CLOSE) {
          // Check for unclosed thinking tag - need to continue
          let unclosedTag = this.detectUnclosedXmlTag(completionText)
          if (!unclosedTag && config.prefill_thinking && !completionText.includes('</thinking>')) {
            unclosedTag = 'thinking'
          }
          if (unclosedTag) {
            completion = await this.continueCompletionAfterStopSequence(
              continuationRequest,
              completion,
              triggeredStopSequence,
              config
            )
          }
        }
        // If stopped on participant name OUTSIDE function_calls, don't continue
        // The check later will return early
      }
      
      // Prepend thinking tag if prefilled
      if (config.prefill_thinking && accumulatedOutput === '') {
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
          
          // Persist all pending tool uses with the final accumulated output
          for (const { call, result } of pendingToolPersistence) {
            call.originalCompletionText = accumulatedOutput
            await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
          }
          
          // Send any remaining text and track context
          const displayText = this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput)).stripped
          const sentSoFarLen = lastContextEndPos > 0 
            ? this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput.slice(0, lastContextEndPos))).stripped.length 
            : 0
          const remainingText = displayText.slice(sentSoFarLen).trim()
          if (remainingText) {
            const finalMsgIds = await this.connector.sendMessage(channelId, remainingText, allSentMessageIds.length === 0 ? triggeringMessageId : undefined)
            allSentMessageIds.push(...finalMsgIds)
            finalMsgIds.forEach(id => this.botMessageIds.add(id))
            // Context chunk for final message is everything from lastContextEndPos
            const finalContext = accumulatedOutput.slice(lastContextEndPos)
            for (const msgId of finalMsgIds) {
              messageContexts[msgId] = finalContext
            }
          }
          
          return {
            completion: {
              content: [{ type: 'text', text: displayText }],
              stopReason: completion.stopReason,
              usage: completion.usage,
              model: completion.model,
            },
            toolCallIds: allToolCallIds,
            preambleMessageIds: allPreambleMessageIds,
            fullCompletionText: accumulatedOutput,
            sentMessageIds: allSentMessageIds,
            messageContexts,
          }
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
        
        // Persist all pending tool uses with the final accumulated output
        for (const { call, result } of pendingToolPersistence) {
          call.originalCompletionText = accumulatedOutput
          await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
        }
        
        // Done - send any remaining text and return
        const displayText = this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput)).stripped
        // Calculate remaining text that hasn't been sent yet
        const sentSoFar = lastContextEndPos > 0 
          ? this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput.slice(0, lastContextEndPos))).stripped.length 
          : 0
        const remainingText = displayText.slice(sentSoFar).trim()
        if (remainingText) {
          const finalMsgIds = await this.connector.sendMessage(channelId, remainingText, allSentMessageIds.length === 0 ? triggeringMessageId : undefined)
          allSentMessageIds.push(...finalMsgIds)
          finalMsgIds.forEach(id => this.botMessageIds.add(id))
          // Context chunk for final message
          const finalContext = accumulatedOutput.slice(lastContextEndPos)
          for (const msgId of finalMsgIds) {
            messageContexts[msgId] = finalContext
          }
        }
        
        return {
          completion: {
            content: [{ type: 'text', text: displayText }],
            stopReason: completion.stopReason,
            usage: completion.usage,
            model: completion.model,
          },
          toolCallIds: allToolCallIds,
          preambleMessageIds: allPreambleMessageIds,
          fullCompletionText: accumulatedOutput,
          sentMessageIds: allSentMessageIds,
          messageContexts,
        }
      }
      
      // Execute tools and collect results
      logger.debug({ 
        toolCount: toolParse.calls.length, 
        toolDepth 
      }, 'Executing inline tools')
      
      // PROGRESSIVE DISPLAY: Send the visible text before tool calls to Discord
      // Strip both tool XML and thinking blocks to get display text
      const strippedToolXml = this.toolSystem.stripToolXml(toolParse.beforeText)
      const visibleBeforeText = this.stripThinkingBlocks(strippedToolXml).stripped.trim()
      let sentMsgIdsThisRound: string[] = []
      
      if (visibleBeforeText) {
        // Send the pre-tool visible text as a message
        sentMsgIdsThisRound = await this.connector.sendMessage(
          channelId, 
          visibleBeforeText, 
          toolDepth === 0 ? triggeringMessageId : undefined  // Only reply to trigger on first message
        )
        allSentMessageIds.push(...sentMsgIdsThisRound)
        sentMsgIdsThisRound.forEach(id => this.botMessageIds.add(id))
        
        logger.debug({ 
          messageIds: sentMsgIdsThisRound, 
          textLength: visibleBeforeText.length 
        }, 'Sent pre-tool message to Discord')
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
          
          const toolMessage = `.${config.innerName}>[${call.name}]: ${inputStr}\n.${config.innerName}<[${call.name}]: ${trimmedOutput}`
          await this.connector.sendWebhook(channelId, toolMessage, config.innerName)
        }
      }
      
      // Inject results after the function_calls block
      const resultsText = resultsTexts.join('\n\n---\n\n')
      const newAccumulated = toolParse.beforeText + toolParse.fullMatch + 
        this.toolSystem.formatToolResultForInjection('', resultsText)
      
      // CONTEXT TRACKING: Associate sent messages with their context chunks
      // The context chunk is everything from lastContextEndPos to current position (after tool result)
      if (sentMsgIdsThisRound.length > 0) {
        const contextChunk = newAccumulated.slice(lastContextEndPos)
        for (const msgId of sentMsgIdsThisRound) {
          messageContexts[msgId] = contextChunk
        }
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
    
    // Persist all pending tool uses with the final accumulated output
    for (const { call, result } of pendingToolPersistence) {
      call.originalCompletionText = accumulatedOutput
      await this.toolSystem.persistToolUse(this.botId, channelId, call, result)
    }
    
    // Send any remaining text
    const displayText = this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput)).stripped
    const sentSoFar = lastContextEndPos > 0 
      ? this.stripThinkingBlocks(this.toolSystem.stripToolXml(accumulatedOutput.slice(0, lastContextEndPos))).stripped.length 
      : 0
    const remainingText = displayText.slice(sentSoFar).trim()
    if (remainingText) {
      const finalMsgIds = await this.connector.sendMessage(channelId, remainingText + '\n[Max tool depth reached]', allSentMessageIds.length === 0 ? triggeringMessageId : undefined)
      allSentMessageIds.push(...finalMsgIds)
      finalMsgIds.forEach(id => this.botMessageIds.add(id))
      const finalContext = accumulatedOutput.slice(lastContextEndPos) + '\n[Max tool depth reached]'
      for (const msgId of finalMsgIds) {
        messageContexts[msgId] = finalContext
      }
    }
    
    return {
      completion: {
        content: [{ type: 'text', text: displayText + '\n[Max tool depth reached]' }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: '',
      },
      toolCallIds: allToolCallIds,
      preambleMessageIds: allPreambleMessageIds,
      fullCompletionText: accumulatedOutput + '\n[Max tool depth reached]',
      sentMessageIds: allSentMessageIds,
      messageContexts,
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
    
    if (lastMsg && lastMsg.participant === config.innerName) {
      // Replace the last empty message with accumulated output
      request.messages[request.messages.length - 1] = {
        ...lastMsg,
        content: [{ type: 'text', text: trimmedOutput }],
      }
    } else {
      // Add accumulated output as new message
      request.messages.push({
        participant: config.innerName,
        content: [{ type: 'text', text: trimmedOutput }],
      })
    }
    
    return request
  }

  private async executeWithTools(
    llmRequest: any,
    config: BotConfig,
    channelId: string,
    triggeringMessageId: string,
    activationId?: string  // Optional activation ID for recording completions
  ): Promise<{ 
    completion: any; 
    toolCallIds: string[]; 
    preambleMessageIds: string[]; 
    fullCompletionText?: string;
    sentMessageIds?: string[];
    messageContexts?: Record<string, string>;
  }> {
    let depth = 0
    let currentRequest = llmRequest
    let allToolResults: Array<{ call: any; result: any }> = []
    let allToolCallIds: string[] = []
    let allPreambleMessageIds: string[] = []

    while (depth < config.max_tool_depth) {
      let completion = await this.llmMiddleware.complete(currentRequest)

      // Handle stop sequence mid-XML-block: continue the completion
      // This can happen when participant names appear inside tool call arguments or thinking blocks
      if (completion.stopReason === 'stop_sequence' && config.mode === 'prefill') {
        const completionText = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')
        
        // Check if there's an unclosed XML tag (tool call or thinking)
        // When prefill_thinking is enabled, the <thinking> tag was prefilled and won't be in the completion
        // So we need to check if we're still inside a thinking block (no </thinking> found)
        let unclosedTag = this.detectUnclosedXmlTag(completionText)
        if (!unclosedTag && config.prefill_thinking && !completionText.includes('</thinking>')) {
          unclosedTag = 'thinking'  // Prefilled thinking tag is still open
        }
        
        if (unclosedTag) {
          const triggeredStopSequence = completion.raw?.stop_sequence
          logger.warn({ 
            unclosedTag, 
            triggeredStopSequence,
            textLength: completionText.length 
          }, 'Stop sequence fired mid-XML-block, continuing completion')
          
          if (triggeredStopSequence) {
            // Continue the completion: append stop sequence and call again
            completion = await this.continueCompletionAfterStopSequence(
              currentRequest,
              completion,
              triggeredStopSequence,
              config
            )
          }
        }
      }

      // If prefill_thinking was enabled, prepend <thinking> to the first text block
      // (the prefilled <thinking> isn't in the completion, only the content and </thinking>)
      if (config.prefill_thinking) {
        const firstTextBlock = completion.content.find((c: any) => c.type === 'text') as any
        if (firstTextBlock?.text) {
          firstTextBlock.text = '<thinking>' + firstTextBlock.text
        }
      }

      // Get full completion text for recording
      const fullCompletionText = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
        
      // Check for tool use (native tool_use blocks in chat mode)
      let toolUseBlocks = completion.content.filter((c) => c.type === 'tool_use')

      // In prefill mode, also parse tool calls from text (XML format)
      if (toolUseBlocks.length === 0 && config.mode === 'prefill') {
        const parsedResults = this.toolSystem.parseToolCalls(fullCompletionText, fullCompletionText)
        
        if (parsedResults.length > 0) {
          logger.debug({ parsedCount: parsedResults.length }, 'Parsed tool calls from prefill text')
          // Convert parsed calls to tool_use blocks, preserving original text
          toolUseBlocks = parsedResults.map(pr => ({
            type: 'tool_use' as const,
            id: pr.call.id,
            name: pr.call.name,
            input: pr.call.input,
            originalText: pr.originalText,
          }))
        }
      }

      if (toolUseBlocks.length === 0) {
        // No tools, return completion (final completion will be recorded by handleActivation)
        return { completion, toolCallIds: allToolCallIds, preambleMessageIds: allPreambleMessageIds }
      }

      // Execute tools
      logger.debug({ toolCount: toolUseBlocks.length, depth }, 'Executing tools')

      // In prefill mode, send any text before the tool call to Discord
      // (e.g., "Let me search for that" before <tool_call>{}</tool_call>)
      // Track preamble message IDs so they can be filtered from context later
      // (the tool cache has the full completion with tool call)
      if (config.mode === 'prefill') {
        const textContent = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
        
        // Extract thinking content (respecting backtick escaping)
        const { content: thinkingContents } = this.stripThinkingBlocks(textContent)
        
        // Send thinking content if debug_thinking is enabled
        if (config.debug_thinking && thinkingContents.length > 0) {
          const thinkingContent = thinkingContents.join('\n\n---\n\n')
          const thinkingDebugContent = `.💭 ${thinkingContent}`
          if (thinkingDebugContent.length <= 1800) {
            await this.connector.sendMessage(channelId, thinkingDebugContent, triggeringMessageId)
          } else {
            await this.connector.sendMessageWithAttachment(
              channelId,
              '.💭',
              { name: 'thinking.txt', content: thinkingContent },
              triggeringMessageId
            )
          }
        }
        
        // Strip tool call XML and thinking from text to get the "preamble"
        const preamble = this.stripToolCallsFromText(textContent, toolUseBlocks)
        let preambleIds: string[] = []
        if (preamble.trim()) {
          logger.debug({ preambleLength: preamble.length }, 'Sending tool call preamble to Discord')
          preambleIds = await this.connector.sendMessage(channelId, preamble.trim(), triggeringMessageId)
          allPreambleMessageIds.push(...preambleIds)
        }
        
        // Record this completion to activation (tool call completion)
        // sentMessageIds = preamble messages (could be empty if no preamble/all thinking = phantom)
        if (activationId && config.preserve_thinking_context) {
          this.activationStore.addCompletion(
            activationId,
            fullCompletionText,
            preambleIds,
            [], // Tool calls tracked separately for now
            []
          )
        }
      }

      const toolResults: Array<{ call: any; result: any }> = []

      for (const block of toolUseBlocks) {
          const toolUse = block as any
        const toolCall = {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
          messageId: triggeringMessageId,
          timestamp: new Date(),
          originalCompletionText: (toolUse as any).originalText || '',
        }

        const toolStartTime = Date.now()
        const result = await this.toolSystem.executeTool(toolCall)
        const toolDurationMs = Date.now() - toolStartTime

        // Persist tool use (legacy - keep for backwards compatibility during migration)
        await this.toolSystem.persistToolUse(
          this.botId,
          channelId,
          toolCall,
          result
        )

        toolResults.push({ call: toolCall, result: result.output })
        allToolCallIds.push(toolCall.id)
        
        // Record tool execution to trace
        const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
        traceToolExecution({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
          output: outputStr.length > 1000 ? outputStr.slice(0, 1000) + '...' : outputStr,
          outputTruncated: outputStr.length > 1000,
          fullOutputLength: outputStr.length,
          durationMs: toolDurationMs,
          sentToDiscord: config.tool_output_visible,
          error: result.error ? String(result.error) : undefined,
        })

        // Send tool output to Discord if visible (with period prefix to hide from bots)
        if (config.tool_output_visible) {
          // Format input (compact)
          const inputStr = JSON.stringify(toolCall.input)
          
          // Format output: remove newlines, trim if large, show length
          const rawOutput = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
          const flatOutput = rawOutput.replace(/\n/g, ' ').replace(/\s+/g, ' ')
          const maxLen = 200
          const trimmedOutput = flatOutput.length > maxLen 
            ? `${flatOutput.slice(0, maxLen)}... (${rawOutput.length} chars)`
            : flatOutput
          
          const toolMessage = `.${config.innerName}>[${toolCall.name}]: ${inputStr}\n.${config.innerName}<[${toolCall.name}]: ${trimmedOutput}`
          await this.connector.sendWebhook(channelId, toolMessage, config.innerName)
        }
      }

      allToolResults.push(...toolResults)

      // Add bot's completion (with XML tool call intact)
      const completionText = completion.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      
      currentRequest.messages.push({
        participant: config.innerName,
        content: [{ type: 'text', text: completionText }],
      })

      // Add tool result messages from System
      const toolResultMessages = this.contextBuilder.formatToolResults(toolResults)
      currentRequest.messages.push(...toolResultMessages)

      // Add empty message for next completion
      currentRequest.messages.push({
        participant: config.innerName,
        content: [{ type: 'text', text: '' }],
      })

      depth++
    }

    logger.warn('Reached max tool depth')
    return { 
      completion: {
      content: [{ type: 'text', text: '[Max tool depth reached]' }], 
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 0, outputTokens: 0 }, 
      model: '' 
      },
      toolCallIds: allToolCallIds,
      preambleMessageIds: allPreambleMessageIds
    }
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
      if (lastMessage?.participant === config.innerName) {
        // Append to existing prefill
        const existingText = lastMessage.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')
        lastMessage.content = [{ type: 'text', text: existingText + accumulatedText }]
      } else {
        // Add new assistant message
        continuationRequest.messages.push({
          participant: config.innerName,
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
        // Also check for prefilled thinking tag (no </thinking> means still open)
        if (!unclosedTag && config.prefill_thinking && !accumulatedText.includes('</thinking>')) {
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

