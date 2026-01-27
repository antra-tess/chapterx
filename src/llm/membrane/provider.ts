/**
 * Membrane Provider
 * 
 * Implements chapterx's LLMProvider interface using membrane for the actual LLM calls.
 * This allows drop-in replacement of existing providers while preserving all features.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LLMProvider, ProviderRequest } from '../middleware.js';
import type { LLMCompletion, LLMRequest } from '../../types.js';
import { getCurrentTrace } from '../../trace/index.js';
import { logger } from '../../utils/logger.js';
import {
  toMembraneRequest,
  fromMembraneResponse,
  type NormalizedRequest,
  type NormalizedResponse,
} from './adapter.js';

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
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<NormalizedResponse>;
  
  stream(
    request: NormalizedRequest,
    options?: StreamOptions
  ): Promise<NormalizedResponse>;
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class MembraneProvider implements LLMProvider {
  readonly name = 'membrane';
  readonly supportedModes: ('prefill' | 'chat')[] = ['prefill', 'chat'];
  
  private membrane: Membrane;
  private assistantName: string;
  
  constructor(membrane: Membrane, assistantName: string = 'Claude') {
    this.membrane = membrane;
    this.assistantName = assistantName;
  }
  
  /**
   * Complete a request using membrane
   * 
   * Note: This method receives a ProviderRequest (role-based), but we actually
   * want to bypass the middleware's transform and use membrane's own prefill
   * transform. For now, we support this interface for compatibility, but the
   * preferred path is to call `completeFromLLMRequest` with the original
   * participant-based request.
   */
  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    // ProviderRequest is already transformed to role-based format by middleware.
    // This is a compatibility layer - membrane expects NormalizedRequest.
    // 
    // For initial integration, we'll reconstruct what we can from ProviderRequest.
    // The better approach (used in completeFromLLMRequest) is to bypass middleware
    // transforms and use membrane's prefill transform directly.
    
    const trace = getCurrentTrace();
    const callId = trace?.startLLMCall(trace.getLLMCallCount());
    
    try {
      // Build a basic normalized request from provider request
      const normalizedRequest = {
        messages: this.reconstructMessages(request),
        system: this.extractSystemPrompt(request),
        config: {
          model: request.model,
          maxTokens: request.max_tokens,
          temperature: request.temperature,
          topP: request.top_p,
          presencePenalty: request.presence_penalty,
          frequencyPenalty: request.frequency_penalty,
        },
        stopSequences: request.stop_sequences,
        tools: request.tools,
      };
      
      // Cast to any because our local types may not exactly match membrane's updated types
      const response = await this.membrane.complete(normalizedRequest as any);
      const completion = fromMembraneResponse(response as any);
      
      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength: normalizedRequest.system?.length ?? 0,
            hasTools: !!request.tools && request.tools.length > 0,
            toolCount: request.tools?.length ?? 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
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
        );
      }
      
      return completion;
      
    } catch (error) {
      if (trace && callId) {
        trace.failLLMCall(callId, {
          message: error instanceof Error ? error.message : String(error),
          retryCount: 0,
        });
      }
      throw error;
    }
  }
  
  /**
   * Complete a request directly from LLMRequest format
   * 
   * This is the preferred method as it allows membrane to handle the full
   * prefill/chat transform rather than going through middleware's transform.
   */
  async completeFromLLMRequest(request: LLMRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace();
    const callId = trace?.startLLMCall(trace.getLLMCallCount());
    
    try {
      const normalizedRequest = toMembraneRequest(request);
      // Cast to any because our local types may not exactly match membrane's updated types
      const response = await this.membrane.complete(normalizedRequest as any);
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
        );
      }
      
      return completion;
      
    } catch (error) {
      if (trace && callId) {
        trace.failLLMCall(callId, {
          message: error instanceof Error ? error.message : String(error),
          retryCount: 0,
        });
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

    const normalizedRequest = toMembraneRequest(request);

    // Log membrane request to file and capture ref for trace
    const membraneRequestRef = this.logMembraneRequestToFile(normalizedRequest);

    // Accumulate all request/response refs in tool loops
    const llmRequestRefs: string[] = [];
    const llmResponseRefs: string[] = [];

    try {
      // Cast to any because our local types may not exactly match membrane's updated types
      const response = await this.membrane.stream(normalizedRequest as any, {
        onChunk: options.onChunk,
        onBlock: options.onBlock,
        onToolCalls: options.onToolCalls,
        onPreToolContent: options.onPreToolContent,
        onUsage: options.onUsage,
        maxToolDepth: options.maxToolDepth ?? 10,
        signal: options.signal,
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
      });

      // Log membrane response to file
      const membraneResponseRef = this.logResponseToFile(response);

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

      return completion;
    } catch (error: any) {
      // Record error to trace
      if (trace && callId) {
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
      }
      throw error;
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

      // Strip large base64 data from images before logging
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

      // Strip large base64 data from images before logging
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

  private stripBase64FromRequest(request: any): any {
    // Deep clone to avoid mutating original
    const clone = JSON.parse(JSON.stringify(request));

    // Strip base64 data from messages
    if (clone.messages) {
      for (const msg of clone.messages) {
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'image' && block.source?.type === 'base64') {
              block.source.data = `[BASE64_DATA_${block.source.data?.length || 0}_BYTES]`;
            }
          }
        }
      }
    }

    return clone;
  }
  
  // ==========================================================================
  // Helper Methods
  // ==========================================================================
  
  /**
   * Reconstruct NormalizedMessage array from ProviderRequest messages
   * 
   * This is a lossy conversion since ProviderRequest uses role-based format.
   * We do our best to reconstruct participant names from content.
   */
  private reconstructMessages(request: ProviderRequest): Array<{
    participant: string;
    content: Array<{ type: 'text'; text: string } | any>;
  }> {
    const messages: Array<{
      participant: string;
      content: Array<{ type: 'text'; text: string } | any>;
    }> = [];
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        // System messages are handled separately
        continue;
      }
      
      const participant = msg.role === 'assistant' 
        ? this.assistantName 
        : 'User';
      
      const content = typeof msg.content === 'string'
        ? [{ type: 'text' as const, text: msg.content }]
        : msg.content;
      
      messages.push({ participant, content });
    }
    
    return messages;
  }
  
  /**
   * Extract system prompt from ProviderRequest
   */
  private extractSystemPrompt(request: ProviderRequest): string | undefined {
    const systemMessage = request.messages.find(m => m.role === 'system');
    if (!systemMessage) return undefined;
    
    if (typeof systemMessage.content === 'string') {
      return systemMessage.content;
    }
    
    // Handle array content (Anthropic system format)
    if (Array.isArray(systemMessage.content)) {
      return systemMessage.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
    }
    
    return undefined;
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
    context: { depth: number; accumulated: string }
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
}

