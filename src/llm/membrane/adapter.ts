/**
 * Membrane Adapter
 * 
 * Type conversion functions between chapterx and membrane formats.
 * These are nearly identical but have subtle differences in field locations.
 */

import type {
  ParticipantMessage,
  ContentBlock,
  LLMRequest,
  LLMCompletion,
  ToolDefinition,
  StopReason,
} from '../../types.js';

// Import types from @animalabs/membrane
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  ContentBlock as MembraneContentBlock,
  ImageContent as MembraneImageContent,
  ToolUseContent as MembraneToolUseContent,
  ToolResultContent as MembraneToolResultContent,
  ToolDefinition as MembraneToolDefinition,
  MessageMetadata,
  GenerationConfig,
  ToolMode,
  StopReason as MembraneStopReason,
} from '@animalabs/membrane';
import { getFormatterForModel } from './factory.js';

// Re-export types for use by other modules (preserving existing API)
export type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  MembraneContentBlock,
  MembraneToolDefinition,
  MessageMetadata,
  GenerationConfig,
  MembraneStopReason,
  ToolMode,
};

// ============================================================================
// Message Conversion
// ============================================================================

/**
 * Convert chapterx ParticipantMessage to membrane NormalizedMessage
 * 
 * Key differences handled:
 * - cacheBreakpoint passes through directly (used by formatter for cache_control)
 * - timestamp, messageId move to metadata
 * - Image source.media_type → source.mediaType
 */
export function toMembraneMessage(msg: ParticipantMessage): NormalizedMessage {
  const result: NormalizedMessage = {
    participant: msg.participant,
    content: msg.content.map(toMembraneContentBlock),
    metadata: buildMessageMetadata(msg),
  };
  
  // Pass through cacheBreakpoint directly - formatter checks this property
  if (msg.cacheBreakpoint) {
    result.cacheBreakpoint = true;
  }
  
  return result;
}

/**
 * Convert membrane NormalizedMessage to chapterx ParticipantMessage
 */
export function fromMembraneMessage(msg: NormalizedMessage): ParticipantMessage {
  return {
    participant: msg.participant,
    content: msg.content.map(fromMembraneContentBlock),
    timestamp: msg.metadata?.timestamp,
    messageId: msg.metadata?.sourceId,
    cacheBreakpoint: msg.cacheBreakpoint,
  };
}

/**
 * Convert array of chapterx messages to membrane format
 *
 * Filters out empty assistant messages at the end - these are added by chapterx
 * context builder for its own prefill mechanism, but membrane handles prefill internally.
 */
export function toMembraneMessages(messages: ParticipantMessage[]): NormalizedMessage[] {
  // Filter out trailing empty assistant messages (chapterx prefill placeholder)
  // These are messages with empty text content used to start bot completion
  let filteredMessages = messages;

  while (filteredMessages.length > 0) {
    const lastMsg = filteredMessages[filteredMessages.length - 1];
    if (!lastMsg) break;

    // Check if it's an empty message (only text blocks with empty/whitespace text)
    const isEmptyMessage = lastMsg.content.every(block => {
      if (block.type === 'text') {
        return !block.text || block.text.trim() === '';
      }
      return false; // Non-text blocks are not "empty"
    });

    if (isEmptyMessage && lastMsg.content.length > 0) {
      // Remove trailing empty message
      filteredMessages = filteredMessages.slice(0, -1);
    } else {
      break; // Stop when we hit a non-empty message
    }
  }

  return filteredMessages.map(toMembraneMessage);
}

/**
 * Convert array of membrane messages to chapterx format
 */
export function fromMembraneMessages(messages: NormalizedMessage[]): ParticipantMessage[] {
  return messages.map(fromMembraneMessage);
}

// ============================================================================
// Content Block Conversion
// ============================================================================

/**
 * Convert chapterx ContentBlock to membrane ContentBlock
 * 
 * Key differences:
 * - Image source.media_type → source.mediaType
 */
export function toMembraneContentBlock(block: ContentBlock): MembraneContentBlock {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
      };
      
    case 'image':
      return {
        type: 'image',
        source: block.source.type === 'base64'
          ? {
              type: 'base64',
              data: block.source.data,
              mediaType: block.source.media_type,
            }
          : {
              type: 'url',
              url: block.source.data,
            },
        tokenEstimate: (block as any).tokenEstimate,
      };
      
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
      
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: typeof block.content === 'string' 
          ? block.content 
          : block.content.map(toMembraneContentBlock),
        isError: block.isError,
      };
      
    default:
      // Pass through unknown block types
      return block as unknown as MembraneContentBlock;
  }
}

