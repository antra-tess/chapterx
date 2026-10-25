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
  prefill_user_message?: string  // Custom content for synthetic user message (replaces '[Start]')
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
  isBot?: boolean  // Whether this message is from a bot (used for merge decisions)
  isCharacterOverride?: boolean  // If true, participant was set via `~Name:` prefix — excluded from stop sequences so the model can frag
  cacheBreakpoint?: boolean  // If true, cache boundary is placed AFTER this message
  cacheControl?: CacheControl  // @deprecated - use cacheBreakpoint instead
}

/**
 * Content blocks - supports text, images, tool use, and thinking
 */
export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | RedactedThinkingContent

export interface TextContent {
  type: 'text'
  text: string
}

/**
 * The signature carries the API's encrypted full reasoning (validated and, on
 * display:'omitted' models, decrypted server-side when passed back). Must
 * round-trip verbatim — including blocks whose thinking field is empty
 * (signature-only).
 */
export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface RedactedThinkingContent {
  type: 'redacted_thinking'
  data?: string
}

export interface ImageContent {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    data: string  // base64 data or URL
    media_type: string  // snake_case for the Anthropic API
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
  top_p?: number  // Only sent when set (avoids Anthropic temp+top_p conflict)
  prefill_thinking?: boolean  // If true, enable extended thinking
  debug_thinking?: boolean  // If true, thinking is enabled and content posted as dot-prefixed debug messages
  thinking_budget?: number  // Token budget for extended thinking (default: 10000)
  thinking_type?: 'enabled' | 'adaptive'  // API thinking type: 'enabled' (explicit budget) or 'adaptive' (model-managed, e.g. Fable 5)
  botName: string  // Name used in LLM context (prefill labels, stop sequences)
  messageDelimiter?: string  // Optional delimiter appended to each message (for completions formatter)
  turnEndToken?: string  // Optional token appended after each message content (e.g., '<eot>' for Gemini)
  presence_penalty?: number  // Penalty for token presence (0.0-2.0)
  frequency_penalty?: number  // Penalty for token frequency (0.0-2.0)
  repetition_penalty?: number  // Multiplicative repetition penalty (vLLM/HuggingFace style, typically 1.0-1.2)
  prompt_caching?: boolean  // If true (default), apply cache_control markers for Anthropic prompt caching
  cache_ttl?: '5m' | '1h'  // Anthropic cache TTL - '5m' (default) or '1h' (extended)
  participant_stop_sequences?: boolean  // If true, membrane generates stop sequences from participant names (default: false)
  generate_images?: boolean  // If true, set responseModalities for image generation (overrides auto-detect from model name)
  provider_params?: Record<string, unknown>  // Arbitrary params passed through to the LLM provider (e.g., reasoning config)
  mode?: 'chat' | 'prefill' | 'base-model'  // Bot mode — controls formatter and execution path routing
  streaming?: boolean  // When false, force non-streaming LLM calls (default: true)
}

/**
 * Complete bot configuration
 */
export interface BotConfig {
  // Identity
  name: string  // Name used in LLM context (prefill labels, stop sequences)

  // Model config
  prefill_thinking?: boolean  // With the anthropic-xml formatter (prefill mode, or mode unset on a Claude model), the bot's turn opens with <thinking>; temperature is sent as 1
  debug_thinking?: boolean  // If true, send thinking content as dot-prefixed debug messages; with mode 'chat', temperature is sent as 1
  thinking_budget?: number  // Token budget for extended thinking (default: 10000)
  thinking_type?: 'enabled' | 'adaptive'  // API thinking type: 'enabled' (explicit budget) or 'adaptive' (model-managed); with mode 'chat', setting it sends temperature as 1
  preserve_thinking_context?: boolean  // If true, preserve thinking traces in context (for Opus 4.5)
  preserve_thinking_blocks?: boolean  // Persist + round-trip native thinking blocks (signatures) for reasoning continuity. Default: true
  continuation_model: string
  temperature: number
  max_tokens: number
  top_p?: number
  presence_penalty?: number  // Sent by membrane's openai, openai-compatible, openai-completions and openrouter providers; the others don't send it
  frequency_penalty?: number  // Sent by membrane's openai, openai-compatible, openai-completions and openrouter providers; the others don't send it
  repetition_penalty?: number  // Multiplicative repetition penalty (vLLM/HuggingFace style, typically 1.0-1.2)

