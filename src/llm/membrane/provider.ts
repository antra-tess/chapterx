/**
 * Membrane Provider
 *
 * Wraps the membrane library to provide LLM completions.
 * This is the sole provider for LLM calls in the system.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LLMCompletion, LLMRequest } from '../../types.js';
import { getCurrentTrace } from '../../trace/index.js';
import { StreamingMetricsCollector } from '../../trace/streaming-collector.js';
import { getStreamingMetricsWriter } from '../../trace/streaming-writer.js';
import { logger } from '../../utils/logger.js';
import {
  toMembraneRequest,
  fromMembraneResponse,
  type NormalizedRequest,
  type NormalizedResponse,
} from './adapter.js';
import { resolveFormatterForModel } from './factory.js';
import { NativeFormatter, AnthropicXmlFormatter, CompletionsFormatter } from '@animalabs/membrane';
import type { CompleteOptions, StreamOptions as MembraneStreamOptions } from '@animalabs/membrane';

// ============================================================================
// Membrane Interface (local definition until package is installed)
// ============================================================================

/**
 * Membrane class interface - matches the membrane package API
 * This allows the provider to compile before membrane is installed.
 */
interface Membrane {
  complete(
    request: NormalizedRequest,
    options?: CompleteOptions
  ): Promise<NormalizedResponse>;

  stream(
    request: NormalizedRequest,
    options?: MembraneStreamOptions
  ): Promise<NormalizedResponse>;
}

// ============================================================================
// Provider Implementation
// ============================================================================

/** What the request logs write in place of a media payload: its length. */
function base64Marker(payload: string): string {
  return `[BASE64_DATA_${payload.length}_BYTES]`;
}

/** A `data:...;base64,` URL with its payload replaced by `base64Marker`, keeping
 *  its media type; any other string as it was. */
function stripDataUrl(value: string): string {
  const header = value.slice(0, value.indexOf(',') + 1);
  if (!header.startsWith('data:') || !header.endsWith(';base64,')) return value;
  return `${header}${base64Marker(value.slice(header.length))}`;
}

export class MembraneProvider {
  readonly name = 'membrane';

  private membrane: Membrane;

  constructor(membrane: Membrane) {
    this.membrane = membrane;
  }

