import { ContentBlock } from '../../types.js'
import type { StateScope } from './state.js'

export interface ToolPlugin {
  name: string
  description: string
  tools: PluginTool[]
  
  getContextInjections?: (context: PluginStateContext) => Promise<ContextInjection[]>
  
  onToolExecution?: (
    toolName: string,
    input: any,
    result: any,
    context: PluginStateContext
  ) => Promise<void>
  
  postProcessResult?: (
    toolName: string,
    input: any,
    result: string,
    context: PluginStateContext
  ) => Promise<string>
  
  onInit?: (context: PluginStateContext) => Promise<void>
}

export interface PluginTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  handler: (input: any, context: PluginContext) => Promise<any>
}

export interface VisibleImage {
  index: number
  source: 'discord' | 'mcp_tool'
  sourceDetail: string
  data: string
  mimeType: string
  description?: string
}

export interface PluginContext {
  botId: string
  channelId: string
  guildId: string
  currentMessageId: string
  config: any
  sendMessage: (content: string) => Promise<string[]>
  pinMessage: (messageId: string) => Promise<void>
  addReaction: (messageId: string, emoji: string) => Promise<void>
  uploadFile?: (buffer: Buffer, filename: string, contentType: string, caption?: string) => Promise<string[]>
  visibleImages?: VisibleImage[]
}

export interface PluginStateContext extends PluginContext {
  getState<T>(scope: StateScope): Promise<T | null>
  
  setState<T>(scope: StateScope, state: T): Promise<void>
  
  getStateAtMessage<T>(messageId: string): Promise<T | null>
  
  contextMessageIds: Set<string>
  
  messagesSinceId(messageId: string | null): number
  
  inheritanceInfo?: {
    parentChannelId?: string
    historyOriginChannelId?: string
  }
  
  pluginConfig?: {
    state_scope?: StateScope
    [key: string]: any
  }
  
  configuredScope: StateScope
}

export interface ContextInjection {
  id: string
  
  content: string | ContentBlock[]
  
  targetDepth: number
  
  lastModifiedAt?: string | null
  
  priority?: number
  
  asSystem?: boolean
}

