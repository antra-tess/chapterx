export interface ActivationTrace {
  traceId: string
  
  timestamp: Date
  
  channelId: string
  guildId?: string
  triggeringMessageId: string

  isThread?: boolean

  parentChannelId?: string
  
  botId: string
  botUserId?: string
  
  activation: ActivationInfo
  
  rawDiscordMessages?: RawDiscordMessage[]
  
  contextBuild?: ContextBuildInfo
  
  llmCalls: LLMCallInfo[]
  
  toolExecutions: ToolExecutionInfo[]
  
  outcome?: OutcomeInfo
  
  logs: LogEntry[]
  
  durationMs?: number
  
  config?: Record<string, any>
}

export interface RawDiscordMessage {
  id: string
  author: {
    id: string
    username: string
    displayName: string
    bot: boolean
  }
  content: string
  timestamp: Date
  attachments: Array<{
    url: string
    contentType?: string
    filename: string
    size: number
  }>
  replyTo?: string
}

export interface LogEntry {
  offsetMs: number
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  message: string
  data?: Record<string, unknown>
}

export interface ActivationInfo {
  reason: 'mention' | 'reply' | 'random' | 'm_command' | 'reaction' | 'timer'
  
  triggerEvents: Array<{
    type: string
    messageId?: string
    authorId?: string
    authorName?: string
    contentPreview?: string
  }>
}

export interface ContextBuildInfo {
  messagesConsidered: number
  
  messagesIncluded: number
  
  messages: ContextMessageInfo[]
  
  imagesIncluded: number
  imageDetails: Array<{
    discordMessageId: string
    url: string
    tokenEstimate: number
  }>
  
  toolCacheEntries: number
  toolCacheDetails: Array<{
    toolName: string
    triggeringMessageId: string
    tokenEstimate: number
  }>
  
  didTruncate: boolean
  truncateReason?: string
  messagesRolledOff?: number
  
  cacheMarker?: string
  previousCacheMarker?: string
  
  stopSequences: string[]
  
  tokenEstimates: {
    system: number
    messages: number
    images: number
    tools: number
    total: number
  }
  
  configSnapshot: {
    recencyWindow: number
    rollingThreshold: number
    maxImages: number
  }
}

export interface ContextMessageInfo {
  position: number
  
  discordMessageId: string | null
  
  participant: string
  
  contentPreview: string
  
  contentLength: number
  
  tokenEstimate: number
  
  transformations: MessageTransformation[]
  
  isTrigger: boolean
  
  hasImages: boolean
  imageCount: number
  
  hasCacheControl: boolean
  
  discordTimestamp?: Date
}

export type MessageTransformation = 
  | 'merged_consecutive'
  | 'image_extracted'
  | 'image_skipped'
  | 'tool_result_injected'
  | 'content_truncated'
  | 'reply_prefix_added'
  | 'mention_converted'

export interface LLMCallInfo {
  callId: string
  
  depth: number
  
  startedAt: Date
  
  durationMs: number
  
  model: string
  
  request: {
    messageCount: number
    systemPromptLength: number
    hasTools: boolean
    toolCount: number
    temperature?: number
    maxTokens?: number
    stopSequences?: string[]
    apiBaseUrl?: string
  }
  
  requestBodyRef?: string

  requestBodyRefs?: string[]

  response: {
    stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal'
    contentBlocks: number
    textLength: number
    toolUseCount: number
  }
  
  responseBodyRef?: string

  responseBodyRefs?: string[]

  membraneRequestRef?: string

  membraneResponseRef?: string

  tokenUsage: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
  
  error?: {
    message: string
    code?: string
    retryCount: number
  }
}

export interface ToolExecutionInfo {
  llmCallId: string
  
  toolCallId: string
  
  toolName: string
  
  input: Record<string, unknown>
  
  output: string
  outputTruncated: boolean
  fullOutputLength: number
  
  durationMs: number
  
  sentToDiscord: boolean
  
  imageCount?: number
  
  error?: string
}

export interface OutcomeInfo {
  success: boolean
  
  responseText: string
  responseLength: number
  
  sentMessageIds: string[]
  
  messagesSent: number
  
  maxToolDepth: number
  
  hitMaxToolDepth: boolean
  
  error?: {
    message: string
    phase: 'context_build' | 'llm_call' | 'tool_execution' | 'discord_send'
    stack?: string
  }
  
  stateUpdates: {
    cacheMarkerUpdated: boolean
    newCacheMarker?: string
    messageCountReset: boolean
    newMessageCount?: number
  }
}

export interface TraceIndex {
  traceId: string
  timestamp: Date
  channelId: string
  triggeringMessageId: string
  
  botName?: string
  
  channelName?: string
  
  activationReason?: string

  triggerPreview?: string

  responsePreview?: string

  isThread?: boolean

  parentChannelId?: string

  success: boolean
  durationMs: number
  llmCallCount: number
  toolExecutionCount: number
  totalTokens: number

  contextMessageIds: string[]

  sentMessageIds: string[]
}