/**
 * Convert membrane ContentBlock to chapterx ContentBlock
 */
export function fromMembraneContentBlock(block: MembraneContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
      };
      
    case 'image': {
      const imgBlock = block as MembraneImageContent;
      if (imgBlock.source.type === 'base64') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            data: imgBlock.source.data,
            media_type: imgBlock.source.mediaType,
          },
        };
      } else {
        return {
          type: 'image',
          source: {
            type: 'url',
            data: imgBlock.source.url,
            media_type: 'image/jpeg', // URL images don't have explicit media type
          },
        };
      }
    }
      
    case 'tool_use': {
      const toolBlock = block as MembraneToolUseContent;
      return {
        type: 'tool_use',
        id: toolBlock.id,
        name: toolBlock.name,
        input: toolBlock.input as Record<string, any>,
      };
    }
      
    case 'tool_result': {
      const resultBlock = block as MembraneToolResultContent;
      return {
        type: 'tool_result',
        toolUseId: resultBlock.toolUseId,
        content: typeof resultBlock.content === 'string'
          ? resultBlock.content
          : (resultBlock.content as MembraneContentBlock[]).map(fromMembraneContentBlock),
        isError: resultBlock.isError,
      };
    }
    
    case 'generated_image': {
      // Convert membrane generated_image to chapterx image format
      const genImg = block as any;
      return {
        type: 'image',
        source: {
          type: 'base64',
          data: genImg.data,
          media_type: genImg.mimeType || 'image/png',
        },
      };
    }

    case 'thinking':
      // Convert thinking block to text (chapterx doesn't have native thinking type)
      return {
        type: 'text',
        text: `<thinking>${(block as any).thinking}</thinking>`,
      };
      
    default:
      // Pass through unknown block types
      return block as unknown as ContentBlock;
  }
}

// ============================================================================
// Request Conversion
// ============================================================================

/**
 * Determine the appropriate tool mode based on model name
 * 
 * This is necessary because when using RoutingAdapter, Membrane's auto tool mode
 * selection (based on adapter.name) doesn't work correctly. We need to explicitly
 * set the tool mode based on which provider will handle the model.
 * 
 * Rules:
 * - Models with provider prefix (e.g., "anthropic/claude-3-opus") → native (OpenRouter)
 * - Direct claude-* models → xml (Anthropic prefill mode)
 * - Other models → native (likely going through OpenRouter)
 */
export function resolveToolModeForModel(modelName: string): ToolMode {
  // Check per-model formatter routes first (e.g., claude-opus-4-6 → native)
  const formatterOverride = getFormatterForModel(modelName);
  if (formatterOverride === 'native') {
    return 'native';
  }
  if (formatterOverride === 'completions') {
    return 'native'; // Completions models don't use XML tools
  }

  // OpenRouter models have a provider prefix
  if (modelName.includes('/')) {
    return 'native';
  }

  // Direct Claude models use XML tools for prefill compatibility
  if (modelName.startsWith('claude-')) {
    return 'xml';
  }

  // Default to native for unknown models (safer for non-Claude models)
  return 'native';
}

/**
 * Convert chapterx LLMRequest to membrane NormalizedRequest
 */
