/**
 * Core types for Chapter3 Discord bot framework
 * 
 * This file defines the normalized multi-participant API that serves as the
 * interface between Context Builder and LLM Middleware.
 */

// ============================================================================
// Normalized Multi-Participant Format
// ============================================================================

/**
 * Complete request to LLM Middleware
 * Uses participant-based format (not role-based)
 */
export interface LLMRequest {
  messages: ParticipantMessage[]
  system_prompt?: string
  context_prefix?: string  // Inserted as first cached assistant message (for simulacrum seeding)
  config: ModelConfig
  tools?: ToolDefinition[]
  stop_sequences?: string[]
}

/**
 * Result of context building, including metadata
 */
export interface ContextBuildResult {
  request: LLMRequest
  didRoll: boolean
  cacheMarker: string | null
}

/**
 * Message from a single participant (human or bot)
 * Core abstraction - no artificial "user" vs "assistant" roles
 */
export interface ParticipantMessage {
  participant: string  // "Alice", "Bob", "Claude", etc.
  content: ContentBlock[]
  timestamp?: Date
  messageId?: string  // Discord message ID (for cache markers)
  cacheBreakpoint?: boolean  // If true, cache boundary is placed AFTER this message
  cacheControl?: CacheControl  // @deprecated - use cacheBreakpoint instead
}

/**
 * Content blocks - supports text, images, and tool use
 */
export type ContentBlock = 
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent

export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    data: string  // base64 data or URL
    media_type: string  // 'image/jpeg', 'image/png', etc. (snake_case for Anthropic API)
  }
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolResultContent {
  type: 'tool_result'
  toolUseId: string
  content: string | ContentBlock[]
  isError?: boolean
}

export interface CacheControl {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

// ============================================================================
// LLM Response Format
// ============================================================================

/**
 * Response from LLM Middleware
 */
export interface LLMCompletion {
  content: ContentBlock[]  // May contain text and tool_use blocks
  stopReason: StopReason
  usage: UsageInfo
  model: string
  raw?: any  // Optional: raw provider response for debugging
}

export type StopReason = 
  | 'end_turn'      // Natural completion
  | 'max_tokens'    // Hit token limit
  | 'stop_sequence' // Hit stop sequence
  | 'tool_use'      // Stopped for tool use
  | 'refusal'       // Content refused by safety classifier

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Model configuration (subset of BotConfig)
 */
export interface ModelConfig {
  model: string
  temperature: number
  max_tokens: number
  top_p: number
  prefill_thinking?: boolean  // If true, enable extended thinking
  botName: string  // Name used in LLM context (prefill labels, stop sequences)
  messageDelimiter?: string  // Optional delimiter appended to each message (for completions formatter)
  turnEndToken?: string  // Optional token appended after each message content (e.g., '<eot>' for Gemini)
  presence_penalty?: number  // Penalty for token presence (0.0-2.0)
  frequency_penalty?: number  // Penalty for token frequency (0.0-2.0)
  prompt_caching?: boolean  // If true (default), apply cache_control markers for Anthropic prompt caching
  cache_ttl?: '5m' | '1h'  // Anthropic cache TTL - '5m' (default) or '1h' (extended)
  participant_stop_sequences?: boolean  // If true, membrane generates stop sequences from participant names (default: false)
}

/**
 * Complete bot configuration
 */
export interface BotConfig {
  // Identity
  name: string  // Name used in LLM context (prefill labels, stop sequences)

  // Model config
  prefill_thinking?: boolean  // If true, enable extended thinking
  debug_thinking?: boolean  // If true, send thinking content as dot-prefixed debug message
  preserve_thinking_context?: boolean  // If true, preserve thinking traces in context (for Opus 4.5)
  continuation_model: string
  temperature: number
  max_tokens: number
  top_p: number
  presence_penalty?: number  // Penalty for token presence (0.0-2.0)
  frequency_penalty?: number  // Penalty for token frequency (0.0-2.0)
  
  // Context config
  recency_window_messages?: number  // Max number of messages
  recency_window_characters?: number  // Max number of characters
  hard_max_characters?: number  // Hard maximum - never exceeded (prevents API errors)
  rolling_threshold: number  // Messages before truncation
  recent_participant_count: number  // Number of recent participants for stop sequences
  authorized_roles: string[]  // Roles authorized to use .history commands
  prompt_caching?: boolean  // Enable Anthropic prompt caching (default: true)
  cache_ttl?: '5m' | '1h'  // Anthropic cache TTL - '5m' (default) or '1h' (extended)
  
