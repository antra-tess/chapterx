/**
 * Trace Collector
 * 
 * Accumulates events during an activation to build a complete trace.
 * Used via AsyncLocalStorage so any component can log to the current trace.
 */

import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import {
  ActivationTrace,
  ActivationInfo,
  ContextBuildInfo,
  ContextMessageInfo,
  LLMCallInfo,
  ToolExecutionInfo,
  OutcomeInfo,
  MessageTransformation,
  RawDiscordMessage,
  LogEntry,
} from './types.js'

// ============================================================================
// Trace Context (AsyncLocalStorage)
// ============================================================================

const traceContext = new AsyncLocalStorage<TraceCollector>()

/**
 * Get the current trace collector (if we're inside an activation)
 */
export function getCurrentTrace(): TraceCollector | undefined {
  return traceContext.getStore()
}

/**
 * Run a function with a trace collector context
 * 
 * If the function throws, the error is recorded in the trace and the trace
 * is still returned (along with the error) so it can be written to disk.
 */
export async function withTrace<T>(
  channelId: string,
  triggeringMessageId: string,
  botId: string,
  fn: (trace: TraceCollector) => Promise<T>,
  channelName?: string
): Promise<{ result?: T; trace: ActivationTrace; error?: Error; channelName?: string }> {
  const collector = new TraceCollector(channelId, triggeringMessageId, botId)
  
  try {
    const result = await traceContext.run(collector, () => fn(collector))
    const trace = collector.finalize()
    return { result, trace, channelName }
  } catch (err) {
    // Record the error in the trace
    const error = err instanceof Error ? err : new Error(String(err))
    collector.recordError('llm_call', error)  // Default to llm_call phase, could be refined
    
    // Log the error to the trace
    collector.captureLog('error', `Activation failed: ${error.message}`, {
      stack: error.stack,
    })
    
    const trace = collector.finalize()
    return { trace, error, channelName }
  }
}

// ============================================================================
// Trace Collector
// ============================================================================

export class TraceCollector {
  private traceId: string
  private startTime: Date
  private channelId: string
  private triggeringMessageId: string
  private botId: string
  
  private guildId?: string
  private botUserId?: string
  private config?: Record<string, any>
  
  private activation?: ActivationInfo
  private rawDiscordMessages?: RawDiscordMessage[]
  private contextBuild?: ContextBuildInfo
  private llmCalls: LLMCallInfo[] = []
  private toolExecutions: ToolExecutionInfo[] = []
  private outcome?: OutcomeInfo
  private logs: LogEntry[] = []
  
  // For tracking current LLM call (used by provider)
  private currentLLMCall?: {
    callId: string
    depth: number
    startedAt: Date
  }
  