  // Context config
  recency_window_messages?: number  // Max number of messages
  recency_window_characters?: number  // Max number of characters
  hard_max_characters?: number  // Hard maximum - never exceeded (prevents API errors)
  rolling_threshold: number  // Messages before truncation
  recent_participant_count: number  // Number of recent participants for stop sequences
  authorized_roles: string[]  // Roles authorized to use .history commands
  steer_roles?: string[]  // Roles authorized to use .steer commands (if empty/undefined, .steer is unrestricted)
  steer_visible?: boolean  // If true, .steer messages are visible in bot context (default: false)
  steer_readout?: boolean  // If true, send probe readout as file attachment after steered generation (default: false)
  prompt_caching?: boolean  // Enable Anthropic prompt caching (default: true)
  cache_ttl?: '5m' | '1h'  // Anthropic cache TTL - '5m' (default) or '1h' (extended)
  
  // Image config
  include_images: boolean
  max_images: number  // Max images to include (applies to ephemeral window, or prefix if cache_images is true)
  max_ephemeral_images?: number  // Max images in rolling window after cache marker (default: max_images)
  cache_images?: boolean  // If true, include images in cached prefix (requires deterministic handling). Default: false (images only in rolling window)
  generate_images?: boolean  // If set, asks for responseModalities ['TEXT', 'IMAGE'] (true) or ['TEXT'] (false); unset, membrane's Gemini adapter asks for images when the model's name contains 'image'

  // Text attachment config
  include_text_attachments: boolean
  max_text_attachment_kb: number  // Max size per text attachment in KB

  // Reply tag config
  include_reply_tags?: boolean  // If true, keep <reply:@username> in context (default: false, matching Chapter2)

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
  message_delimiter?: string  // Added to the stop sequences
  turn_end_token?: string  // Added to the stop sequences; with the completions formatter, also appended after each message (e.g., '<eot>' for Gemini)
  
  // Retries
  llm_retries: number
  discord_backoff_max: number
  deferred_retries: boolean
  supports_continuation?: boolean  // If false, `m continue` is rejected when the last message is the bot's own, and so is every continuation-emoji reaction (default: true)

  // Misc
  system_prompt?: string
  system_prompt_file?: string  // Read from <CONFIG_PATH>/bots/<file>, or <EMS_PATH>/<BOT_NAME>/<file> in EMS mode
  context_prefix?: string      // Prefix content to insert as first assistant message (cached)
  context_prefix_file?: string  // Read from <CONFIG_PATH>/bots/<file>, or <EMS_PATH>/<BOT_NAME>/<file> in EMS mode
  prefill_user_message?: string       // Custom content for synthetic user message (replaces '[Start]')
  prefill_user_message_file?: string  // Read from <CONFIG_PATH>/bots/<file>, or <EMS_PATH>/<BOT_NAME>/<file> in EMS mode
  reply_on_random: number
  reply_on_name: boolean
  max_queued_replies: number
  
  // Loop prevention
  // A mention doesn't activate the bot when its reply chain, followed back from the
  // mentioning message to the first human message, holds at least this many bot
  // authors in turn (a run of one bot's messages counts once). Default: 2.
  max_bot_reply_chain_depth: number
  bot_reply_chain_depth_emote: string  // Reaction added when max_bot_reply_chain_depth is reached (default: '🔁')
  
  // Message filtering
  ignore_dotted_messages: boolean  // If true (default), dot-prefixed messages are hidden from context and don't trigger activation, unless reacted to with 👁️‍🗨️

  // Reaction triggers
  continuation_emoji?: string  // Emoji that triggers continuation when reacted on the bot's message (default: '▶️')

  // Bot mode
  mode?: 'chat' | 'prefill' | 'base-model'  // 'chat' = native formatter, no prefill; 'prefill' = anthropic-xml with prefill; 'base-model' = completions formatter. Unset: the vendor's formatter for the model, else anthropic-xml for Claude models and native otherwise