  // Image config
  include_images: boolean
  max_images: number  // Max images to include (applies to ephemeral window, or prefix if cache_images is true)
  max_ephemeral_images?: number  // Max images in rolling window after cache marker (default: max_images)
  cache_images?: boolean  // If true, include images in cached prefix (requires deterministic handling). Default: false (images only in rolling window)
  
  // Text attachment config
  include_text_attachments: boolean
  max_text_attachment_kb: number  // Max size per text attachment in KB
  
  // Tool config
  tools_enabled: boolean
  tool_output_visible: boolean
  max_tool_depth: number
  max_mcp_images: number  // Max images from MCP tool results to include in context
  mcp_servers?: MCPServerConfig[]
  tool_plugins?: string[]  // Plugin names to enable (e.g., ['config'])
  plugin_config?: Record<string, PluginInstanceConfig>  // Per-plugin configuration
  
  // Stop sequences
  stop_sequences: string[]
  message_delimiter?: string  // Delimiter appended to each message (for completions formatter)
  turn_end_token?: string  // Token appended after each message content (e.g., '<eot>' for Gemini)
  
  // Retries
  llm_retries: number
  discord_backoff_max: number
  
  // Misc
  system_prompt?: string
  system_prompt_file?: string  // Path to file containing system prompt (relative to config dir)
  context_prefix?: string      // Prefix content to insert as first assistant message (cached)
  context_prefix_file?: string // Path to file containing context prefix (relative to config dir)
  reply_on_random: number
  reply_on_name: boolean
  max_queued_replies: number
  
  // Loop prevention
  max_bot_reply_chain_depth: number  // Max consecutive bot messages in reply chain (prevents bot loops)
  bot_reply_chain_depth_emote: string  // Emote to show when bot reply chain depth limit is reached
  
  // API mode
  api_only?: boolean  // If true, disable Discord activation handling - only serve API requests
  
  // Soma integration (credit system)
  soma?: SomaConfig

  // Participant stop sequences
  // When true, auto-generates stop sequences from participant names to prevent
  // the model from "speaking as" other users. Default: false (allows frags/quotes)
  participant_stop_sequences?: boolean

  // TTS relay integration
  // Connects to a WebSocket relay server to stream visible text chunks
  // for text-to-speech playback in local clients
  tts_relay?: TTSRelayConfig
}

/**
 * TTS relay configuration for streaming text to local TTS clients
 */
export interface TTSRelayConfig {
  enabled: boolean
  url: string  // WebSocket URL (e.g., "ws://localhost:8800/bot")
  token: string  // Authentication token
  reconnect_interval_ms?: number  // Reconnect delay (default: 5000)
}

/**
 * Vendor configuration for LLM providers
 */
export interface VendorConfig {
  config: Record<string, string>
  provides: string[]  // Model name patterns (regex)

  /**
   * Formatter type for this vendor:
   * - 'anthropic-xml': Prefill mode with XML tools (default for Anthropic/Claude)
   * - 'native': Native API tools (for OpenAI-style APIs)
   * - 'completions': For base models using /v1/completions
   */
  formatter?: 'anthropic-xml' | 'native' | 'completions'

