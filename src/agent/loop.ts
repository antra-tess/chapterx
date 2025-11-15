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
import { Event, BotConfig } from '../types.js'
import { logger, startActivationLogging, stopActivationLogging } from '../utils/logger.js'
import { sleep } from '../utils/retry.js'

export class AgentLoop {
  private running = false
  private botUserId?: string
  private botMessageIds = new Set<string>()  // Track bot's own message IDs
  private mcpInitialized = false
  private activeChannels = new Set<string>()  // Track channels currently being processed

  constructor(
    private botId: string,
    private queue: EventQueue,
    private connector: DiscordConnector,
    private stateManager: ChannelStateManager,
    private configSystem: ConfigSystem,
    private contextBuilder: ContextBuilder,
    private llmMiddleware: LLMMiddleware,
    private toolSystem: ToolSystem
  ) {}

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

    // Check if activation is needed
    if (!await this.shouldActivate(events, firstEvent.channelId, firstEvent.guildId)) {
      logger.debug('No activation needed')
      return
    }

    const { channelId, guildId } = firstEvent

    // Get triggering message ID for tool tracking
    const triggeringEvent = events.find((e) => e.type === 'message') as any
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
    
    this.handleActivation(channelId, guildId, triggeringMessageId)
      .catch((error) => {
        logger.error({ error, channelId, guildId }, 'Failed to handle activation')
      })
      .finally(() => {
        this.activeChannels.delete(channelId)
      })
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

