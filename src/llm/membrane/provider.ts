/**
 * Membrane Provider
 * 
 * Implements chapterx's LLMProvider interface using membrane for the actual LLM calls.
 * This allows drop-in replacement of existing providers while preserving all features.
 */

import type { LLMProvider, ProviderRequest } from '../middleware.js';
import type { LLMCompletion, LLMRequest } from '../../types.js';
import { getCurrentTrace } from '../../trace/index.js';
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
   * tool execution callbacks.
   */
  async stream(
    request: LLMRequest,
    options: StreamOptions = {}
  ): Promise<LLMCompletion> {
    const normalizedRequest = toMembraneRequest(request);
    
    // Cast to any because our local types may not exactly match membrane's updated types
    const response = await this.membrane.stream(normalizedRequest as any, {
      onChunk: options.onChunk,
      onToolCalls: options.onToolCalls,
      onPreToolContent: options.onPreToolContent,
      onUsage: options.onUsage,
      maxToolDepth: options.maxToolDepth ?? 10,
      signal: options.signal,
    });
    
    return fromMembraneResponse(response as any);
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

export interface StreamOptions {
  /** Called for each text chunk received */
  onChunk?: (chunk: string) => void;
  
  /** Called when tool calls are detected */
  onToolCalls?: (
    calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    context: { depth: number; accumulated: string }
  ) => Promise<Array<{ toolUseId: string; content: string; isError?: boolean }>>;
  
  /** Called with pre-tool content before executing tools */
  onPreToolContent?: (text: string) => Promise<void>;
  
  /** Called with usage updates */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  
  /** Maximum tool execution depth */
  maxToolDepth?: number;
  
  /** Abort signal */
  signal?: AbortSignal;
}

