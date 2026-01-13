/**
 * Trace Types
 * 
 * Defines the structure of activation traces for debugging.
 * Every piece of data is addressable back to its Discord origin.
 */

// ============================================================================
// Core Trace Structure
// ============================================================================

export interface ActivationTrace {
  /** Unique identifier for this activation */
  traceId: string
  
  /** When the activation started */
  timestamp: Date
  
  /** Discord context */
  channelId: string
  guildId?: string
  triggeringMessageId: string
  
  /** Bot identity */
  botId: string
  botUserId?: string
  
  /** Why we activated */
  activation: ActivationInfo
  
  /** Raw Discord messages before any transformation */
  rawDiscordMessages?: RawDiscordMessage[]
  
  /** How context was built */
  contextBuild?: ContextBuildInfo
  
  /** LLM API calls (can be multiple in tool loops) */
  llmCalls: LLMCallInfo[]
  
  /** Tool executions */
  toolExecutions: ToolExecutionInfo[]
  
  /** Final outcome */
  outcome?: OutcomeInfo
  
  /** Console logs captured during this activation */
  logs: LogEntry[]
  
  /** Total duration in milliseconds */
  durationMs?: number
  
  /** Full bot configuration used for this activation */
  config?: Record<string, any>
}

// ============================================================================
// Raw Discord Messages (before transformation)
// ============================================================================

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
  /** If this is a reply, the message ID being replied to */
  replyTo?: string
}

// ============================================================================
// Log Entries
// ============================================================================

export interface LogEntry {
  /** Milliseconds since activation start */
  offsetMs: number
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  message: string
  /** Structured data from the log call */
  data?: Record<string, unknown>
}

// ============================================================================
// Activation Info
// ============================================================================

export interface ActivationInfo {
  reason: 'mention' | 'reply' | 'random' | 'm_command'
  
  /** The event(s) that triggered activation */
  triggerEvents: Array<{
    type: string
    messageId?: string
    authorId?: string
    authorName?: string
    contentPreview?: string
  }>
}

// ============================================================================
// Context Build Info
// ============================================================================

export interface ContextBuildInfo {
  /** Messages from Discord that were considered */
  messagesConsidered: number
  
  /** Messages actually included in context */
  messagesIncluded: number
  
  /** Detailed breakdown of each message in context */
  messages: ContextMessageInfo[]
  
  /** Images included */
  imagesIncluded: number
  imageDetails: Array<{
    discordMessageId: string
    url: string
    tokenEstimate: number
  }>
  
  /** Tool cache entries included */
  toolCacheEntries: number
  toolCacheDetails: Array<{
    toolName: string
    triggeringMessageId: string
    tokenEstimate: number
  }>
  
  /** Did we hit the rolling threshold and truncate? */
  didTruncate: boolean
  truncateReason?: string
  messagesRolledOff?: number
  
  /** Cache marker for Anthropic prompt caching */
  cacheMarker?: string
  previousCacheMarker?: string
  
  /** Stop sequences derived from participants */
  stopSequences: string[]
  
  /** Token estimates */
  tokenEstimates: {
    system: number
    messages: number
    images: number
    tools: number
    total: number
  }
  
  /** Config values that affected context building */
  configSnapshot: {
    recencyWindow: number
    rollingThreshold: number
    maxImages: number
    mode: 'prefill' | 'chat'
  }
}

/**
 * Information about a single message in the context.
 * Preserves link back to Discord and tracks transformations.
 */
export interface ContextMessageInfo {
  /** Position in the final context (0-indexed) */
  position: number
  
  /** Original Discord message ID (null for synthetic messages like tool results) */
  discordMessageId: string | null
  
  /** Who sent this message */
  participant: string
  
  /** First N characters of content for quick scanning */
  contentPreview: string
  
  /** Full content length in characters */
  contentLength: number
  
  /** Estimated token count */
  tokenEstimate: number
  
  /** What transformations were applied */
  transformations: MessageTransformation[]
  
  /** Is this the message that triggered activation? */
  isTrigger: boolean
  
  /** Does this message have images? */
  hasImages: boolean
  imageCount: number
  
