/**
 * Tool System
 * Wraps MCP client, plugin tools, and handles JSONL persistence
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolDefinition, ToolCall, ToolResult, ToolError, MCPServerConfig } from '../types.js'
import { logger } from '../utils/logger.js'
import { availablePlugins, PluginTool, PluginContext, ToolPlugin, PluginStateContext } from './plugins/index.js'

export class ToolSystem {
  private mcpClients = new Map<string, Client>()
  private tools: ToolDefinition[] = []
  private pluginHandlers = new Map<string, PluginTool['handler']>()
  private loadedPlugins: string[] = []
  private loadedPluginObjects = new Map<string, ToolPlugin>()
  private pluginContext: Partial<PluginContext> = {}
  private pluginContextFactory: any = null  // PluginContextFactory, typed as any to avoid circular import
  private pluginConfigs: Record<string, any> = {}  // Per-plugin configs

  constructor(private toolCacheDir: string) {}

  /**
   * Load tool plugins by name
   */
  loadPlugins(pluginNames: string[]): void {
    for (const name of pluginNames) {
      if (this.loadedPlugins.includes(name)) {
        continue  // Already loaded
      }
      
      const plugin = availablePlugins[name]
      if (!plugin) {
        logger.warn({ plugin: name }, 'Plugin not found')
        continue
      }
      
      // Register each tool from the plugin
      for (const tool of plugin.tools) {
        this.tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverName: `plugin:${name}`,
        })
        this.pluginHandlers.set(tool.name, tool.handler)
      }
      
      this.loadedPlugins.push(name)
      this.loadedPluginObjects.set(name, plugin)
      logger.info({ 
        plugin: name, 
        tools: plugin.tools.map(t => t.name),
        hasContextInjection: !!plugin.getContextInjections,
      }, 'Loaded plugin')
    }
  }
  
  /**
   * Get loaded plugin objects (for context injection)
   */
  getLoadedPluginObjects(): Map<string, ToolPlugin> {
    return this.loadedPluginObjects
  }

  /**
   * Set context for plugin execution
   */
  setPluginContext(context: Partial<PluginContext>): void {
    this.pluginContext = { ...this.pluginContext, ...context }
  }
  
  /**
   * Set plugin context factory for creating plugin-specific state contexts
   */
  setPluginContextFactory(factory: any, pluginConfigs?: Record<string, any>): void {
    this.pluginContextFactory = factory
    this.pluginConfigs = pluginConfigs || {}
  }

  /**
   * Initialize MCP clients from configuration
   */
  async initializeServers(serverConfigs: MCPServerConfig[]): Promise<void> {
    if (!serverConfigs || serverConfigs.length === 0) {
      logger.info('No MCP servers configured, tools disabled')
      return
    }

    logger.info({ serverCount: serverConfigs.length }, 'Initializing MCP servers')

    for (const config of serverConfigs) {
      try {
        await this.initializeServer(config)
      } catch (error) {
        logger.error({ error, server: config.name }, 'Failed to initialize MCP server')
        // Continue with other servers
      }
    }

    logger.info({ 
      serverCount: this.mcpClients.size, 
      toolCount: this.tools.length 
    }, 'MCP initialization complete')
  }

  private async initializeServer(config: MCPServerConfig): Promise<void> {
    logger.info({ 
      server: config.name, 
      command: config.command, 
      args: config.args 
    }, 'Initializing MCP server')

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env,
    })

    const client = new Client({
      name: 'chapter3',
      version: '0.1.0',
    }, {
      capabilities: {}
    })

    await client.connect(transport)

    // Load tools from this server
    const response = await client.listTools()
    const serverTools: ToolDefinition[] = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as any,
      serverName: config.name,
    }))

    this.mcpClients.set(config.name, client)
    this.tools.push(...serverTools)

    logger.info({ 
      server: config.name, 
      toolCount: serverTools.length 
    }, 'MCP server initialized')
  }


  /**
   * Get available tools
   */
  getAvailableTools(): ToolDefinition[] {
    return this.tools
  }

  /**
   * Get names of all available tools
   */
  getToolNames(): string[] {
    return this.tools.map(t => t.name)
  }

  /**
   * Load tool cache from JSONL files (with results)
   * @param existingMessageIds - Optional set of Discord message IDs that exist. 
   *                            Entries with botMessageIds not in this set are filtered out.
   */
  async loadCacheWithResults(
    botId: string, 
    channelId: string,
    existingMessageIds?: Set<string>
  ): Promise<Array<{call: ToolCall, result: any}>> {
    const dirPath = join(this.toolCacheDir, botId, channelId)

    if (!existsSync(dirPath)) {
      return []
    }

    // Read all JSONL files in the directory
    const fs = await import('fs/promises')
    const files = await fs.readdir(dirPath)
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort()

    const allEntries: Array<{call: ToolCall, result: any}> = []
    let filteredCount = 0

    for (const file of jsonlFiles) {
      const filePath = join(dirPath, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.trim().split('\n').filter((l) => l.trim())

        for (const line of lines) {
          const entry = JSON.parse(line)
          
          // Filter out entries where bot messages were deleted (or missing botMessageIds)
          const botMsgIds = entry.call.botMessageIds as string[] | undefined
          if (existingMessageIds) {
            if (!botMsgIds || botMsgIds.length === 0) {
              // Old entry without botMessageIds - skip it (can't verify existence)
              filteredCount++
              logger.debug({ 
                toolCallId: entry.call.id
              }, 'Filtering out tool cache entry - no botMessageIds (legacy entry)')
              continue
            }
            // Check if at least one bot message still exists
            const hasExistingMessage = botMsgIds.some(id => existingMessageIds.has(id))
            if (!hasExistingMessage) {
              filteredCount++
              logger.debug({ 
                toolCallId: entry.call.id, 
                botMessageIds: botMsgIds 
              }, 'Filtering out tool cache entry - bot messages deleted')
              continue
            }
          }
          
          // Truncate large results to prevent context bloat
          let result = entry.result.output
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
          if (resultStr.length > 2000) {
            result = resultStr.substring(0, 2000) + '\n...[truncated]'
          }
          
          allEntries.push({
            call: {
              id: entry.call.id,
              name: entry.call.name,
              input: entry.call.input,
              messageId: entry.call.messageId,
              timestamp: new Date(entry.timestamp),
              originalCompletionText: entry.call.originalCompletionText || '',
              botMessageIds: botMsgIds,
            },
            result
          })
        }
      } catch (error) {
        logger.warn({ error, file: filePath }, 'Failed to load tool cache file')
      }
    }

    // Limit to last 5 tool calls to prevent context bloat
    const limitedEntries = allEntries.slice(-5)

    logger.debug({ 
      botId, 
      channelId, 
      total: allEntries.length,
      filtered: filteredCount,
      returned: limitedEntries.length
    }, 'Loaded tool cache with results')

    return limitedEntries
  }

  /**
   * Legacy method for backward compatibility
   */
  async loadCache(botId: string, channelId: string): Promise<ToolCall[]> {
    const entries = await this.loadCacheWithResults(botId, channelId)
    return entries.map(e => e.call)
  }

  // Anthropic-style XML tag constants (assembled to avoid triggering stop sequences)
  private static readonly FUNC_CALLS_OPEN = '<' + 'antml:function_calls>'
  private static readonly FUNC_CALLS_CLOSE = '</' + 'antml:function_calls>'
  private static readonly INVOKE_OPEN = '<' + 'antml:invoke'
  private static readonly INVOKE_CLOSE = '</' + 'antml:invoke>'
  private static readonly PARAM_OPEN = '<' + 'antml:parameter'
  private static readonly PARAM_CLOSE = '</' + 'antml:parameter>'
  private static readonly FUNC_RESULTS_OPEN = '<' + 'function_results>'
  private static readonly FUNC_RESULTS_CLOSE = '</' + 'function_results>'

  /**
   * Parse Anthropic-style tool calls from completion text
   * Format:
   *   [antml:function_calls]
   *   [antml:invoke name="tool_name"]
   *   [antml:parameter name="param"]value[/antml:parameter]
   *   [/antml:invoke]
   *   [/antml:function_calls]
   * 
   * Returns the first complete function_calls block found, or null if none/incomplete.
   * Also returns the text before and after the block for continuation.
   */
  parseAnthropicToolCalls(completion: string): {
    calls: ToolCall[],
    beforeText: string,
    afterText: string,
    fullMatch: string,
  } | null {
    // Build regex patterns from constants (avoid literal tags in source)
    const openTag = ToolSystem.FUNC_CALLS_OPEN.replace(/[<>]/g, '\\$&')
    const closeTag = ToolSystem.FUNC_CALLS_CLOSE.replace(/[<>]/g, '\\$&')
    
    // Match the entire function_calls block
    const blockPattern = new RegExp(openTag + '([\\s\\S]*?)' + closeTag)
    const blockMatch = completion.match(blockPattern)
    
    if (!blockMatch) {
      // Check if there's an incomplete block (opened but not closed)
      if (completion.includes(ToolSystem.FUNC_CALLS_OPEN) && 
          !completion.includes(ToolSystem.FUNC_CALLS_CLOSE)) {
        return null  // Incomplete - need more tokens
      }
      return null  // No tool calls
    }
    
    const fullMatch = blockMatch[0]
    const blockContent = blockMatch[1]!
    const beforeText = completion.slice(0, completion.indexOf(fullMatch))
    const afterText = completion.slice(completion.indexOf(fullMatch) + fullMatch.length)
    
    // Parse individual invoke blocks
    // Build patterns dynamically to avoid stop sequences in source
    const invokeOpenPat = '<' + 'antml:invoke\\s+name="([^"]+)">'
    const invokeClosePat = '</' + 'antml:invoke>'
    const invokePattern = new RegExp(invokeOpenPat + '([\\s\\S]*?)' + invokeClosePat, 'g')
    const calls: ToolCall[] = []
    let invokeMatch
    
    while ((invokeMatch = invokePattern.exec(blockContent)) !== null) {
      const toolName = invokeMatch[1]!
      const invokeContent = invokeMatch[2]!
      
      // Parse parameters - build pattern dynamically
      const paramOpenPat = '<' + 'antml:parameter\\s+name="([^"]+)">'
      const paramClosePat = '</' + 'antml:parameter>'
      const paramPattern = new RegExp(paramOpenPat + '([^<]*)' + paramClosePat, 'g')
      const input: Record<string, any> = {}
      let paramMatch
      
      while ((paramMatch = paramPattern.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1]!
        let paramValue: any = paramMatch[2]!
        
        // Try to parse as JSON, otherwise keep as string
        try {
          paramValue = JSON.parse(paramValue)
        } catch {
          // Keep as string
        }
        
        input[paramName] = paramValue
      }
      
      calls.push({
        id: this.generateToolCallId(),
        name: toolName,
        input,
        messageId: '',
        timestamp: new Date(),
        originalCompletionText: completion,
      })
      
      logger.debug({ toolName, input }, 'Parsed Anthropic-style tool call')
    }
    
    return { calls, beforeText, afterText, fullMatch }
  }

  /**
   * Format tool result for injection into completion (Anthropic style)
   */
  formatToolResultForInjection(toolName: string, result: string): string {
    return '\n\n' + ToolSystem.FUNC_RESULTS_OPEN + '\n' + result + '\n' + ToolSystem.FUNC_RESULTS_CLOSE + '\n\n'
  }

  /**
   * Check if completion has an incomplete tool call block (opened but not closed)
   */
  hasIncompleteToolCall(completion: string): boolean {
    const hasOpen = completion.includes(ToolSystem.FUNC_CALLS_OPEN)
    const hasClose = completion.includes(ToolSystem.FUNC_CALLS_CLOSE)
    return hasOpen && !hasClose
  }

  /**
   * Parse tool calls from completion text (for prefill mode) - LEGACY FORMAT
   * Looks for XML-formatted tool calls like: <tool_name>{"param": "value"}</tool_name>
   * Also handles empty calls: <tool_name></tool_name> or <tool_name>{}</tool_name>
   * Skips tool calls that are escaped (wrapped in backticks or inside code blocks)
   */
  parseToolCalls(completion: string, originalText: string): Array<{call: ToolCall, originalText: string}> {
    const results: Array<{call: ToolCall, originalText: string}> = []

    // First, mask out code blocks and inline code to avoid parsing escaped tool calls
    // Replace ``` blocks and `inline` with placeholder that won't match
    const masked = completion
      .replace(/```[\s\S]*?```/g, '[CODE_BLOCK]')
      .replace(/`[^`]+`/g, '[INLINE_CODE]')

    // Pattern: <tool_name>optional_json</tool_name>
    // Matches: <foo>{}</foo>, <foo>{"a":1}</foo>, <foo></foo>, <foo>  </foo>
    const pattern = /<(\w+)>\s*(\{[\s\S]*?\})?\s*<\/\1>/g
    let match

    while ((match = pattern.exec(masked)) !== null) {
      const toolName = match[1]
      const jsonInput = match[2]  // May be undefined for empty tags

      if (!toolName) {
        continue
      }
      
      // Check if this tool name exists in our known tools
      const knownTool = this.tools.find(t => t.name === toolName)
      if (!knownTool) {
        // Not a known tool - might be regular XML in the conversation, skip it
        logger.trace({ toolName }, 'Skipping unknown tool name (might be regular XML)')
        continue
      }

      try {
        // Parse JSON or default to empty object
        const input = jsonInput ? JSON.parse(jsonInput.trim()) : {}
        
        results.push({
          call: {
            id: this.generateToolCallId(),
            name: toolName,
            input,
            messageId: '',  // Will be set later by Agent Loop
            timestamp: new Date(),
            originalCompletionText: originalText,
          },
          originalText
        })
        
        logger.debug({ toolName, input, hadJson: !!jsonInput }, 'Parsed tool call from XML')
      } catch (error) {
        logger.warn({ error, match: match[0] }, 'Failed to parse tool call JSON')
      }
    }

    return results
  }

  /**
   * Execute a tool (plugin or MCP)
   */
  async executeTool(call: ToolCall): Promise<ToolResult> {
    // Check if this is a plugin tool
    const pluginHandler = this.pluginHandlers.get(call.name)
    if (pluginHandler) {
      try {
        logger.debug({ call, type: 'plugin' }, 'Executing plugin tool')
        
        const context: PluginContext = {
          botId: this.pluginContext.botId || '',
          channelId: this.pluginContext.channelId || '',
          guildId: this.pluginContext.guildId || '',
          currentMessageId: this.pluginContext.currentMessageId || '',
          config: this.pluginContext.config || {},
          sendMessage: this.pluginContext.sendMessage || (async () => []),
          pinMessage: this.pluginContext.pinMessage || (async () => {}),
        }
        
        let result = await pluginHandler(call.input, context)
        
        // Call lifecycle hooks for plugins that own this tool
        const toolDef = this.tools.find(t => t.name === call.name)
        if (toolDef?.serverName?.startsWith('plugin:')) {
          const pluginName = toolDef.serverName.replace('plugin:', '')
          const plugin = this.loadedPluginObjects.get(pluginName)
          
          if (this.pluginContextFactory) {
            try {
              // Get plugin-specific config
              const pluginConfig = this.pluginConfigs[pluginName]
              
              // Create a plugin-specific state context
              const pluginStateContext = this.pluginContextFactory.createStateContext(
                pluginName,
                context,
                undefined,  // inheritanceInfo
                undefined,  // epicReducer
                pluginConfig
              )
              
              // Call onToolExecution hook
              if (plugin?.onToolExecution) {
                await plugin.onToolExecution(call.name, call.input, result, pluginStateContext)
                logger.debug({ pluginName, toolName: call.name }, 'Called onToolExecution hook')
              }
              
              // Call postProcessResult hook to allow enriching the result
              if (plugin?.postProcessResult) {
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
                result = await plugin.postProcessResult(call.name, call.input, resultStr, pluginStateContext)
                logger.debug({ pluginName, toolName: call.name }, 'Called postProcessResult hook')
              }
            } catch (hookError) {
              logger.error({ hookError, pluginName, toolName: call.name }, 'Plugin hook failed')
            }
          }
        }
        
        return {
          callId: call.id,
          output: typeof result === 'string' ? result : JSON.stringify(result),
          timestamp: new Date(),
        }
      } catch (error: any) {
        const errorMessage = error?.message || error?.toString() || 'Unknown error'
        logger.error({ 
          error: { message: errorMessage, stack: error?.stack, name: error?.name },
          call 
        }, 'Plugin tool execution failed')
        return {
          callId: call.id,
          output: '',
          error: errorMessage,
          timestamp: new Date(),
        }
      }
    }

    // MCP tool execution
    if (this.mcpClients.size === 0 && this.pluginHandlers.size === 0) {
      throw new ToolError('No tools initialized')
    }

    try {
      // Find which server provides this tool
      const toolDef = this.tools.find((t) => t.name === call.name)
      const serverName = toolDef?.serverName || 'default'
      const client = this.mcpClients.get(serverName) || this.mcpClients.values().next().value

      if (!client) {
        throw new ToolError(`No MCP client found for tool: ${call.name}`)
      }

      logger.debug({ call, server: serverName }, 'Executing MCP tool')

      const result = await client.callTool({
        name: call.name,
        arguments: call.input,
      })

      return {
        callId: call.id,
        output: result.content,
        timestamp: new Date(),
      }
    } catch (error) {
      logger.error({ error, call }, 'Tool execution failed')

      return {
        callId: call.id,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      }
    }
  }

  /**
   * Persist tool use to JSONL file
   */
  async persistToolUse(
    botId: string,
    channelId: string,
    call: ToolCall,
    result: ToolResult
  ): Promise<void> {
    const now = new Date()
    const hour = now.toISOString().substring(0, 13).replace(/:/g, '-')
    const fileName = `${hour}.jsonl`
    const dirPath = join(this.toolCacheDir, botId, channelId)
    const filePath = join(dirPath, fileName)

    // Ensure directory exists
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }

    const entry = {
      call: {
        id: call.id,
        name: call.name,
        input: call.input,
        messageId: call.messageId,
        originalCompletionText: call.originalCompletionText,
        botMessageIds: call.botMessageIds,  // May be undefined, will be updated later
      },
      result: {
        output: result.output,
        error: result.error,
      },
      timestamp: result.timestamp.toISOString(),
    }

    try {
      appendFileSync(filePath, JSON.stringify(entry) + '\n')
      logger.debug({ botId, channelId, tool: call.name }, 'Persisted tool use')
    } catch (error) {
      logger.error({ error, filePath }, 'Failed to persist tool use')
    }
  }

  /**
   * Update tool cache entries with bot message IDs
   * Called after activation completes and we know which Discord messages were sent
   */
  async updateBotMessageIds(
    botId: string,
    channelId: string,
    toolCallIds: string[],
    botMessageIds: string[]
  ): Promise<void> {
    if (toolCallIds.length === 0 || botMessageIds.length === 0) return
    
    const dirPath = join(this.toolCacheDir, botId, channelId)
    if (!existsSync(dirPath)) return
    
    // Read all JSONL files and update matching entries
    const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
    
    for (const file of files) {
      const filePath = join(dirPath, file)
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l)
      
      let modified = false
      const updatedLines = lines.map(line => {
        try {
          const entry = JSON.parse(line)
          if (toolCallIds.includes(entry.call?.id) && !entry.call?.botMessageIds) {
            entry.call.botMessageIds = botMessageIds
            modified = true
            return JSON.stringify(entry)
          }
          return line
        } catch {
          return line
        }
      })
      
      if (modified) {
        writeFileSync(filePath, updatedLines.join('\n') + '\n')
        logger.debug({ botId, channelId, file, toolCallIds }, 'Updated tool cache with bot message IDs')
      }
    }
  }

  /**
   * Remove tool cache entries associated with a deleted bot message
   * Called when a bot message is deleted from Discord
   */
  async removeEntriesByBotMessageId(
    botId: string,
    channelId: string,
    deletedMessageId: string
  ): Promise<void> {
    const dirPath = join(this.toolCacheDir, botId, channelId)
    if (!existsSync(dirPath)) return
    
    const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
    let totalRemoved = 0
    
    for (const file of files) {
      const filePath = join(dirPath, file)
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l)
      
      const filteredLines = lines.filter(line => {
        try {
          const entry = JSON.parse(line)
          const botMsgIds = entry.call?.botMessageIds as string[] | undefined
          if (botMsgIds && botMsgIds.includes(deletedMessageId)) {
            totalRemoved++
            logger.debug({ 
              toolCallId: entry.call?.id,
              deletedMessageId 
            }, 'Removing tool cache entry - bot message deleted')
            return false  // Remove this entry
          }
          return true
        } catch {
          return true
        }
      })
      
      if (filteredLines.length < lines.length) {
        if (filteredLines.length === 0) {
          // Delete empty file
          const { unlinkSync } = require('fs')
          unlinkSync(filePath)
        } else {
          writeFileSync(filePath, filteredLines.join('\n') + '\n')
        }
      }
    }
    
    if (totalRemoved > 0) {
      logger.info({ botId, channelId, deletedMessageId, entriesRemoved: totalRemoved }, 
        'Removed tool cache entries for deleted bot message')
    }
  }

  /**
   * Close all MCP clients
   */
  async close(): Promise<void> {
    for (const [name, client] of this.mcpClients.entries()) {
      try {
        await client.close()
        logger.info({ server: name }, 'MCP client closed')
      } catch (error) {
        logger.warn({ error, server: name }, 'Error closing MCP client')
      }
    }
    this.mcpClients.clear()
  }

  private generateToolCallId(): string {
    return `call_${Date.now()}_${Math.random().toString(36).substring(7)}`
  }
}