  /**
   * Completions formatter settings (when formatter='completions')
   */
  completions_config?: {
    /** End-of-turn token (default: '<|eot|>', set to empty to disable) */
    eot_token?: string
    /** Name format template (default: '{name}: ') */
    name_format?: string
    /** Message separator (default: '\n\n') */
    message_separator?: string
  }
}

// ============================================================================
// Tool System
// ============================================================================

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface PluginInstanceConfig {
  /** State scope: 'global', 'channel', 'epic', or 'off' to disable the plugin */
  state_scope?: 'global' | 'channel' | 'epic' | 'off'
  /** Any other plugin-specific settings */
  [key: string]: any
}

// ============================================================================
// Soma Integration (Credit System)
// ============================================================================

/**
 * Soma integration configuration
 * When enabled, users must have sufficient ichor (credits) to trigger the bot
 */
export interface SomaConfig {
  /** Enable Soma credit checking (default: false) */
  enabled: boolean
  /** Soma API base URL (e.g., "http://localhost:3100/api/v1") */
  url: string
  /** Optional: Override token from environment (default: uses SOMA_TOKEN env var) */
  token?: string
}

/**
 * Result from Soma check-and-deduct API
 */
export interface SomaCheckResult {
  allowed: boolean
  cost: number
  // Success fields
  balanceAfter?: number
  transactionId?: string
  // Failure fields  
  currentBalance?: number
  regenRate?: number
  timeToAfford?: number  // Minutes
  cheaperAlternatives?: Array<{
    botId: string
    name: string
    cost: number
  }>
  // Reason for denial (if allowed=false)
  reason?: 'insufficient_funds' | 'bot_not_configured'
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  serverName?: string  // Which MCP server provides this tool
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, any>
  messageId: string  // For pruning old calls (triggering user message)
  timestamp: Date
  originalCompletionText: string  // The bot's original text including XML tool call
  botMessageIds?: string[]  // Discord message IDs from bot's response (for existence checking)
}

export interface ToolCallWithResult {
  call: ToolCall
  result: ToolResult
}

export interface ToolResult {
  callId: string
  output: any
  /** Image content blocks returned from MCP tools (base64 encoded) */
  images?: Array<{
    data: string      // base64 encoded image data
    mimeType: string  // e.g., 'image/png', 'image/jpeg'
  }>
  error?: string
  timestamp: Date
}

/**
 * JSON Schema type (simplified)
 */
export interface JSONSchema {
  type: string
  properties?: Record<string, JSONSchema>
  items?: JSONSchema
  required?: string[]
  description?: string
  enum?: any[]
  [key: string]: any
}

// ============================================================================
// Discord Domain
// ============================================================================

/**
 * Discord message (raw from Discord API)
 */
export interface DiscordMessage {
  id: string
  channelId: string
  guildId: string
  author: {
    id: string
    username: string
    displayName: string
    bot: boolean
  }
  content: string
  timestamp: Date
  attachments: DiscordAttachment[]
  reactions: Array<{
    emoji: string
    count: number
  }>
  mentions: string[]  // User IDs
  referencedMessage?: string  // Reply to message ID
}

export interface DiscordAttachment {
  id: string
  url: string
  filename: string
  contentType?: string
  size: number
  width?: number
  height?: number
}

/**
 * Context fetched from Discord
 */
export interface DiscordContext {
  messages: DiscordMessage[]
  pinnedConfigs: string[]  // Raw YAML strings from pinned messages
  images: CachedImage[]
  documents: CachedDocument[]  // Text file contents
  guildId: string
  /** Inheritance info for plugin state */
  inheritanceInfo?: {
    /** Parent channel ID if this is a thread */
    parentChannelId?: string
    /** Origin channel ID if .history was used to jump here */
    historyOriginChannelId?: string
    /** Whether .history clear was used to truncate context */
    historyDidClear?: boolean
  }
}

export interface CachedImage {
  url: string
  data: Buffer
  mediaType: string
  hash: string
  width?: number
  height?: number
  tokenEstimate?: number  // Anthropic formula: (width * height) / 750
}

export interface CachedDocument {
  messageId: string
  url: string
  filename: string
  contentType?: string
  size: number
  text: string
  truncated?: boolean
}

// ============================================================================
// Events
// ============================================================================

export interface Event {
  type: EventType
  channelId: string
  guildId: string
  data: any
  timestamp: Date
}

export type EventType = 
  | 'message' 
  | 'reaction' 
  | 'edit' 
  | 'delete' 
  | 'self_activation'  // Bot activates itself (e.g., timer)
  | 'timer' 
  | 'internal'

// ============================================================================
// Channel State
// ============================================================================

/**
 * Per-channel state managed by ChannelStateManager
 */
export interface ChannelState {
  toolCache: ToolCall[]
  lastCacheMarker: string | null  // Message ID
  messagesSinceRoll: number
  cacheOldestMessageId: string | null  // Oldest message ID when cache was created (for stable trimming)
}

// ============================================================================
// Error Types
// ============================================================================

export class Chapter3Error extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message)
    this.name = 'Chapter3Error'
  }
}

export class ConfigError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'CONFIG_ERROR', details)
    this.name = 'ConfigError'
  }
}

export class DiscordError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'DISCORD_ERROR', details)
    this.name = 'DiscordError'
  }
}

export class LLMError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'LLM_ERROR', details)
    this.name = 'LLMError'
  }
}

export class ToolError extends Chapter3Error {
  constructor(message: string, details?: any) {
    super(message, 'TOOL_ERROR', details)
    this.name = 'ToolError'
  }
}

