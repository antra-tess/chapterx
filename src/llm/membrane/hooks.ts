/**
 * Membrane Hooks
 * 
 * Tracing hooks that wire membrane's lifecycle events to chapterx's TraceCollector.
 * These hooks preserve the sophisticated tracing system while using membrane for LLM calls.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getCurrentTrace } from '../../trace/index.js';
import { logger } from '../../utils/logger.js';
import { processRequestForLogging } from '../../utils/blob-store.js';
import type {
  NormalizedRequest,
  NormalizedResponse,
  MembraneContentBlock,
} from './adapter.js';

// ============================================================================
// Membrane Hook Types (local definitions until package is installed)
// ============================================================================

interface ErrorInfo {
  message: string;
  code?: string;
  retryable: boolean;
}

export interface MembraneHooks {
  beforeRequest?: (
    request: NormalizedRequest,
    rawRequest: unknown
  ) => unknown | Promise<unknown>;
  
  afterResponse?: (
    response: NormalizedResponse,
    rawResponse: unknown
  ) => NormalizedResponse | Promise<NormalizedResponse>;
  
  onError?: (
    error: ErrorInfo,
    attempt: number
  ) => 'retry' | 'abort' | Promise<'retry' | 'abort'>;
}

// ============================================================================
// Tracing Hooks Factory
// ============================================================================

/**
 * Create membrane hooks wired to chapterx's tracing system
 * 
 * These hooks use a request-scoped context to track state across
 * beforeRequest → afterResponse/onError without relying on closure state.
 * This ensures correct behavior with concurrent requests.
 */
export function createTracingHooks(): MembraneHooks {
  // Use WeakMap to associate request objects with their call context
  // This handles concurrent requests safely
  const requestContexts = new WeakMap<object, RequestContext>();
  
  return {
    /**
     * Called before sending request to provider
     */
    beforeRequest: async (
      request: NormalizedRequest,
      rawRequest: unknown
    ): Promise<unknown> => {
      const trace = getCurrentTrace();
      
      // Log request to file for debugging (matches old provider behavior)
      const requestRef = logRequestToFile(rawRequest);
      
      if (trace) {
        const callId = trace.startLLMCall(trace.getLLMCallCount());
        
        // Store context for this request
        const context: RequestContext = {
          callId,
          startedAt: Date.now(),
          requestRef,
          request: {
            messageCount: request.messages.length,
            systemPromptLength: request.system?.length ?? 0,
            hasTools: !!request.tools && request.tools.length > 0,
            toolCount: request.tools?.length ?? 0,
            temperature: request.config.temperature,
            maxTokens: request.config.maxTokens,
            stopSequences: Array.isArray(request.stopSequences)
              ? request.stopSequences
              : request.stopSequences?.sequences,
            apiBaseUrl: 'membrane', // Tag as membrane request
          },
        };
        
        // Store using the raw request object as key
        if (rawRequest && typeof rawRequest === 'object') {
          requestContexts.set(rawRequest, context);
        }
      }
      
      // Return rawRequest unmodified (or could modify for debugging)
      return rawRequest;
    },
    
    /**
     * Called after receiving response from provider
     */
    afterResponse: async (
      response: NormalizedResponse,
      rawResponse: unknown
    ): Promise<NormalizedResponse> => {
      const trace = getCurrentTrace();
      
      // Log response to file for debugging (matches old provider behavior)
      const responseRef = logResponseToFile(rawResponse);
      
      // Try to find the context from raw request stored in response
      let context: RequestContext | undefined;
      if (response.raw?.request && typeof response.raw.request === 'object') {
        context = requestContexts.get(response.raw.request);
        requestContexts.delete(response.raw.request);
      }
      
      if (trace && context) {
        const textLength = response.content
          .filter((b: MembraneContentBlock) => b.type === 'text')
          .reduce((sum: number, b: MembraneContentBlock) => sum + ((b as { text?: string }).text?.length ?? 0), 0);
        
        const toolUseCount = response.content
          .filter((b: MembraneContentBlock) => b.type === 'tool_use')
          .length;
        
        // Map 'abort' to 'end_turn' for trace compatibility
        const mappedStopReason = response.stopReason === 'abort' 
          ? 'end_turn' 
          : response.stopReason;
        
        trace.completeLLMCall(
          context.callId,
          context.request,
          {
            stopReason: mappedStopReason as 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal',
            contentBlocks: response.content.length,
            textLength,
            toolUseCount,
          },
          {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheCreationTokens: response.details.usage.cacheCreationTokens,
            cacheReadTokens: response.details.usage.cacheReadTokens,
          },
          response.details.model.actual,
          {
            requestBodyRef: context.requestRef,
            responseBodyRef: responseRef,
          },
        );
      }
      
      return response;
    },
    
    /**
     * Called on error, before retry decision
     */
    onError: async (
      error: ErrorInfo,
      attempt: number
    ): Promise<'retry' | 'abort'> => {
      const trace = getCurrentTrace();
      
      // Log the error to trace
      trace?.captureLog('error', `Membrane error (attempt ${attempt}): ${error.message}`, {
        code: error.code,
        retryable: error.retryable,
        attempt,
      });
      
      // Let membrane's default retry logic handle the decision
      // Return 'retry' for retryable errors, 'abort' otherwise
      return error.retryable ? 'retry' : 'abort';
    },
  };
}

// ============================================================================
// Alternative: Explicit Context Hooks
// ============================================================================