  private async shouldActivate(events: Event[], channelId: string, guildId: string): Promise<boolean> {
    // Load config for random chance check
    let config: any = null
    
    // Check each message event for activation triggers
    for (const event of events) {
      if (event.type !== 'message') {
        continue
      }

      const message = event.data as any

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
        logger.debug({ messageId: message.id }, 'Activated by mention')
        return true
      }

      // 3. Check for reply to bot's message
      if (message.reference?.messageId && this.botMessageIds.has(message.reference.messageId)) {
        logger.debug({ messageId: message.id }, 'Activated by reply')
        return true
      }

      // 4. Random chance activation
      if (!config) {
        // Load config once for this batch
        try {
          const configFetch = await this.connector.fetchContext({ channelId, depth: 10 })
          config = this.configSystem.loadConfig({
            botName: this.botId,
            guildId,
            channelConfigs: configFetch.pinnedConfigs,
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

  private async handleActivation(channelId: string, guildId: string, triggeringMessageId?: string): Promise<void> {
    // Start activation-specific logging
    if (triggeringMessageId) {
      startActivationLogging(channelId, triggeringMessageId)
    }
    
    logger.info({ botId: this.botId, channelId, guildId, triggeringMessageId }, 'Bot activated')

    // Start typing indicator
    await this.connector.startTyping(channelId)

    try {
      // 1. Get or initialize channel state first (for message count)
      const toolCacheWithResults = await this.toolSystem.loadCacheWithResults(this.botId, channelId)
      const toolCache = toolCacheWithResults.map(e => e.call)
      const state = await this.stateManager.getOrInitialize(this.botId, channelId, toolCache)

      // 2. Calculate fetch depth BEFORE fetching (need big enough depth for config too)
      // Fetch enough messages to include our current context + some buffer
      let fetchDepth = 500  // Default with buffer for config + context
      
      // We'll get config from this same fetch, so no need for separate config fetch
      
      // 3. Fetch context ONCE with calculated depth (gets messages + pinned configs + images)
      const discordContext = await this.connector.fetchContext({
        channelId,
        depth: fetchDepth,
        authorized_roles: [],  // Will apply after loading config
      })
      
      // 4. Load configuration from the fetched pinned messages
      const config = this.configSystem.loadConfig({
        botName: this.botId,
        guildId: discordContext.guildId,
        channelConfigs: discordContext.pinnedConfigs,
      })

      // Initialize MCP servers from config (once per bot)
      if (!this.mcpInitialized && config.mcp_servers && config.mcp_servers.length > 0) {
        logger.info({ serverCount: config.mcp_servers.length }, 'Initializing MCP servers from config')
        await this.toolSystem.initializeServers(config.mcp_servers)
        this.mcpInitialized = true
      }

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

      // 5. Build LLM context
      const buildParams: BuildContextParams = {
        discordContext,
        toolCacheWithResults,
        lastCacheMarker: state.lastCacheMarker,
        messagesSinceRoll: state.messagesSinceRoll,
        config,
      }

      const contextResult = this.contextBuilder.buildContext(buildParams)

      // Add tools if enabled
      if (config.tools_enabled) {
        contextResult.request.tools = this.toolSystem.getAvailableTools()
      }

      // 6. Call LLM (with tool loop)
      const completion = await this.executeWithTools(
        contextResult.request, 
        config, 
        channelId,
        triggeringMessageId || ''
      )

      // 7. Stop typing
      await this.connector.stopTyping(channelId)

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

      // Strip <reply:@username> prefix if bot included it (bot responses are already Discord replies)
      const replyPattern = /^\s*<reply:@[^>]+>\s*/
      if (replyPattern.test(responseText)) {
        responseText = responseText.replace(replyPattern, '')
        logger.debug('Stripped reply prefix from bot response')
      }

      // Replace <@username> with <@USER_ID> for Discord mentions
      responseText = await this.replaceMentions(responseText, discordContext.messages)

      if (responseText.trim()) {
        // Send as reply to triggering message
        const sentMessageIds = await this.connector.sendMessage(channelId, responseText, triggeringMessageId)
        // Track bot's message IDs for reply detection
        sentMessageIds.forEach((id) => this.botMessageIds.add(id))
      } else {
        logger.warn('No text content to send in response')
      }

      // 9. Update state
      // Update cache marker if it changed
      if (contextResult.cacheMarker && contextResult.cacheMarker !== state.lastCacheMarker) {
        this.stateManager.updateCacheMarker(this.botId, channelId, contextResult.cacheMarker)
      }

      // Update message count - increment if we didn't roll, reset if we did
      if (contextResult.didRoll) {
        this.stateManager.resetMessageCount(this.botId, channelId)
        logger.debug({ channelId }, 'Context rolled, message count reset')
      } else {
        this.stateManager.incrementMessageCount(this.botId, channelId)
      }

      logger.info({ channelId, tokens: completion.usage, didRoll: contextResult.didRoll }, 'Activation complete')
    } catch (error) {
      await this.connector.stopTyping(channelId)
      throw error
    } finally {
      // Stop activation-specific logging
      stopActivationLogging()
    }
  }

  private async executeWithTools(
    llmRequest: any,
    config: BotConfig,
    channelId: string,
    triggeringMessageId: string
  ): Promise<any> {
    let depth = 0
    let currentRequest = llmRequest
    let allToolResults: Array<{ call: any; result: any }> = []

    while (depth < config.max_tool_depth) {
      const completion = await this.llmMiddleware.complete(currentRequest)

      // Check for tool use (native tool_use blocks in chat mode)
      let toolUseBlocks = completion.content.filter((c) => c.type === 'tool_use')

      // In prefill mode, also parse tool calls from text (XML format)
      if (toolUseBlocks.length === 0 && config.mode === 'prefill') {
        const textContent = completion.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
        
        const parsedResults = this.toolSystem.parseToolCalls(textContent, textContent)
        
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
        // No tools, return completion
        return completion
      }

      // Execute tools
      logger.debug({ toolCount: toolUseBlocks.length, depth }, 'Executing tools')

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

        const result = await this.toolSystem.executeTool(toolCall)

        // Persist tool use
        await this.toolSystem.persistToolUse(
          this.botId,
          channelId,
          toolCall,
          result
        )

        toolResults.push({ call: toolCall, result: result.output })

        // Send tool output to Discord if visible (with period prefix to hide from bots)
        if (config.tool_output_visible) {
          const toolMessage = `.${config.innerName}>[${toolCall.name}]: ${JSON.stringify(toolCall.input)}\n.${config.innerName}<[${toolCall.name}]: ${result.output}`
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
      content: [{ type: 'text', text: '[Max tool depth reached]' }], 
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 0, outputTokens: 0 }, 
      model: '' 
    }
  }
}

