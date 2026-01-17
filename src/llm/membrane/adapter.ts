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

// NOTE: membrane types are defined locally until membrane is installed
// Once `npm install membrane@github:antra-tess/membrane#main` is run,
// these can be replaced with: import type { ... } from 'membrane';

// ============================================================================
// Membrane Types (local definitions until package is installed)
// ============================================================================

interface MessageMetadata {
  timestamp?: Date;
  sourceId?: string;
  cacheControl?: { type: 'ephemeral' };
  [key: string]: unknown;
}

interface NormalizedMessage {
  participant: string;
  content: MembraneContentBlock[];
  metadata?: MessageMetadata;
}

interface GenerationConfig {
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
}

type ToolMode = 'xml' | 'native' | 'auto';

interface NormalizedRequest {
  messages: NormalizedMessage[];
  system?: string;
  config: GenerationConfig;
  tools?: MembraneToolDefinition[];
  toolMode?: ToolMode;
  stopSequences?: string[] | { sequences: string[] };
}

type MembraneStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | 'abort';

/**
 * Membrane's ToolCall type
 */
interface MembraneToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Membrane's ToolResult type (content can now be string or content blocks for images)
 */
interface MembraneToolResult {
  toolUseId: string;
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } }>;
  isError?: boolean;
}

interface NormalizedResponse {
  content: MembraneContentBlock[];
  
  /**
   * Raw assistant output text including all XML.
   * NEW in streaming refactor - use for verbatim prefill.
   */
  rawAssistantText: string;
  
  /**
   * Tool calls extracted from response (convenience accessor).
   * NEW in streaming refactor.
   */
  toolCalls: MembraneToolCall[];
  
  /**
   * Tool results executed during this response.
   * NEW in streaming refactor - empty for complete(), populated by stream().
   */
  toolResults: MembraneToolResult[];
  
  stopReason: MembraneStopReason;
  usage: { inputTokens: number; outputTokens: number };
  details: {
    stop: { reason: MembraneStopReason; wasTruncated: boolean };
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    };
    timing: { totalDurationMs: number; attempts: number };
    model: { requested: string; actual: string; provider: string };
    cache: { markersInRequest: number; tokensCreated: number; tokensRead: number; hitRatio: number };
  };
  raw: { request: unknown; response: unknown };
}

interface MembraneToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type MembraneContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | MembraneImageContent
  | MembraneToolUseContent
  | MembraneToolResultContent
  | { type: 'thinking'; thinking: string; signature?: string };

interface MembraneImageContent {
  type: 'image';
  source: { type: 'base64'; data: string; mediaType: string } | { type: 'url'; url: string };
  tokenEstimate?: number;
}

interface MembraneToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface MembraneToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string | MembraneContentBlock[];
  isError?: boolean;
}

// Export types for use by other modules
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
 * - cacheControl moves from top-level to metadata
 * - timestamp, messageId move to metadata
 * - Image source.media_type → source.mediaType
 */
export function toMembraneMessage(msg: ParticipantMessage): NormalizedMessage {
  return {
    participant: msg.participant,
    content: msg.content.map(toMembraneContentBlock),
    metadata: buildMessageMetadata(msg),
  };
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
    cacheControl: msg.metadata?.cacheControl,
  };
}

/**
 * Convert array of chapterx messages to membrane format
 */
export function toMembraneMessages(messages: ParticipantMessage[]): NormalizedMessage[] {
  return messages.map(toMembraneMessage);
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
  
  // Handle thinking mode
  if (request.config.prefill_thinking) {
    config.thinking = {
      enabled: true,
    };
  }
  
  const normalizedRequest: NormalizedRequest = {
    messages: toMembraneMessages(request.messages),
    system: request.system_prompt,
    config,
    tools: request.tools?.map(toMembraneToolDefinition),
    // Explicitly set tool mode based on model to work around RoutingAdapter issue
    // Membrane's auto-detection checks adapter.name which is 'routing' for RoutingAdapter
    toolMode: resolveToolModeForModel(request.config.model),
  };
  
  // Handle stop sequences
  if (request.stop_sequences && request.stop_sequences.length > 0) {
    normalizedRequest.stopSequences = request.stop_sequences;
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
      mode: 'prefill', // Default; actual mode comes from BotConfig
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
 */
function buildMessageMetadata(msg: ParticipantMessage): MessageMetadata | undefined {
  const hasMetadata = msg.timestamp || msg.messageId || msg.cacheControl;
  
  if (!hasMetadata) {
    return undefined;
  }
  
  return {
    timestamp: msg.timestamp,
    sourceId: msg.messageId,
    cacheControl: msg.cacheControl,
  };
}

// ============================================================================
// Exports for Testing
// ============================================================================

export const __testing = {
  buildMessageMetadata,
  mapStopReason,
};

