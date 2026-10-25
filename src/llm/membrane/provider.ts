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
import { getFormatterForModel } from './factory.js';
import { NativeFormatter, AnthropicXmlFormatter, CompletionsFormatter } from '@animalabs/membrane';
import type { CompleteOptions, StreamOptions as MembraneStreamOptions } from '@animalabs/membrane';

function formatterFromMode(mode?: string): 'native' | 'anthropic-xml' | 'completions' | undefined {
  if (mode === 'chat') return 'native';
  if (mode === 'prefill') return 'anthropic-xml';
  if (mode === 'base-model') return 'completions';
  return undefined;
}

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

function base64Marker(payload: string): string {
  return `[BASE64_DATA_${payload.length}_BYTES]`;
}

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

  async completeFromLLMRequest(request: LLMRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace();
    const callId = trace?.startLLMCall(trace.getLLMCallCount());

    logger.debug({ hasTrace: !!trace, callId, model: request.config.model }, 'Starting membrane complete');

    let requestRef: string | undefined;
    let responseRef: string | undefined;

    try {
      const normalizedRequest = toMembraneRequest(request);

      const formatterType = formatterFromMode(request.config.mode)
        ?? getFormatterForModel(request.config.model)
        ?? (request.config.model.startsWith('claude-') || request.config.model.includes('anthropic.claude') ? 'anthropic-xml' : 'native');
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
      console.error('[MEMBRANE ERROR - complete()]', {
        message: error.message,
        name: error.name,
        code: error.code,
        type: error.type,
        status: error.status,
        model: request.config.model,
      });

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

  async stream(
    request: LLMRequest,
    options: StreamOptions = {}
  ): Promise<LLMCompletion> {
    const trace = getCurrentTrace();
    const callId = trace?.startLLMCall(trace.getLLMCallCount());

    logger.debug({ hasTrace: !!trace, callId, model: request.config.model }, 'Starting membrane stream');

    const normalizedRequest = toMembraneRequest(request);

    const membraneRequestRef = this.logMembraneRequestToFile(normalizedRequest);

    const llmRequestRefs: string[] = [];
    const llmResponseRefs: string[] = [];

    const metricsCollector = new StreamingMetricsCollector(
      trace?.getBotId() ?? 'unknown',
      request.config.model,
      request.config.streaming === false ? 'synthesized' : 'stream',
      trace?.getTraceId(),
    );

    try {
      const formatterType = options.formatterOverride
        ?? formatterFromMode(request.config.mode)
        ?? getFormatterForModel(request.config.model)
        ?? (request.config.model.startsWith('claude-') || request.config.model.includes('anthropic.claude') ? 'anthropic-xml' : 'native');
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

      const streamOptions: any = {
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
        onRequest: (llmRequest: any) => {
          logger.debug({ hasData: !!llmRequest }, 'onRequest callback triggered');
          const ref = this.logRequestToFile(llmRequest);
          if (ref) llmRequestRefs.push(ref);
        },
        onResponse: (llmResponse: any) => {
          logger.debug({ hasData: !!llmResponse, type: typeof llmResponse }, 'onResponse callback triggered');
          const ref = this.logRawResponseToFile(llmResponse);
          logger.debug({ ref }, 'onResponse logged to file');
          if (ref) llmResponseRefs.push(ref);
        },
      };
      const response = await this.membrane.stream(normalizedRequest as any, streamOptions);

      const membraneResponseRef = this.logResponseToFile(response);

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

        this.writeStreamingMetrics(metricsCollector, {
          usage: completion.usage,
          stopReason: 'end_turn',
        });

        return completion;
      }

      const completion = fromMembraneResponse(response as any);

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

      this.writeStreamingMetrics(metricsCollector, {
        error: `${error.name || 'Error'}: ${error.message}`,
      });

      throw error;
    }
  }

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

  private logRequestToFile(request: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-requests');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basename = `request-${timestamp}.json`;
      const filename = join(dir, basename);

      const processedRequest = this.stripBase64FromRequest(request);
      writeFileSync(filename, JSON.stringify(processedRequest, null, 2));
      logger.debug({ filename }, 'Logged LLM API request to file');
      return basename;
    } catch (error) {
      logger.warn({ error }, 'Failed to log LLM API request to file');
      return undefined;
    }
  }

  private logMembraneRequestToFile(request: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'membrane-requests');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const basename = `membrane-${timestamp}.json`;
      const filename = join(dir, basename);

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

      writeFileSync(filename, JSON.stringify(response, null, 2));
      logger.debug({ filename }, 'Logged membrane response to file');
      return basename;
    } catch (error) {
      logger.warn({ error }, 'Failed to log membrane response to file');
      return undefined;
    }
  }

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
   * Media payloads sit in a `source` of type 'base64' (Anthropic's and
   * membrane's), Gemini's `inlineData`, an `input_audio`, a `data:...;base64,`
   * URL under a `url` key (the OpenAI-style adapters), or an `image` array (the
   * Images API adapter's edit inputs).
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

/** A subset of membrane's ChunkMeta. */
export interface ChunkMeta {
  blockIndex: number;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  visible: boolean;
  toolCallPart?: 'name' | 'input';
  toolId?: string;
}

export type MembraneBlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

export interface MembraneBlock {
  type: MembraneBlockType;
  content?: string;
  toolId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

/** Mirrors membrane's BlockEvent (types/streaming.ts). */
export type BlockEvent =
  | { event: 'block_start'; index: number; block: { type: MembraneBlockType } }
  | { event: 'block_complete'; index: number; block: MembraneBlock };

export interface StreamOptions {
  onChunk?: (text: string, meta: ChunkMeta) => void;

  onBlock?: (event: BlockEvent) => void;

  onToolCalls?: (
    calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    context: { depth: number; preamble?: string; accumulated: string }
  ) => Promise<Array<{ toolUseId: string; content: string; isError?: boolean }>>;

  onPreToolContent?: (text: string) => Promise<void>;

  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;

  onRequest?: (request: any) => void;

  onResponse?: (response: any) => void;

  maxToolDepth?: number;

  signal?: AbortSignal;

  /** 'native', which turns prefill mode off, is required for claude-opus-4-* models. */
  formatterOverride?: 'native' | 'anthropic-xml' | 'completions';
}
