import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolDefinition, ToolCall, ToolResult, ToolError, MCPServerConfig } from '../types.js'
import { logger } from '../utils/logger.js'
import { toolOutputText } from './output-text.js'
import { availablePlugins, PluginTool, PluginContext, ToolPlugin } from './plugins/index.js'

export class ToolSystem {
  private mcpClients = new Map<string, Client>()
  private tools: ToolDefinition[] = []
  private pluginHandlers = new Map<string, PluginTool['handler']>()
  private loadedPlugins: string[] = []
  private loadedPluginObjects = new Map<string, ToolPlugin>()
  private pluginContext: Partial<PluginContext> = {}
  private pluginContextFactory: any = null
  private pluginConfigs: Record<string, any> = {}
  private mcpResources = new Map<string, Array<{ uri: string; name: string; description?: string; mimeType?: string }>>()

  constructor(private toolCacheDir: string) {}

  loadPlugins(pluginNames: string[]): void {
    for (const name of pluginNames) {
      if (this.loadedPlugins.includes(name)) {
        continue
      }
      
      const plugin = availablePlugins[name]
      if (!plugin) {
        logger.warn({ plugin: name }, 'Plugin not found')
        continue
      }
      
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
  
  getLoadedPluginObjects(): Map<string, ToolPlugin> {
    return this.loadedPluginObjects
  }

  setPluginContext(context: Partial<PluginContext>): void {
    this.pluginContext = { ...this.pluginContext, ...context }
  }
  
  getPluginContext(): Partial<PluginContext> {
    return this.pluginContext
  }
  
  setPluginContextFactory(factory: any, pluginConfigs?: Record<string, any>): void {
    this.pluginContextFactory = factory
    this.pluginConfigs = pluginConfigs || {}
  }

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

    const toolResponse = await client.listTools()
    const serverTools: ToolDefinition[] = toolResponse.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as any,
      serverName: config.name,
    }))

    try {
      const resourceResponse = await client.listResources()
      if (resourceResponse.resources && resourceResponse.resources.length > 0) {
        const resources = resourceResponse.resources.map((r: any) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }))
        this.mcpResources.set(config.name, resources)
        logger.info({ 
          server: config.name, 
          resourceCount: resources.length,
          resources: resources.map((r: any) => r.name)
        }, 'MCP resources discovered')
      }
    } catch (e) {
      logger.debug({ server: config.name }, 'MCP server does not support resources')
    }

    this.mcpClients.set(config.name, client)
    this.tools.push(...serverTools)

    logger.info({ 
      server: config.name, 
      toolCount: serverTools.length 
    }, 'MCP server initialized')
  }

  getMcpResources(): Array<{ server: string; uri: string; name: string; description?: string }> {
    const allResources: Array<{ server: string; uri: string; name: string; description?: string }> = []
    for (const [server, resources] of this.mcpResources) {
      for (const resource of resources) {
        allResources.push({ server, ...resource })
      }
    }
    return allResources
  }

  async readMcpResource(uri: string): Promise<{ content: string; mimeType?: string } | null> {
    for (const [serverName, resources] of this.mcpResources) {
      const resource = resources.find(r => r.uri === uri)
      if (resource) {
        const client = this.mcpClients.get(serverName)
        if (client) {
          try {
            const result = await client.readResource({ uri })
            const content = result.contents?.map((c: any) => {
              if (c.text) return c.text
              if (c.blob) return `[Binary data: ${c.uri || uri}]`
              return JSON.stringify(c)
            }).join('\n') || ''
            return { content, mimeType: resource.mimeType }
          } catch (e: any) {
            logger.error({ uri, error: e.message }, 'Failed to read MCP resource')
            return null
          }
        }
      }
    }
    return null
  }


  getAvailableTools(): ToolDefinition[] {
    return this.tools.filter(tool => {
      if (tool.serverName?.startsWith('plugin:')) {
        const pluginName = tool.serverName.replace('plugin:', '')
        const pluginConfig = this.pluginConfigs[pluginName]
        if (pluginConfig?.state_scope === 'off') {
          return false
        }
      }
      return true
    })
  }

  getToolNames(): string[] {
    return this.tools.map(t => t.name)
  }

  async loadCacheWithResults(
    botId: string, 
    channelId: string,
    existingMessageIds?: Set<string>
  ): Promise<Array<{call: ToolCall, result: any, resultOmitted?: boolean}>> {
    const dirPath = join(this.toolCacheDir, botId, channelId)

    if (!existsSync(dirPath)) {
      return []
    }

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
          
          const botMsgIds = entry.call.botMessageIds as string[] | undefined
          if (existingMessageIds) {
            if (!botMsgIds || botMsgIds.length === 0) {
              filteredCount++
              logger.debug({ 
                toolCallId: entry.call.id
              }, 'Filtering out tool cache entry - no botMessageIds (legacy entry)')
              continue
            }
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
          
          let result = entry.result.output
          const resultStr = toolOutputText(result)
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
              coveredMessageIds: Array.isArray(entry.call.coveredMessageIds)
                ? entry.call.coveredMessageIds
                : undefined,
            },
            result: {
              output: result,
              error: entry.result.error,
              images: entry.result.images,
            }
          })
        }
      } catch (error) {
        logger.warn({ error, file: filePath }, 'Failed to load tool cache file')
      }
    }

    const firstWithResult = Math.max(0, allEntries.length - 5)
    const oldestTrigger = allEntries[firstWithResult]?.call.messageId
    let firstEntry = firstWithResult
    while (firstEntry > 0 && allEntries[firstEntry - 1]!.call.messageId === oldestTrigger) firstEntry--
    const limitedEntries = [
      ...allEntries.slice(firstEntry, firstWithResult).map((entry) => ({
        call: entry.call,
        result: undefined,
        resultOmitted: true,
      })),
      ...allEntries.slice(firstWithResult),
    ]

    logger.debug({ 
      botId, 
      channelId, 
      total: allEntries.length,
      filtered: filteredCount,
      returned: limitedEntries.length,
      withoutResults: firstWithResult - firstEntry,
    }, 'Loaded tool cache with results')

    return limitedEntries
  }

  async loadCache(botId: string, channelId: string): Promise<ToolCall[]> {
    const entries = await this.loadCacheWithResults(botId, channelId)
    return entries.map(e => e.call)
  }

  // Anthropic-style XML tag constants (assembled to avoid triggering stop sequences)
  // Support both antml: prefixed and plain formats
  private static readonly FUNC_CALLS_OPEN_ANTML = '<' + 'antml:function_calls>'
  private static readonly FUNC_CALLS_CLOSE_ANTML = '</' + 'antml:function_calls>'
  private static readonly FUNC_CALLS_OPEN_PLAIN = '<' + 'function_calls>'
  private static readonly FUNC_CALLS_CLOSE_PLAIN = '</' + 'function_calls>'
  private static readonly FUNC_RESULTS_OPEN = '<' + 'function_results>'
  private static readonly FUNC_RESULTS_CLOSE = '</' + 'function_results>'

  parseAnthropicToolCalls(completion: string): {
    calls: ToolCall[],
    beforeText: string,
    afterText: string,
    fullMatch: string,
  } | null {
    const blockPattern = /<(antml:)?function_calls>([\s\S]*?)<\/(antml:)?function_calls>/g
    
    let blockMatch: RegExpExecArray | null = null
    let lastUnexecutedMatch: RegExpExecArray | null = null
    
    while ((blockMatch = blockPattern.exec(completion)) !== null) {
      const afterPos = blockMatch.index + blockMatch[0].length
      const textAfter = completion.slice(afterPos, afterPos + 100)
      if (!textAfter.trimStart().startsWith('<function_results>')) {
        lastUnexecutedMatch = { ...blockMatch } as RegExpExecArray
        Object.assign(lastUnexecutedMatch, blockMatch)
        lastUnexecutedMatch.index = blockMatch.index
      }
    }
    
    blockMatch = lastUnexecutedMatch
    
    if (!blockMatch) {
      const hasOpen = completion.includes(ToolSystem.FUNC_CALLS_OPEN_ANTML) || 
                      completion.includes(ToolSystem.FUNC_CALLS_OPEN_PLAIN)
      const hasClose = completion.includes(ToolSystem.FUNC_CALLS_CLOSE_ANTML) || 
                       completion.includes(ToolSystem.FUNC_CALLS_CLOSE_PLAIN)
      if (hasOpen && !hasClose) {
        return null
      }
      return null
    }
    
    const fullMatch = blockMatch[0]
    const blockContent = blockMatch[2]!
    const beforeText = completion.slice(0, completion.indexOf(fullMatch))
    const afterText = completion.slice(completion.indexOf(fullMatch) + fullMatch.length)
    
    const invokePattern = /<(antml:)?invoke\s+name="([^"]+)">([\s\S]*?)<\/(antml:)?invoke>/g
    const calls: ToolCall[] = []
    let invokeMatch
    
    while ((invokeMatch = invokePattern.exec(blockContent)) !== null) {
      const toolName = invokeMatch[2]!
      const invokeContent = invokeMatch[3]!
      
      const paramPattern = /<(antml:)?parameter\s+name="([^"]+)">([^<]*)<\/(antml:)?parameter>/g
      const input: Record<string, any> = {}
      let paramMatch
      
      while ((paramMatch = paramPattern.exec(invokeContent)) !== null) {
        const paramName = paramMatch[2]!
        let paramValue: any = paramMatch[3]!
        
        try {
          paramValue = JSON.parse(paramValue)
        } catch {
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

  formatToolResultForInjection(_toolName: string, result: string): string {
    // No trailing whitespace - Anthropic API rejects it for assistant prefill
    return '\n\n' + ToolSystem.FUNC_RESULTS_OPEN + '\n' + result + '\n' + ToolSystem.FUNC_RESULTS_CLOSE
  }

  hasIncompleteToolCall(completion: string): boolean {
    const hasOpen = completion.includes(ToolSystem.FUNC_CALLS_OPEN_ANTML) || 
                    completion.includes(ToolSystem.FUNC_CALLS_OPEN_PLAIN)
    const hasClose = completion.includes(ToolSystem.FUNC_CALLS_CLOSE_ANTML) || 
                     completion.includes(ToolSystem.FUNC_CALLS_CLOSE_PLAIN)
    return hasOpen && !hasClose
  }

  stripToolXml(text: string): string {
    let result = text.replace(/<(antml:)?function_calls>[\s\S]*?<\/(antml:)?function_calls>/g, '')
    result = result.replace(/<function_results>[\s\S]*?<\/function_results>/g, '')
    result = result.replace(/\n{3,}/g, '\n\n')
    return result.trim()
  }

  parseToolCalls(completion: string, originalText: string): Array<{call: ToolCall, originalText: string}> {
    const results: Array<{call: ToolCall, originalText: string}> = []

    const masked = completion
      .replace(/```[\s\S]*?```/g, '[CODE_BLOCK]')
      .replace(/`[^`]+`/g, '[INLINE_CODE]')

    const pattern = /<(\w+)>\s*(\{[\s\S]*?\})?\s*<\/\1>/g
    let match

    while ((match = pattern.exec(masked)) !== null) {
      const toolName = match[1]
      const jsonInput = match[2]

      if (!toolName) {
        continue
      }
      
      const knownTool = this.tools.find(t => t.name === toolName)
      if (!knownTool) {
        logger.trace({ toolName }, 'Skipping unknown tool name (might be regular XML)')
        continue
      }

      try {
        const input = jsonInput ? JSON.parse(jsonInput.trim()) : {}
        
        results.push({
          call: {
            id: this.generateToolCallId(),
            name: toolName,
            input,
            messageId: '',
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

  async executeTool(call: ToolCall): Promise<ToolResult> {
    const pluginHandler = this.pluginHandlers.get(call.name)
    if (pluginHandler) {
      const toolDef = this.tools.find(t => t.name === call.name)
      if (toolDef?.serverName?.startsWith('plugin:')) {
        const pluginName = toolDef.serverName.replace('plugin:', '')
        const pluginConfig = this.pluginConfigs[pluginName]
        if (pluginConfig?.state_scope === 'off') {
          logger.debug({ call, pluginName }, 'Plugin tool disabled (state_scope: off)')
          return {
            callId: call.id,
            output: `Plugin "${pluginName}" is disabled`,
            timestamp: new Date(),
            error: 'Plugin disabled',
          }
        }
      }
      
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
          addReaction: this.pluginContext.addReaction || (async () => {}),
          uploadFile: this.pluginContext.uploadFile,
          visibleImages: this.pluginContext.visibleImages,
        }
        
        let result = await pluginHandler(call.input, context)
        
        const toolDef = this.tools.find(t => t.name === call.name)
        if (toolDef?.serverName?.startsWith('plugin:')) {
          const pluginName = toolDef.serverName.replace('plugin:', '')
          const plugin = this.loadedPluginObjects.get(pluginName)
          
          if (this.pluginContextFactory) {
            try {
              const pluginConfig = this.pluginConfigs[pluginName]
              
              const pluginStateContext = this.pluginContextFactory.createStateContext(
                pluginName,
                context,
                undefined,
                undefined,
                pluginConfig
              )
              
              if (plugin?.onToolExecution) {
                await plugin.onToolExecution(call.name, call.input, result, pluginStateContext)
                logger.debug({ pluginName, toolName: call.name }, 'Called onToolExecution hook')
              }
              
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

    if (this.mcpClients.size === 0 && this.pluginHandlers.size === 0) {
      throw new ToolError('No tools initialized')
    }

    try {
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

      const { textOutput, images } = this.parseMcpResultContent(result.content)

      return {
        callId: call.id,
        output: textOutput,
        images: images.length > 0 ? images : undefined,
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
        botMessageIds: call.botMessageIds,
        coveredMessageIds: call.coveredMessageIds,
      },
      result: {
        output: result.output,
        error: result.error,
        images: result.images,  // MCP image content (base64)
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

  async updateBotMessageIds(
    botId: string,
    channelId: string,
    toolCallIds: string[],
    botMessageIds: string[],
    coveredMessageIds: string[]
  ): Promise<void> {
    if (toolCallIds.length === 0 || botMessageIds.length === 0) return
    
    const dirPath = join(this.toolCacheDir, botId, channelId)
    if (!existsSync(dirPath)) return
    
    const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
    
    for (const file of files) {
      const filePath = join(dirPath, file)
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l)
      
      let modified = false
      const updatedLines = lines.map(line => {
        try {
          const entry = JSON.parse(line)
          if (toolCallIds.includes(entry.call?.id)) {
            let changed = false
            if (!entry.call?.botMessageIds) {
              entry.call.botMessageIds = botMessageIds
              changed = true
            }
            if (!Array.isArray(entry.call?.coveredMessageIds)) {
              entry.call.coveredMessageIds = coveredMessageIds
              changed = true
            }
            if (changed) {
              modified = true
              return JSON.stringify(entry)
            }
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
            return false
          }
          return true
        } catch {
          return true
        }
      })
      
      if (filteredLines.length < lines.length) {
        if (filteredLines.length === 0) {
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

  private parseMcpResultContent(content: any): {
    textOutput: string
    images: Array<{ data: string; mimeType: string }>
  } {
    const images: Array<{ data: string; mimeType: string }> = []
    const textParts: string[] = []

    if (!content) {
      return { textOutput: '', images: [] }
    }

    if (typeof content === 'string') {
      return { textOutput: content, images: [] }
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          textParts.push(String(block))
          continue
        }

        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'image') {
          const data = block.data || block.source?.data
          const mimeType = block.mimeType || block.source?.media_type || 'image/png'
          if (data) {
            images.push({ data, mimeType })
            logger.debug({ mimeType, dataLength: data.length }, 'Extracted image from MCP tool result')
          }
        } else if (block.type === 'resource') {
          if (block.resource?.text) {
            textParts.push(block.resource.text)
          } else if (block.resource?.blob) {
            textParts.push(`[Binary resource: ${block.resource.uri || 'unknown'}]`)
          }
        } else {
          textParts.push(JSON.stringify(block))
        }
      }
    } else {
      textParts.push(typeof content === 'string' ? content : JSON.stringify(content))
    }

    return {
      textOutput: textParts.join('\n'),
      images,
    }
  }
}