  /** Does this message have cache control? */
  hasCacheControl: boolean
  
  /** Original Discord timestamp */
  discordTimestamp?: Date
}

export type MessageTransformation = 
  | 'merged_consecutive'      // Multiple bot messages merged into one
  | 'image_extracted'         // Image was extracted and included
  | 'image_skipped'           // Image was skipped (over limit)
  | 'tool_result_injected'    // Tool result was added after this message
  | 'content_truncated'       // Content was truncated for length
  | 'reply_prefix_added'      // <reply:@user> prefix was added
  | 'mention_converted'       // <@username> converted to <@USER_ID>

// ============================================================================
// LLM Call Info
// ============================================================================

export interface LLMCallInfo {
  /** Unique ID for this call within the trace */
  callId: string
  
  /** Depth in tool loop (0 = first call) */
  depth: number
  
  /** When the call started */
  startedAt: Date
  
  /** Duration in milliseconds */
  durationMs: number
  
  /** Model used */
  model: string
  
  /** The full request (for replay/debugging) */
  request: {
    messageCount: number
    systemPromptLength: number
    hasTools: boolean
    toolCount: number
    temperature?: number
    maxTokens?: number
    stopSequences?: string[]
    apiBaseUrl?: string  // LLM API endpoint URL for debugging
  }
  
  /** Full request body - stored separately for size */
  requestBodyRef?: string  // Path to full request JSON
  
  /** Response summary */
  response: {
    stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal'
    contentBlocks: number
    textLength: number
    toolUseCount: number
  }
  
  /** Full response body - stored separately for size */
  responseBodyRef?: string  // Path to full response JSON
  
  /** Token usage */
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
  
  /** Any error that occurred */
  error?: {
    message: string
    code?: string
    retryCount: number
  }
}

// ============================================================================
// Tool Execution Info
// ============================================================================

export interface ToolExecutionInfo {
  /** Links to the LLM call that requested this tool */
  llmCallId: string
  
  /** Tool call ID from the LLM */
  toolCallId: string
  
  /** Which tool was called */
  toolName: string
  
  /** Input parameters */
  input: Record<string, unknown>
  
  /** Output (may be truncated for large outputs) */
  output: string
  outputTruncated: boolean
  fullOutputLength: number
  
  /** Duration in milliseconds */
  durationMs: number
  
  /** Was this tool result sent to Discord? */
  sentToDiscord: boolean
  
  /** Number of images returned by MCP tool (if any) */
  imageCount?: number
  
  /** Any error */
  error?: string
}

// ============================================================================
// Outcome Info
// ============================================================================

export interface OutcomeInfo {
  /** Did we successfully send a response? */
  success: boolean
  
  /** The response text we sent (or tried to send) */
  responseText: string
  responseLength: number
  
  /** Discord message IDs of sent messages */
  sentMessageIds: string[]
  
  /** Number of messages sent (may be split) */
  messagesSent: number
  
  /** Total tool loop depth reached */
  maxToolDepth: number
  
  /** Did we hit max tool depth? */
  hitMaxToolDepth: boolean
  
  /** Any error that prevented response */
  error?: {
    message: string
    phase: 'context_build' | 'llm_call' | 'tool_execution' | 'discord_send'
    stack?: string
  }
  
  /** State updates */
  stateUpdates: {
    cacheMarkerUpdated: boolean
    newCacheMarker?: string
    messageCountReset: boolean
    newMessageCount?: number
  }
}

// ============================================================================
// Trace Index (for fast lookups without loading full traces)
// ============================================================================

export interface TraceIndex {
  traceId: string
  timestamp: Date
  channelId: string
  triggeringMessageId: string
  
  /** Bot that handled this activation */
  botName?: string
  
  /** Human-readable channel name (for display) */
  channelName?: string
  
  /** Quick stats for filtering */
  success: boolean
  durationMs: number
  llmCallCount: number
  toolExecutionCount: number
  totalTokens: number
  
  /** Discord message IDs included in context (for reverse lookup) */
  contextMessageIds: string[]
  
  /** Discord message IDs we sent (for finding our responses) */
  sentMessageIds: string[]
}