  /**
   * Complete a request from LLMRequest format
   * 
   * This is the preferred method as it allows membrane to handle the full
   * prefill/chat transform rather than going through middleware's transform.
   */
  async completeFromLLMRequest(request: LLMRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace();
    const callId = trace?.startLLMCall(trace.getLLMCallCount());

    logger.debug({ hasTrace: !!trace, callId, model: request.config.model }, 'Starting membrane complete');

    // Track request/response refs for trace
    let requestRef: string | undefined;
    let responseRef: string | undefined;

    try {
      const normalizedRequest = toMembraneRequest(request);

      const formatterType = resolveFormatterForModel(request.config.model, request.config.mode);
      const formatter = formatterType === 'native'
        ? new NativeFormatter()
        : formatterType === 'anthropic-xml'
          ? new AnthropicXmlFormatter()
          : formatterType === 'completions'
            ? new CompletionsFormatter({
                eotToken: request.config.turnEndToken,
              })
            : undefined;

      logger.debug({ model: request.config.model, formatter: formatterType }, 'Using formatter for model');

      const response = await this.membrane.complete(normalizedRequest as any, {
        formatter,
        onRequest: (rawRequest: unknown) => {
          requestRef = this.logRequestToFile(rawRequest);
        },
        onResponse: (rawResponse: unknown) => {
          responseRef = this.logRawResponseToFile(rawResponse);
        },
      });
      const completion = fromMembraneResponse(response as any);
      
      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength: request.system_prompt?.length ?? 0,
            hasTools: !!request.tools && request.tools.length > 0,
            toolCount: request.tools?.length ?? 0,
            temperature: request.config.temperature,
            maxTokens: request.config.max_tokens,
            stopSequences: request.stop_sequences,
          },
          {
            stopReason: completion.stopReason,
            contentBlocks: completion.content.length,
            textLength: completion.content
              .filter(b => b.type === 'text')
              .reduce((sum, b) => sum + (b as any).text.length, 0),
            toolUseCount: completion.content
              .filter(b => b.type === 'tool_use')
              .length,
          },
          completion.usage,
          completion.model,
          {
            requestBodyRef: requestRef,
            responseBodyRef: responseRef,
          },
        );
      }

      return completion;
      
    } catch (error: any) {
      // Direct console output for immediate visibility
      console.error('[MEMBRANE ERROR - complete()]', {
        message: error.message,
        name: error.name,
        code: error.code,
        type: error.type,
        status: error.status,
        model: request.config.model,
      });

      // Log error via structured logger
      logger.error({
        error: error.message || String(error),
        name: error.name,
        code: error.code,
        type: error.type,
        status: error.status,
        model: request.config.model,
        hasTrace: !!trace,
        hasCallId: !!callId,
      }, 'Membrane complete() failed');

      if (trace && callId) {
        logger.debug({ callId }, 'Recording error to trace via failLLMCall');
        trace.failLLMCall(callId, {
          message: error instanceof Error ? error.message : String(error),
          retryCount: 0,
        });
      } else {
        logger.warn({ hasTrace: !!trace, hasCallId: !!callId }, 'Cannot record error to trace - missing trace context or callId');
      }
      throw error;
    }
  }

  /**
   * Stream a request with tool execution support
   *
   * This provides access to membrane's streaming capabilities with
   * tool execution callbacks including enriched chunk metadata and block events.
   */
  async stream(
    request: LLMRequest,
    options: StreamOptions = {}
  ): Promise<LLMCompletion> {
    const trace = getCurrentTrace();
    const callId = trace?.startLLMCall(trace.getLLMCallCount());

    logger.debug({ hasTrace: !!trace, callId, model: request.config.model }, 'Starting membrane stream');

    const normalizedRequest = toMembraneRequest(request);

    // Log membrane request to file and capture ref for trace
    const membraneRequestRef = this.logMembraneRequestToFile(normalizedRequest);

    // Accumulate all request/response refs in tool loops
    const llmRequestRefs: string[] = [];
    const llmResponseRefs: string[] = [];

    // Streaming metrics collector — records per-chunk timing with full text
    const metricsCollector = new StreamingMetricsCollector(
      trace?.getBotId() ?? 'unknown',
      request.config.model,
      request.config.streaming === false ? 'synthesized' : 'stream',
      trace?.getTraceId(),
    );

    try {
      // Determine formatter: explicit override, else as resolveFormatterForModel resolves it
      const formatterType = options.formatterOverride
        ?? resolveFormatterForModel(request.config.model, request.config.mode);
      const formatter = formatterType === 'native'
        ? new NativeFormatter()
        : formatterType === 'anthropic-xml'
          ? new AnthropicXmlFormatter()
          : formatterType === 'completions'
            ? new CompletionsFormatter({
                eotToken: request.config.turnEndToken,
              })
            : undefined;

      logger.debug({ model: request.config.model, formatter: formatterType }, 'Using formatter for model');

      // Cast to any because our local types may not exactly match membrane's updated types
      const streamOptions: any = {
        // Wrap onChunk/onBlock to record metrics, then forward to caller
        onChunk: (text: string, meta: any) => {
          metricsCollector.recordChunk(text, meta);
          options.onChunk?.(text, meta);
        },
        onBlock: (event: any) => {
          metricsCollector.recordBlock(event);
          options.onBlock?.(event);
        },
        // With streaming off, membrane's stream() goes to complete(), which has
        // no tool loop, and in 0.5.81 to 0.6.0 it refuses onToolCalls instead.
        // A request without tools has nothing for the callback to run, so it
        // goes without and gets its answer. A request with tools keeps it, so
        // that 0.5.81 to 0.6.0 refuse tools that can't run rather than return
        // the model's calls unexecuted, as 0.5.47 does.
        onToolCalls: normalizedRequest.streaming === false && !normalizedRequest.tools?.length
          ? undefined
          : options.onToolCalls,
        onPreToolContent: options.onPreToolContent,
        onUsage: options.onUsage,
        maxToolDepth: options.maxToolDepth ?? 10,
        signal: options.signal,
        formatter,
        // Capture all LLM API requests in tool loops
        onRequest: (llmRequest: any) => {
          logger.debug({ hasData: !!llmRequest }, 'onRequest callback triggered');
          const ref = this.logRequestToFile(llmRequest);
          if (ref) llmRequestRefs.push(ref);
        },
        // Capture all LLM API responses in tool loops
        onResponse: (llmResponse: any) => {
          logger.debug({ hasData: !!llmResponse, type: typeof llmResponse }, 'onResponse callback triggered');
          const ref = this.logRawResponseToFile(llmResponse);
          logger.debug({ ref }, 'onResponse logged to file');
          if (ref) llmResponseRefs.push(ref);
        },
      };
      const response = await this.membrane.stream(normalizedRequest as any, streamOptions);

      // Log membrane response to file
      const membraneResponseRef = this.logResponseToFile(response);

      // Handle aborted responses (timeout, user cancel, etc.)
      // AbortedResponse has partialContent, not content — fromMembraneResponse would crash
      if ('aborted' in response && (response as any).aborted === true) {
        const aborted = response as any;
        logger.warn({ reason: aborted.reason, hasPartialContent: !!aborted.partialContent }, 'Stream was aborted');
        const completion: LLMCompletion = {
          content: (aborted.partialContent ?? []).map((b: any) => b),
          stopReason: 'end_turn',
          usage: {
            inputTokens: aborted.partialUsage?.inputTokens ?? 0,
            outputTokens: aborted.partialUsage?.outputTokens ?? 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          model: request.config.model,
          raw: null,
        };

        // Record to trace
        if (trace && callId) {
          trace.completeLLMCall(
            callId,
            {
              messageCount: request.messages.length,
              systemPromptLength: request.system_prompt?.length || 0,
              hasTools: (request.tools?.length || 0) > 0,
              toolCount: request.tools?.length || 0,
              temperature: request.config.temperature,
              maxTokens: request.config.max_tokens,
              stopSequences: request.stop_sequences,
            },
            {
              stopReason: 'end_turn',
              contentBlocks: completion.content.length,
              textLength: 0,
              toolUseCount: 0,
            },
            completion.usage,
            request.config.model,
            {
              requestBodyRefs: llmRequestRefs.length > 0 ? llmRequestRefs : undefined,
              responseBodyRefs: llmResponseRefs.length > 0 ? llmResponseRefs : undefined,
              membraneRequestRef,
              membraneResponseRef,
            },
          );
        }

        // Write streaming metrics (aborted)
        this.writeStreamingMetrics(metricsCollector, {
          usage: completion.usage,
          stopReason: 'end_turn',
        });

        return completion;
      }

      const completion = fromMembraneResponse(response as any);

      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength: request.system_prompt?.length || 0,
            hasTools: (request.tools?.length || 0) > 0,
            toolCount: request.tools?.length || 0,
            temperature: request.config.temperature,
            maxTokens: request.config.max_tokens,
            stopSequences: request.stop_sequences,
          },
          {
            stopReason: completion.stopReason,
            contentBlocks: completion.content.length,
            textLength: completion.content
              .filter(b => b.type === 'text')
              .map(b => (b as any).text?.length || 0)
              .reduce((a, b) => a + b, 0),
            toolUseCount: completion.content.filter(b => b.type === 'tool_use').length,
          },
          {
            inputTokens: completion.usage?.inputTokens || 0,
            outputTokens: completion.usage?.outputTokens || 0,
            cacheCreationTokens: completion.usage?.cacheCreationTokens,
            cacheReadTokens: completion.usage?.cacheReadTokens,
          },
          completion.model || request.config.model,
          {
            requestBodyRefs: llmRequestRefs.length > 0 ? llmRequestRefs : undefined,
            responseBodyRefs: llmResponseRefs.length > 0 ? llmResponseRefs : undefined,
            membraneRequestRef,
            membraneResponseRef,
          },
        );
      }

      // Write streaming metrics (success)
      this.writeStreamingMetrics(metricsCollector, {
        usage: {
          inputTokens: completion.usage?.inputTokens || 0,
          outputTokens: completion.usage?.outputTokens || 0,
          cacheCreationTokens: completion.usage?.cacheCreationTokens,
          cacheReadTokens: completion.usage?.cacheReadTokens,
        },
        stopReason: completion.stopReason,
      });

      return completion;
    } catch (error: any) {
      // Direct console output for immediate visibility
      console.error('[MEMBRANE ERROR - stream()]', {
        message: error.message,
        name: error.name,
        code: error.code,
        type: error.type,
        status: error.status,
        model: request.config.model,
        retryable: error.retryable,
        retryAfter: error.retryAfter,
      });

      // Log error via structured logger
      logger.error({
        error: error.message || String(error),
        name: error.name,
        code: error.code,
        type: error.type,
        status: error.status,
        model: request.config.model,
        retryable: error.retryable,
        retryAfter: error.retryAfter,
        hasTrace: !!trace,
        hasCallId: !!callId,
      }, 'Membrane stream() failed');

      // Record error to trace
      if (trace && callId) {
        logger.debug({ callId }, 'Recording error to trace via failLLMCall');
        trace.failLLMCall(callId, {
          message: `${error.name || 'Error'}: ${error.message}`,
          code: error.code,
          retryCount: 0,
        }, {
          requestBodyRefs: llmRequestRefs.length > 0 ? llmRequestRefs : undefined,
          model: request.config.model,
          request: {
            messageCount: request.messages.length,
            systemPromptLength: request.system_prompt?.length || 0,
            hasTools: (request.tools?.length || 0) > 0,
            toolCount: request.tools?.length || 0,
          },
        });
      } else {
        logger.warn({ hasTrace: !!trace, hasCallId: !!callId }, 'Cannot record error to trace - missing trace context or callId');
      }

      // Write streaming metrics (error — may have partial chunks before failure)
      this.writeStreamingMetrics(metricsCollector, {
        error: `${error.name || 'Error'}: ${error.message}`,
      });

      throw error;
    }
  }

  /**
   * Finalize and write streaming metrics. Never throws.
   */
  private writeStreamingMetrics(
    collector: StreamingMetricsCollector,
    options: {
      usage?: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number }
      stopReason?: string
      error?: string
    }
  ): void {
    try {
      const entry = collector.finalize(options);
      getStreamingMetricsWriter().writeMetrics(entry);
    } catch (err) {
      logger.warn({ err }, 'Failed to write streaming metrics');
    }
  }

  // ==========================================================================
  // Request/Response Logging
  // ==========================================================================

  /**
   * Log the actual LLM API request (from onRequest callback)
   */
  private logRequestToFile(request: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-requests');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basename = `request-${timestamp}.json`;
      const filename = join(dir, basename);

      // Replace each image, audio or document block's data with its length before logging
      const processedRequest = this.stripBase64FromRequest(request);
      writeFileSync(filename, JSON.stringify(processedRequest, null, 2));
      logger.debug({ filename }, 'Logged LLM API request to file');
      return basename;
    } catch (error) {
      logger.warn({ error }, 'Failed to log LLM API request to file');
      return undefined;
    }
  }

  /**
   * Log the membrane normalized request (for debugging membrane config)
   */
  private logMembraneRequestToFile(request: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'membrane-requests');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basename = `membrane-${timestamp}.json`;
      const filename = join(dir, basename);

      // Replace each image, audio or document block's data with its length before logging
      const processedRequest = this.stripBase64FromRequest(request);
      writeFileSync(filename, JSON.stringify(processedRequest, null, 2));
      logger.debug({ filename }, 'Logged membrane request to file');
      return basename;
    } catch (error) {
      logger.warn({ error }, 'Failed to log membrane request to file');
      return undefined;
    }
  }

  private logResponseToFile(response: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'membrane-responses');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basename = `membrane-response-${timestamp}.json`;
      const filename = join(dir, basename);

      // A streamed response carries the provider request it answered, media
      // inline, which is logged as the request logs log it
      const logged = response?.raw?.request
        ? { ...response, raw: { ...response.raw, request: this.stripBase64FromRequest(response.raw.request) } }
        : response;
      writeFileSync(filename, JSON.stringify(logged, null, 2));
      logger.debug({ filename }, 'Logged membrane response to file');
      return basename;
    } catch (error) {
      logger.warn({ error }, 'Failed to log membrane response to file');
      return undefined;
    }
  }

  /**
   * Log raw LLM API response (from onResponse callback)
   */
  private logRawResponseToFile(response: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-responses');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basename = `response-${timestamp}.json`;
      const filename = join(dir, basename);

      writeFileSync(filename, JSON.stringify(response, null, 2));
      logger.debug({ filename }, 'Logged raw LLM response to file');
      return basename;
    } catch (error) {
      logger.warn({ error }, 'Failed to log raw LLM response to file');
      return undefined;
    }
  }

  /**
   * A copy of a request for the request logs, and for the copy of it a streamed
   * response carries in the response log, with each media block's payload
   * (an image, audio or a document) replaced by `[BASE64_DATA_<length>_BYTES]`,
   * the payload's base64 length, wherever in the request's structure it sits:
   * - the `data` of a `source` of type 'base64' (Anthropic's and membrane's),
   *   of Gemini's `inlineData`, and of an `input_audio`;
   * - the payload of a `data:...;base64,` URL under a `url` key, where the
   *   OpenAI-style adapters put an image, or in an `image` array, where the
   *   Images API adapter puts an edit's input images. The URL keeps its media
   *   type.
   * These shapes are replaced wherever they sit, a tool's structured arguments
   * included. Everything else is kept as written: text, a data URL inside it
   * included, and anything an adapter sends as JSON text, such as a tool
   * result or a tool call's arguments.
   */
  private stripBase64FromRequest(request: any): any {
    return JSON.parse(JSON.stringify(request), (key, value) => {
      if (typeof value === 'string') return key === 'url' ? stripDataUrl(value) : value;
      if (key === 'image' && Array.isArray(value)) {
        return value.map((item) => (typeof item === 'string' ? stripDataUrl(item) : item));
      }
      if (value && typeof value.data === 'string'
          && ((key === 'source' && value.type === 'base64') || key === 'inlineData' || key === 'input_audio')) {
        return { ...value, data: base64Marker(value.data) };
      }
      return value;
    });
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Metadata for each streamed chunk
 * Matches membrane's ChunkMeta interface
 */
export interface ChunkMeta {
  /** Which membrane block this chunk belongs to */
  blockIndex: number;
  /** Type of block: 'text', 'thinking', 'tool_call', 'tool_result' */
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  /** Whether this chunk should be shown to users (false for thinking, tool internals) */
  visible: boolean;
  /** For tool_call blocks: 'name', 'input', or undefined */
  toolCallPart?: 'name' | 'input';
  /** For tool_call/tool_result: the tool use ID */
  toolId?: string;
}

/**
 * Membrane block types
 */
export type MembraneBlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

/**
 * Membrane block - a logical content region with full content.
 * Used in block_complete events.
 */
export interface MembraneBlock {
  type: MembraneBlockType;
  content?: string;
  toolId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Block lifecycle events
 * Matches membrane's BlockEvent type from types/streaming.ts
 */
export type BlockEvent =
  | { event: 'block_start'; index: number; block: { type: MembraneBlockType } }
  | { event: 'block_complete'; index: number; block: MembraneBlock };

export interface StreamOptions {
  /**
   * Called for each text chunk received with enriched metadata.
   * Note: XML tags from prefill mode are NOT included - only actual content.
   */
  onChunk?: (text: string, meta: ChunkMeta) => void;

  /**
   * Called on block lifecycle events (start, complete).
   */
  onBlock?: (event: BlockEvent) => void;

  /** Called when tool calls are detected */
  onToolCalls?: (
    calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    context: { depth: number; preamble?: string; accumulated: string }
  ) => Promise<Array<{ toolUseId: string; content: string; isError?: boolean }>>;

  /** Called with pre-tool content before executing tools */
  onPreToolContent?: (text: string) => Promise<void>;

  /** Called with usage updates */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;

  /** Called with the actual LLM API request before it's sent */
  onRequest?: (request: any) => void;

  /** Called with the raw LLM API response after each call */
  onResponse?: (response: any) => void;

  /** Maximum tool execution depth */
  maxToolDepth?: number;

  /** Abort signal */
  signal?: AbortSignal;

  /**
   * Override the default formatter for this request.
   * Use 'native' to disable prefill mode (required for claude-opus-4-* models).
   * Use 'anthropic-xml' for prefill mode with XML tools.
   */
  formatterOverride?: 'native' | 'anthropic-xml' | 'completions';
}