  // API mode
  api_only?: boolean  // If true, disable Discord activation handling - only serve API requests

  // Speaker gating
  // If set, the bot activates only where its bot name (BOT_NAME, or else its
  // Discord username) or its configured `name` is in this list, compared
  // case-insensitively. Usually set in a channel's pinned .config. It covers both
  // user-triggered and self-activation paths.
  may_speak?: string[]
  
  // Soma integration (credit system)
  soma?: SomaConfig

  // Participant display
  // When true, participant labels in the LLM context use Discord display names
  // (globalName/nickname) instead of usernames.
  use_display_names?: boolean

  // Override use_display_names for one participant class. With neither set,
  // bots get display names and humans get usernames.
  use_display_names_bots?: boolean
  use_display_names_humans?: boolean

  // Mention format template for LLM context. {name} is replaced with the resolved name.
  // Applies to both inline mentions and reply tags. Unset, a mention reads @Name for
  // someone shown by a display name other than their username, and <@username>
  // otherwise.
  mention_format?: string

  // Participant stop sequences
  // When true, membrane's anthropic-xml and completions formatters also add stop
  // sequences for participant names. Default: false.
  participant_stop_sequences?: boolean

  // Provider-specific params (passed through to LLM provider as-is)
  // e.g., { reasoning: { effort: "none" } } for OpenRouter/grok
  provider_params?: Record<string, unknown>

  // Streaming control
  // When false, LLM calls don't stream: membrane makes one complete() call, even with
  // the TTS relay active, and a request on the native tool path goes without tools.
  // Default: true.
  streaming?: boolean

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
  reconnect_interval_ms?: number  // Reconnect delay in ms
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
    /** Add lowercased stop sequence variants to catch mixed-case simming (default: false) */
    case_insensitive_stops?: boolean
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
  /** State scope: 'global', 'channel' (default) or 'epic', or 'off' to disable the plugin */
  state_scope?: 'global' | 'channel' | 'epic' | 'off'
  /** Any other plugin-specific settings */
  [key: string]: any
}

// ============================================================================
// Soma Integration (Credit System)
// ============================================================================

/**
 * When enabled, Soma charges ichor (credits) for direct triggers, and blocks one
 * whose user can't afford it or whose bot isn't registered with Soma. If Soma
 * can't be reached or answers with another error, the activation goes ahead.
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
  /**
   * The bot's text that the cached exchange reconstructs: for inline tools the
   * activation's whole output, XML tool calls included; for a native tool call
   * the visible prose posted in its round, or '' when the round posted none.
   */
  originalCompletionText: string
  /** All Discord messages emitted by the activation (tool-cache liveness anchors). */
  botMessageIds?: string[]
  /**
   * Subset of botMessageIds whose visible text is reconstructed by
   * originalCompletionText: for a native tool call, the messages that posted
   * its round's prose. Only these messages may be removed from raw Discord
   * context before the cached tool exchange is interleaved. An entry written
   * before this field existed has none, and covers all its botMessageIds.
   */
  coveredMessageIds?: string[]
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
  authorRoles?: string[]  // Guild role names (populated from member.roles)
  mentions: string[]  // User IDs
  referencedMessage?: string  // Reply to message ID
  webhookId?: string  // Set when sent through a webhook (such as Oblique): author.id is then the webhook's
}

export interface DiscordAttachment {
  id: string
  url: string
  filename: string
  contentType?: string
  size: number
  width?: number
  height?: number
  /** Length in seconds, when Discord reports one (a voice message's). */
  duration?: number
  /** True for the attachment of a voice message, a message Discord flags
   *  IsVoiceMessage: one audio attachment and no text. */
  voiceMessage?: boolean
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
    /** Whether context was trimmed to the cache anchor (overshoot correction) */
    cacheAnchorTrimmed?: boolean
  }
}

export interface CachedImage {
  url: string
  data: Buffer
  mediaType: string
  hash: string
  width?: number
  height?: number
  tokenEstimate?: number  // An estimate of Anthropic's ceil(width / 28) * ceil(height / 28) image tokens
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
  receivedAt?: number
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