  constructor(channelId: string, triggeringMessageId: string, botId: string) {
    this.traceId = randomUUID().slice(0, 8)  // Short ID for readability
    this.startTime = new Date()
    this.channelId = channelId
    this.triggeringMessageId = triggeringMessageId
    this.botId = botId
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Setters for metadata
  // ──────────────────────────────────────────────────────────────────────────
  
  setGuildId(guildId: string): void {
    this.guildId = guildId
  }
  
  setBotUserId(userId: string): void {
    this.botUserId = userId
  }
  
  setConfig(config: Record<string, any>): void {
    // Clone config to avoid mutations and remove sensitive data
    this.config = { ...config }
    // Don't store tokens or other sensitive fields
    delete this.config.discord_token
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Log Capture
  // ──────────────────────────────────────────────────────────────────────────
  
  /**
   * Capture a log entry
   */
  captureLog(
    level: LogEntry['level'],
    message: string,
    data?: Record<string, unknown>
  ): void {
    this.logs.push({
      offsetMs: Date.now() - this.startTime.getTime(),
      level,
      message,
      data,
    })
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Raw Discord Messages
  // ──────────────────────────────────────────────────────────────────────────
  
  /**
   * Store raw Discord messages before transformation
   */
  recordRawDiscordMessages(messages: RawDiscordMessage[]): void {
    this.rawDiscordMessages = messages
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Activation Recording
  // ──────────────────────────────────────────────────────────────────────────
  
  recordActivation(info: ActivationInfo): void {
    this.activation = info
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Context Build Recording
  // ──────────────────────────────────────────────────────────────────────────
  
  recordContextBuild(info: ContextBuildInfo): void {
    this.contextBuild = info
  }
  
  /**
   * Helper to build ContextMessageInfo from a participant message
   */
  static buildMessageInfo(
    position: number,
    discordMessageId: string | null,
    participant: string,
    content: string,
    options: {
      tokenEstimate: number
      transformations?: MessageTransformation[]
      isTrigger?: boolean
      hasImages?: boolean
      imageCount?: number
      hasCacheControl?: boolean
      discordTimestamp?: Date
    }
  ): ContextMessageInfo {
    return {
      position,
      discordMessageId,
      participant,
      contentPreview: content.slice(0, 150) + (content.length > 150 ? '...' : ''),
      contentLength: content.length,
      tokenEstimate: options.tokenEstimate,
      transformations: options.transformations || [],
      isTrigger: options.isTrigger || false,
      hasImages: options.hasImages || false,
      imageCount: options.imageCount || 0,
      hasCacheControl: options.hasCacheControl || false,
      discordTimestamp: options.discordTimestamp,
    }
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // LLM Call Recording
  // ──────────────────────────────────────────────────────────────────────────
  
  /**
   * Start tracking an LLM call
   */
  startLLMCall(depth: number): string {
    const callId = `${this.traceId}-llm-${this.llmCalls.length}`
    this.currentLLMCall = {
      callId,
      depth,
      startedAt: new Date(),
    }
    return callId
  }
  
  /**
   * Complete an LLM call with results
   */
  completeLLMCall(
    callId: string,
    request: LLMCallInfo['request'],
    response: LLMCallInfo['response'],
    tokenUsage: LLMCallInfo['tokenUsage'],
    model: string,
    options?: {
      requestBodyRef?: string
      requestBodyRefs?: string[]
      responseBodyRef?: string
      responseBodyRefs?: string[]
      membraneRequestRef?: string
      membraneResponseRef?: string
      error?: LLMCallInfo['error']
    }
  ): void {
    if (!this.currentLLMCall || this.currentLLMCall.callId !== callId) {
      console.warn(`LLM call ${callId} not found in current trace`)
      return
    }

    const call: LLMCallInfo = {
      callId,
      depth: this.currentLLMCall.depth,
      startedAt: this.currentLLMCall.startedAt,
      durationMs: Date.now() - this.currentLLMCall.startedAt.getTime(),
      model,
      request,
      response,
      tokenUsage,
      // Keep requestBodyRef for backwards compat (first request), add requestBodyRefs for all
      requestBodyRef: options?.requestBodyRef ?? options?.requestBodyRefs?.[0],
      requestBodyRefs: options?.requestBodyRefs,
      responseBodyRef: options?.responseBodyRef ?? options?.responseBodyRefs?.[options?.responseBodyRefs?.length - 1],
      responseBodyRefs: options?.responseBodyRefs,
      membraneRequestRef: options?.membraneRequestRef,
      membraneResponseRef: options?.membraneResponseRef,
      error: options?.error,
    }

    this.llmCalls.push(call)
    this.currentLLMCall = undefined
  }
  
  /**
   * Record an LLM call error
   */
  failLLMCall(
    callId: string,
    error: LLMCallInfo['error'],
    options?: {
      requestBodyRef?: string
      requestBodyRefs?: string[]
      model?: string
      request?: LLMCallInfo['request']
    }
  ): void {
    if (!this.currentLLMCall || this.currentLLMCall.callId !== callId) {
      return
    }

    const call: LLMCallInfo = {
      callId,
      depth: this.currentLLMCall.depth,
      startedAt: this.currentLLMCall.startedAt,
      durationMs: Date.now() - this.currentLLMCall.startedAt.getTime(),
      model: options?.model || 'unknown',
      request: options?.request || {
        messageCount: 0,
        systemPromptLength: 0,
        hasTools: false,
        toolCount: 0,
      },
      requestBodyRef: options?.requestBodyRef ?? options?.requestBodyRefs?.[0],
      requestBodyRefs: options?.requestBodyRefs,
      response: {
        stopReason: 'end_turn',
        contentBlocks: 0,
        textLength: 0,
        toolUseCount: 0,
      },
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      error,
    }

    this.llmCalls.push(call)
    this.currentLLMCall = undefined
  }
  
  getCurrentLLMCallId(): string | undefined {
    return this.currentLLMCall?.callId
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Tool Execution Recording
  // ──────────────────────────────────────────────────────────────────────────
  
  recordToolExecution(info: Omit<ToolExecutionInfo, 'llmCallId'>): void {
    const llmCallId = this.llmCalls[this.llmCalls.length - 1]?.callId || 'unknown'
    this.toolExecutions.push({
      ...info,
      llmCallId,
    })
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Outcome Recording
  // ──────────────────────────────────────────────────────────────────────────
  
  recordOutcome(info: OutcomeInfo): void {
    this.outcome = info
  }
  
  recordError(
    phase: 'context_build' | 'llm_call' | 'tool_execution' | 'discord_send',
    error: Error
  ): void {
    this.outcome = {
      success: false,
      responseText: '',
      responseLength: 0,
      sentMessageIds: [],
      messagesSent: 0,
      maxToolDepth: this.llmCalls.length,
      hitMaxToolDepth: false,
      error: {
        message: error.message,
        phase,
        stack: error.stack,
      },
      stateUpdates: {
        cacheMarkerUpdated: false,
        messageCountReset: false,
      },
    }
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Finalization
  // ──────────────────────────────────────────────────────────────────────────
  
  finalize(): ActivationTrace {
    return {
      traceId: this.traceId,
      timestamp: this.startTime,
      channelId: this.channelId,
      guildId: this.guildId,
      triggeringMessageId: this.triggeringMessageId,
      botId: this.botId,
      botUserId: this.botUserId,
      activation: this.activation || {
        reason: 'mention',
        triggerEvents: [],
      },
      rawDiscordMessages: this.rawDiscordMessages,
      contextBuild: this.contextBuild,
      llmCalls: this.llmCalls,
      toolExecutions: this.toolExecutions,
      outcome: this.outcome,
      logs: this.logs,
      durationMs: Date.now() - this.startTime.getTime(),
      config: this.config,
    }
  }
  
  // ──────────────────────────────────────────────────────────────────────────
  // Accessors
  // ──────────────────────────────────────────────────────────────────────────
  
  getTraceId(): string {
    return this.traceId
  }
  
  getLLMCallCount(): number {
    return this.llmCalls.length
  }
}

// ============================================================================
// Convenience functions for components to use
// ============================================================================

/**
 * Record context build info to current trace (if any)
 */
export function traceContextBuild(info: ContextBuildInfo): void {
  getCurrentTrace()?.recordContextBuild(info)
}

/**
 * Start an LLM call in current trace
 */
export function traceStartLLMCall(depth: number): string | undefined {
  return getCurrentTrace()?.startLLMCall(depth)
}

/**
 * Complete an LLM call in current trace
 */
export function traceCompleteLLMCall(
  callId: string,
  request: LLMCallInfo['request'],
  response: LLMCallInfo['response'],
  tokenUsage: LLMCallInfo['tokenUsage'],
  model: string,
  options?: {
    requestBodyRef?: string
    requestBodyRefs?: string[]
    responseBodyRef?: string
    responseBodyRefs?: string[]
    membraneRequestRef?: string
    membraneResponseRef?: string
  }
): void {
  getCurrentTrace()?.completeLLMCall(callId, request, response, tokenUsage, model, options)
}

/**
 * Record tool execution in current trace
 */
export function traceToolExecution(info: Omit<ToolExecutionInfo, 'llmCallId'>): void {
  getCurrentTrace()?.recordToolExecution(info)
}

/**
 * Capture a log entry to current trace
 */
export function traceLog(
  level: LogEntry['level'],
  message: string,
  data?: Record<string, unknown>
): void {
  getCurrentTrace()?.captureLog(level, message, data)
}

/**
 * Record raw Discord messages to current trace
 */
export function traceRawDiscordMessages(messages: RawDiscordMessage[]): void {
  getCurrentTrace()?.recordRawDiscordMessages(messages)
}

/**
 * Set bot config in current trace
 */
export function traceSetConfig(config: Record<string, any>): void {
  getCurrentTrace()?.setConfig(config)
}