/**
 * Create hooks with explicit context passing
 * 
 * This alternative approach passes context through a shared object
 * that must be provided by the caller. Useful when the caller wants
 * direct access to the call metadata.
 */
export function createTracingHooksWithContext(
  sharedContext: SharedHookContext
): MembraneHooks {
  return {
    beforeRequest: async (request: NormalizedRequest, rawRequest: unknown) => {
      const trace = getCurrentTrace();
      
      if (trace) {
        sharedContext.callId = trace.startLLMCall(trace.getLLMCallCount());
        sharedContext.startedAt = Date.now();
        sharedContext.request = {
          messageCount: request.messages.length,
          systemPromptLength: request.system?.length ?? 0,
          hasTools: !!request.tools && request.tools.length > 0,
          toolCount: request.tools?.length ?? 0,
          temperature: request.config.temperature,
          maxTokens: request.config.maxTokens,
        };
      }
      
      return rawRequest;
    },
    
    afterResponse: async (response: NormalizedResponse, _rawResponse: unknown) => {
      const trace = getCurrentTrace();
      
      if (trace && sharedContext.callId) {
        const textLength = response.content
          .filter((b: MembraneContentBlock) => b.type === 'text')
          .reduce((sum: number, b: MembraneContentBlock) => sum + ((b as { text?: string }).text?.length ?? 0), 0);
        
        // Map 'abort' to 'end_turn' for trace compatibility
        const mappedStopReason = response.stopReason === 'abort' 
          ? 'end_turn' 
          : response.stopReason;
        
        trace.completeLLMCall(
          sharedContext.callId,
          sharedContext.request ?? {
            messageCount: 0,
            systemPromptLength: 0,
            hasTools: false,
            toolCount: 0,
          },
          {
            stopReason: mappedStopReason as 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal',
            contentBlocks: response.content.length,
            textLength,
            toolUseCount: response.content.filter((b: MembraneContentBlock) => b.type === 'tool_use').length,
          },
          response.usage,
          response.details.model.actual,
        );
        
        // Reset context
        sharedContext.callId = undefined;
        sharedContext.request = undefined;
      }
      
      return response;
    },
    
    onError: async (error: ErrorInfo, attempt: number) => {
      const trace = getCurrentTrace();
      
      // Log the error to trace
      trace?.captureLog('error', `Membrane error (attempt ${attempt}): ${error.message}`, {
        code: error.code,
        retryable: error.retryable,
        attempt,
      });
      
      // Only record as failed if we're not going to retry
      // Otherwise we'd have both a failed and successful record for the same logical call
      if (!error.retryable && trace && sharedContext.callId) {
        trace.failLLMCall(sharedContext.callId, {
          message: error.message,
          code: error.code,
          retryCount: attempt,
        });
      }
      
      return error.retryable ? 'retry' : 'abort';
    },
  };
}

// ============================================================================
// Types
// ============================================================================

interface RequestContext {
  callId: string;
  startedAt: number;
  requestRef?: string;
  request: {
    messageCount: number;
    systemPromptLength: number;
    hasTools: boolean;
    toolCount: number;
    temperature?: number;
    maxTokens?: number;
    stopSequences?: string[];
    apiBaseUrl?: string;
  };
}

// ============================================================================
// File Logging (matches old provider behavior)
// ============================================================================

/**
 * Log request to file for debugging
 * Matches behavior of AnthropicProvider/OpenRouterProvider
 */
function logRequestToFile(params: unknown): string | undefined {
  try {
    const dir = join(process.cwd(), 'logs', 'llm-requests');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `request-${timestamp}.json`;
    const filename = join(dir, basename);

    // Extract images to blob store before logging (if available)
    let processedParams = params;
    try {
      processedParams = processRequestForLogging(params);
    } catch {
      // processRequestForLogging may not handle all formats
    }

    writeFileSync(filename, JSON.stringify(processedParams, null, 2));
    logger.debug({ filename }, 'Logged membrane request to file');
    return basename;
  } catch (error) {
    logger.warn({ error }, 'Failed to log membrane request to file');
    return undefined;
  }
}

/**
 * Log response to file for debugging
 */
function logResponseToFile(response: unknown): string | undefined {
  try {
    const dir = join(process.cwd(), 'logs', 'llm-responses');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `response-${timestamp}.json`;
    const filename = join(dir, basename);

    writeFileSync(filename, JSON.stringify(response, null, 2));
    logger.debug({ filename }, 'Logged membrane response to file');
    return basename;
  } catch (error) {
    logger.warn({ error }, 'Failed to log membrane response to file');
    return undefined;
  }
}

export interface SharedHookContext {
  callId?: string;
  startedAt?: number;
  request?: {
    messageCount: number;
    systemPromptLength: number;
    hasTools: boolean;
    toolCount: number;
    temperature?: number;
    maxTokens?: number;
  };
}

// ============================================================================
// Tool Execution Tracing
// ============================================================================

/**
 * Record a tool execution to the current trace
 * 
 * Call this from your tool executor when a tool completes.
 */
export function traceToolExecution(params: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
  sentToDiscord: boolean;
  error?: string;
  imageCount?: number;
}): void {
  const trace = getCurrentTrace();
  
  if (trace) {
    trace.recordToolExecution({
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      input: params.input,
      output: params.output.slice(0, 1000), // Truncate for trace
      outputTruncated: params.output.length > 1000,
      fullOutputLength: params.output.length,
      durationMs: params.durationMs,
      sentToDiscord: params.sentToDiscord,
      error: params.error,
      imageCount: params.imageCount,
    });
  }
}

