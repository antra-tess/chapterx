import type {
  ParticipantMessage,
  ContentBlock,
  LLMRequest,
  LLMCompletion,
  ToolDefinition,
  StopReason,
} from '../../types.js';

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

export function toMembraneMessage(msg: ParticipantMessage): NormalizedMessage {
  const result: NormalizedMessage = {
    participant: msg.participant,
    content: msg.content.map(toMembraneContentBlock),
    metadata: buildMessageMetadata(msg),
  };
  
  // Membrane's formatter reads cacheBreakpoint to place cache_control.
  if (msg.cacheBreakpoint) {
    result.cacheBreakpoint = true;
  }
  
  return result;
}

export function fromMembraneMessage(msg: NormalizedMessage): ParticipantMessage {
  return {
    participant: msg.participant,
    content: msg.content.map(fromMembraneContentBlock),
    timestamp: msg.metadata?.timestamp,
    messageId: msg.metadata?.sourceId,
    cacheBreakpoint: msg.cacheBreakpoint,
  };
}

/** Drops trailing empty messages: membrane handles prefill internally. */
export function toMembraneMessages(messages: ParticipantMessage[]): NormalizedMessage[] {
  let filteredMessages = messages;

  while (filteredMessages.length > 0) {
    const lastMsg = filteredMessages[filteredMessages.length - 1];
    if (!lastMsg) break;

    const isEmptyMessage = lastMsg.content.every(block => {
      if (block.type === 'text') {
        return !block.text || block.text.trim() === '';
      }
      return false;
    });

    if (isEmptyMessage && lastMsg.content.length > 0) {
      filteredMessages = filteredMessages.slice(0, -1);
    } else {
      break;
    }
  }

  return filteredMessages.map(toMembraneMessage);
}

export function fromMembraneMessages(messages: NormalizedMessage[]): ParticipantMessage[] {
  return messages.map(fromMembraneMessage);
}

export function toMembraneContentBlock(block: ContentBlock): MembraneContentBlock {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
      };
      
    case 'image': {
      const imgResult: MembraneContentBlock = {
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
      // Preserve sourceUrl for providers that need URL-as-text fallback (Gemini 3.x)
      if ((block as any).sourceUrl) {
        (imgResult as any).sourceUrl = (block as any).sourceUrl;
      }
      return imgResult;
    }
      
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

    case 'thinking':
      // Round-trip verbatim — signature must reach the API unchanged
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      } as MembraneContentBlock;

    case 'redacted_thinking':
      return { ...block } as unknown as MembraneContentBlock;

    default:
      return block as unknown as MembraneContentBlock;
  }
}

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

    case 'thinking': {
      const tb = block as { thinking?: string; signature?: string };
      return {
        type: 'thinking',
        thinking: tb.thinking ?? '',
        ...(tb.signature ? { signature: tb.signature } : {}),
      };
    }

    case 'redacted_thinking':
      return { ...(block as unknown as Record<string, unknown>) } as unknown as ContentBlock;

    default:
      return block as unknown as ContentBlock;
  }
}

/**
 * Membrane's auto tool mode picks native tools for a native formatter or an
 * adapter named 'openrouter'. Behind RoutingAdapter the adapter is named
 * 'routing', so the tool mode is set here from the provider that will handle
 * the model.
 */
export function resolveToolModeForModel(
  modelName: string,
  mode?: 'chat' | 'prefill' | 'base-model'
): ToolMode {
  if (mode === 'chat') return 'native';
  if (mode === 'prefill') return 'xml';
  if (mode === 'base-model') return 'native';

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

  // Claude models use XML tools for prefill compatibility
  // Includes Bedrock model IDs (anthropic.claude-*) which are still Claude under the hood
  if (modelName.startsWith('claude-') || modelName.startsWith('anthropic.')) {
    return 'xml';
  }

  return 'native';
}

export function toMembraneRequest(request: LLMRequest): NormalizedRequest {
  const config: GenerationConfig = {
    model: request.config.model,
    maxTokens: request.config.max_tokens,
    temperature: request.config.temperature,
    topP: request.config.top_p,
    presencePenalty: request.config.presence_penalty,
    frequencyPenalty: request.config.frequency_penalty,
    repetitionPenalty: request.config.repetition_penalty,
  };
  
  // Chat mode only (except prefill_thinking): prefill-mode requests end with
  // an assistant prefill, which the API rejects when extended thinking is on.
  const enableApiThinking = request.config.prefill_thinking ||
    (request.config.mode === 'chat' &&
      (request.config.debug_thinking || !!request.config.thinking_type))
  if (enableApiThinking) {
    config.thinking = {
      enabled: true,
      budgetTokens: request.config.thinking_budget || 10000,
      type: request.config.thinking_type,
      // Adaptive-thinking models (Fable 5, Opus 4.7+) default to display:'omitted'
      // (empty thinking field, signature only). debug_thinking means we want to SEE
      // the reasoning — request the summarized form explicitly.
      display: request.config.thinking_type === 'adaptive' && request.config.debug_thinking
        ? 'summarized'
        : undefined,
    };
  }
  
  const normalizedRequest: NormalizedRequest = {
    messages: toMembraneMessages(request.messages),
    system: request.system_prompt,
    config,
    tools: request.tools?.map(toMembraneToolDefinition),
    toolMode: resolveToolModeForModel(request.config.model, request.config.mode),
    // Membrane: 0 disables participant stop sequences; undefined takes its default.
    maxParticipantsForStop: request.config.participant_stop_sequences ? undefined : 0,
    promptCaching: request.config.prompt_caching,
    cacheTtl: request.config.cache_ttl,
    contextPrefix: request.context_prefix,
    // Custom prefill user message (replaces '[Start]' synthetic user message)
    prefillUserMessage: request.prefill_user_message,
    // Streaming control - when false, membrane.stream() falls back to complete(),
    // which runs no tools; in 0.5.81 to 0.6.0 it refuses an onToolCalls option
    // instead (MembraneProvider.stream says when it passes one)
    streaming: request.config.streaming,
  };

  if (request.config.botName) {
    (normalizedRequest as any).assistantParticipant = request.config.botName;
  }

  if (request.stop_sequences && request.stop_sequences.length > 0) {
    normalizedRequest.stopSequences = request.stop_sequences;
  }

  if (request.config.provider_params) {
    normalizedRequest.providerParams = { ...request.config.provider_params };
  }

  // Flows through providerParams → extra → Gemini generationConfig
  if (request.config.generate_images !== undefined) {
    normalizedRequest.providerParams = {
      ...normalizedRequest.providerParams,
      generationConfig: {
        responseModalities: request.config.generate_images ? ['TEXT', 'IMAGE'] : ['TEXT'],
      },
    };
  }

  return normalizedRequest;
}

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
      repetition_penalty: request.config.repetitionPenalty,
      prefill_thinking: request.config.thinking?.enabled,
    },
    tools: request.tools?.map(fromMembraneToolDefinition),
    stop_sequences: Array.isArray(request.stopSequences)
      ? request.stopSequences
      : request.stopSequences?.sequences,
  };
}

export function fromMembraneResponse(response: NormalizedResponse): LLMCompletion {
  return {
    content: (response.content ?? []).map(fromMembraneContentBlock),
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
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

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

export const __testing = {
  buildMessageMetadata,
  mapStopReason,
};

