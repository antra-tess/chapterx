/**
 * Tool Plugin Types
 */

import { ContentBlock } from '../../types.js'
import type { StateScope } from './state.js'

export interface ToolPlugin {
  name: string
  description: string
  tools: PluginTool[]
  
  /**
   * Return context injections to be inserted into the LLM context.
   * Called during context building.
   */
  getContextInjections?: (context: PluginStateContext) => Promise<ContextInjection[]>
  
  /**
   * Called after a tool from this plugin is executed.
   * Useful for updating injection depth after modifications.
   */
  onToolExecution?: (
    toolName: string,
    input: any,
    result: any,
    context: PluginStateContext
  ) => Promise<void>
  
  /**
   * Post-process tool result before returning to LLM.
   * Allows plugins to inject actual data (e.g., note content) into the result.
   * Called after handler, before result is sent to LLM.
   */
  postProcessResult?: (
    toolName: string,
    input: any,
    result: string,
    context: PluginStateContext
  ) => Promise<string>
  
  /**
   * Called when plugin is initialized for a channel.
   * Use to set up initial state or inherit from parent.
   */
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

/**
 * An image visible to the bot in its current context
 */
export interface VisibleImage {
  /** Index from most recent (1 = most recent) */
  index: number
  /** Source of the image */
  source: 'discord' | 'mcp_tool'
  /** For discord: message author. For mcp_tool: tool name */
  sourceDetail: string
  /** Base64 encoded image data */
  data: string
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: string
  /** Optional description/context about the image */
  description?: string
}

/**
 * Basic plugin context for tool execution
 */
export interface PluginContext {
  botId: string
  channelId: string
  guildId: string
  currentMessageId: string  // The triggering message
  config: any  // Current bot config
  sendMessage: (content: string) => Promise<string[]>  // Send a message, returns message IDs
  pinMessage: (messageId: string) => Promise<void>  // Pin a message
  uploadFile?: (buffer: Buffer, filename: string, contentType: string, caption?: string) => Promise<string[]>  // Upload a file
  /** Images visible to the bot (from Discord context + MCP tool results), newest first */
  visibleImages?: VisibleImage[]
}

/**
 * Extended context with state management for context injections
 */
export interface PluginStateContext extends PluginContext {
  /**
   * Get state for the given scope.
   * - global: Shared across all channels
   * - channel: Per-channel, inherits through .history and threads
   * - epic: Event-sourced, supports fork/rollback
   */
  getState<T>(scope: StateScope): Promise<T | null>
  
  /**
   * Set state for the given scope.
   * For 'epic' scope, this records an event tied to currentMessageId.
   */
  setState<T>(scope: StateScope, state: T): Promise<void>
  
  /**
   * Get state as it was at a specific message (epic scope only).
   * Useful for debugging or viewing historical state.
   */
  getStateAtMessage<T>(messageId: string): Promise<T | null>
  
  /**
   * Get the set of message IDs currently in context.
   * Used for epic scope rollback (events for deleted messages are skipped).
   */
  contextMessageIds: Set<string>
  
  /**
   * Calculate how many messages have passed since a given message ID.
   * Returns Infinity if messageId is not in context.
   */
  messagesSinceId(messageId: string | null): number
  
  /**
   * Inheritance info for channel state
   */
  inheritanceInfo?: {
    parentChannelId?: string      // For threads
    historyOriginChannelId?: string  // For .history jumps
  }
  
  /**
   * Plugin-specific configuration from bot config.
   * Includes state_scope and any custom plugin settings.
   */
  pluginConfig?: {
    state_scope?: StateScope
    [key: string]: any
  }
  
  /**
   * Configured state scope for this plugin (convenience accessor).
   * Defaults to 'channel' if not configured.
   */
  configuredScope: StateScope
}

/**
 * A context injection from a plugin.
 * Injected into LLM context at a calculated depth.
 */
export interface ContextInjection {
  /** Unique ID for this injection (used for deduplication) */
  id: string
  
  /** Content to inject - can be text or content blocks */
  content: string | ContentBlock[]
  
  /** 
   * Target depth from newest message (0 = most recent).
   * The injection ages toward this depth over time.
   */
  targetDepth: number
  
  /**
   * Message ID when content was last modified.
   * Used to calculate current depth (starts at 0, ages toward targetDepth).
   * If null, injection is at targetDepth.
   */
  lastModifiedAt?: string | null
  
  /**
   * Priority for ordering when multiple injections are at the same depth.
   * Higher priority = appears first. Default: 0
   */
  priority?: number
  
  /**
   * If true, this injection is inserted as a system message.
   * Otherwise inserted as a participant message.
   */
  asSystem?: boolean
}