export function toMembraneRequest(request: LLMRequest): NormalizedRequest {
  const config: GenerationConfig = {
    model: request.config.model,
    maxTokens: request.config.max_tokens,
    temperature: request.config.temperature,
    topP: request.config.top_p,
    presencePenalty: request.config.presence_penalty,
    frequencyPenalty: request.config.frequency_penalty,
  };
  
  // Enable extended thinking when prefill_thinking is set
  // Membrane will use the API's thinking feature and return thinking blocks
  if (request.config.prefill_thinking) {
    config.thinking = {
      enabled: true,
      budgetTokens: 10000,  // Default budget for extended thinking
    };
    // Log that thinking is enabled for debugging
    console.log('[adapter] Thinking enabled:', { model: request.config.model, thinking: config.thinking });
  }
  
  const normalizedRequest: NormalizedRequest = {
    messages: toMembraneMessages(request.messages),
    system: request.system_prompt,
    config,
    tools: request.tools?.map(toMembraneToolDefinition),
    // Explicitly set tool mode based on model to work around RoutingAdapter issue
    // Membrane's auto-detection checks adapter.name which is 'routing' for RoutingAdapter
    toolMode: resolveToolModeForModel(request.config.model),
    // Control participant-based stop sequences:
    // - If participant_stop_sequences is false (default), disable them (set to 0)
    // - If participant_stop_sequences is true, use membrane default (don't set)
    maxParticipantsForStop: request.config.participant_stop_sequences ? undefined : 0,
    // Prompt caching control - when false, cache_control markers are not added to requests
    promptCaching: request.config.prompt_caching,
    // Pass through cache TTL for Anthropic extended caching (1h vs default 5m)
    cacheTtl: request.config.cache_ttl,
    // Context prefix for simulacrum seeding (injected as first assistant message)
    contextPrefix: request.context_prefix,
    // Custom prefill user message (replaces '[Start]' synthetic user message)
    prefillUserMessage: request.prefill_user_message,
  };

  // Handle stop sequences
  if (request.stop_sequences && request.stop_sequences.length > 0) {
    normalizedRequest.stopSequences = request.stop_sequences;
  }

  // Handle explicit image generation config override
  // Flows through providerParams → extra → Gemini generationConfig
  if (request.config.generate_images !== undefined) {
    normalizedRequest.providerParams = {
      generationConfig: {
        responseModalities: request.config.generate_images ? ['TEXT', 'IMAGE'] : ['TEXT'],
      },
    };
  }

  return normalizedRequest;
}

/**
 * Convert membrane NormalizedRequest back to chapterx LLMRequest
 * (Used mainly for testing/debugging)
 */
export function fromMembraneRequest(request: NormalizedRequest, botName: string): LLMRequest {
  return {
    messages: fromMembraneMessages(request.messages),
    system_prompt: request.system,
    config: {
      model: request.config.model,
      temperature: request.config.temperature ?? 1.0,
      max_tokens: request.config.maxTokens,
      top_p: request.config.topP ?? 1.0,
      botName,
      presence_penalty: request.config.presencePenalty,
      frequency_penalty: request.config.frequencyPenalty,
      prefill_thinking: request.config.thinking?.enabled,
    },
    tools: request.tools?.map(fromMembraneToolDefinition),
    stop_sequences: Array.isArray(request.stopSequences)
      ? request.stopSequences
      : request.stopSequences?.sequences,
  };
}

// ============================================================================
// Response Conversion
// ============================================================================

/**
 * Convert membrane NormalizedResponse to chapterx LLMCompletion
 */
export function fromMembraneResponse(response: NormalizedResponse): LLMCompletion {
  return {
    content: response.content.map(fromMembraneContentBlock),
    stopReason: mapStopReason(response.stopReason),
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheCreationTokens: response.details.usage.cacheCreationTokens,
      cacheReadTokens: response.details.usage.cacheReadTokens,
    },
    model: response.details.model.actual,
    raw: response.raw.response,
  };
}

/**
 * Map membrane stop reason to chapterx stop reason
 */
function mapStopReason(reason: MembraneStopReason): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'refusal';
    case 'abort':
      // Map abort to end_turn as chapterx doesn't have abort
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

// ============================================================================
// Tool Definition Conversion
// ============================================================================

/**
 * Convert chapterx ToolDefinition to membrane ToolDefinition
 */
export function toMembraneToolDefinition(tool: ToolDefinition): MembraneToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.inputSchema.properties as Record<string, any> ?? {},
      required: tool.inputSchema.required,
    },
  };
}

/**
 * Convert membrane ToolDefinition to chapterx ToolDefinition
 */
export function fromMembraneToolDefinition(tool: MembraneToolDefinition): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.inputSchema.properties as Record<string, any>,
      required: tool.inputSchema.required,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build membrane MessageMetadata from chapterx message fields
 * 
 * Note: cacheControl is no longer handled here - cache markers now use
 * cacheBreakpoint directly on the message (set by applyChapterXCacheMarker).
 */
function buildMessageMetadata(msg: ParticipantMessage): MessageMetadata | undefined {
  const hasMetadata = msg.timestamp || msg.messageId;
  
  if (!hasMetadata) {
    return undefined;
  }
  
  return {
    timestamp: msg.timestamp,
    sourceId: msg.messageId,
  };
}

// ============================================================================
// Exports for Testing
// ============================================================================

export const __testing = {
  buildMessageMetadata,
  mapStopReason,
};

