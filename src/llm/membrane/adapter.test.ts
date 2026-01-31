/**
 * Tests for membrane adapter type conversions
 * 
 * Run with: npm test -- membrane-adapter
 */

import { describe, it, expect } from 'vitest';
import {
  toMembraneMessage,
  fromMembraneMessage,
  toMembraneMessages,
  fromMembraneMessages,
  toMembraneContentBlock,
  fromMembraneContentBlock,
  toMembraneRequest,
  fromMembraneResponse,
  toMembraneToolDefinition,
  fromMembraneToolDefinition,
  resolveToolModeForModel,
} from './adapter.js';
import type { ParticipantMessage, LLMRequest, ContentBlock } from '../../types.js';
import type { NormalizedMessage, NormalizedResponse } from './adapter.js';

// ============================================================================
// Message Conversion Tests
// ============================================================================

describe('Message Conversion', () => {
  describe('toMembraneMessage', () => {
    it('should convert basic text message', () => {
      const input: ParticipantMessage = {
        participant: 'Alice',
        content: [{ type: 'text', text: 'Hello world' }],
      };
      
      const result = toMembraneMessage(input);
      
      expect(result.participant).toBe('Alice');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello world' });
      expect(result.metadata).toBeUndefined();
    });
    
    it('should move cacheControl to metadata', () => {
      const input: ParticipantMessage = {
        participant: 'Bob',
        content: [{ type: 'text', text: 'Test' }],
        cacheControl: { type: 'ephemeral' },
      };
      
      const result = toMembraneMessage(input);
      
      expect(result.metadata?.cacheControl).toEqual({ type: 'ephemeral' });
    });
    
    it('should move timestamp and messageId to metadata', () => {
      const timestamp = new Date('2026-01-15T10:00:00Z');
      const input: ParticipantMessage = {
        participant: 'Claude',
        content: [{ type: 'text', text: 'Response' }],
        timestamp,
        messageId: 'discord-123',
      };
      
      const result = toMembraneMessage(input);
      
      expect(result.metadata?.timestamp).toEqual(timestamp);
      expect(result.metadata?.sourceId).toBe('discord-123');
    });
  });
  
  describe('fromMembraneMessage', () => {
    it('should convert back from membrane format', () => {
      const input: NormalizedMessage = {
        participant: 'Alice',
        content: [{ type: 'text', text: 'Hello' }],
        metadata: {
          timestamp: new Date('2026-01-15'),
          sourceId: 'msg-123',
          cacheControl: { type: 'ephemeral' },
        },
      };
      
      const result = fromMembraneMessage(input);
      
      expect(result.participant).toBe('Alice');
      expect(result.timestamp).toEqual(new Date('2026-01-15'));
      expect(result.messageId).toBe('msg-123');
      expect(result.cacheControl).toEqual({ type: 'ephemeral' });
    });
  });
  
  describe('roundtrip', () => {
    it('should preserve data through roundtrip conversion', () => {
      const original: ParticipantMessage = {
        participant: 'TestUser',
        content: [
          { type: 'text', text: 'Some text' },
        ],
        timestamp: new Date('2026-01-15'),
        messageId: 'test-id',
        cacheControl: { type: 'ephemeral' },
      };
      
      const membrane = toMembraneMessage(original);
      const result = fromMembraneMessage(membrane);
      
      expect(result.participant).toBe(original.participant);
      expect(result.content).toEqual(original.content);
      expect(result.timestamp).toEqual(original.timestamp);
      expect(result.messageId).toBe(original.messageId);
      expect(result.cacheControl).toEqual(original.cacheControl);
    });
  });
});

// ============================================================================
// Content Block Conversion Tests
// ============================================================================

describe('Content Block Conversion', () => {
  describe('text blocks', () => {
    it('should convert text block', () => {
      const input: ContentBlock = { type: 'text', text: 'Hello' };
      const result = toMembraneContentBlock(input);
      expect(result).toEqual({ type: 'text', text: 'Hello' });
    });
  });
  
  describe('image blocks', () => {
    it('should convert base64 image with media_type → mediaType', () => {
      const input: ContentBlock = {
        type: 'image',
        source: {
          type: 'base64',
          data: 'base64data',
          media_type: 'image/png',
        },
      };
      
      const result = toMembraneContentBlock(input);
      
      expect(result.type).toBe('image');
      expect((result as any).source.type).toBe('base64');
      expect((result as any).source.mediaType).toBe('image/png');
      expect((result as any).source.media_type).toBeUndefined();
    });
    
    it('should convert URL image', () => {
      const input: ContentBlock = {
        type: 'image',
        source: {
          type: 'url',
          data: 'https://example.com/image.png',
          media_type: 'image/png',
        },
      };
      
      const result = toMembraneContentBlock(input);
      
      expect(result.type).toBe('image');
      expect((result as any).source.type).toBe('url');
      expect((result as any).source.url).toBe('https://example.com/image.png');
    });
    
    it('should preserve tokenEstimate on image', () => {
      const input: any = {
        type: 'image',
        source: {
          type: 'base64',
          data: 'base64data',
          media_type: 'image/jpeg',
        },
        tokenEstimate: 1000,
      };
      
      const result = toMembraneContentBlock(input);
      expect((result as any).tokenEstimate).toBe(1000);
    });
  });
  
  describe('tool_use blocks', () => {
    it('should convert tool_use block', () => {
      const input: ContentBlock = {
        type: 'tool_use',
        id: 'call-123',
        name: 'get_weather',
        input: { location: 'NYC' },
      };
      
      const result = toMembraneContentBlock(input);
      
      expect(result).toEqual({
        type: 'tool_use',
        id: 'call-123',
        name: 'get_weather',
        input: { location: 'NYC' },
      });
    });
  });
  
  describe('tool_result blocks', () => {
    it('should convert tool_result block with string content', () => {
      const input: ContentBlock = {
        type: 'tool_result',
        toolUseId: 'call-123',
        content: 'The weather is sunny',
        isError: false,
      };
      
      const result = toMembraneContentBlock(input);
      
      expect(result).toEqual({
        type: 'tool_result',
        toolUseId: 'call-123',
        content: 'The weather is sunny',
        isError: false,
      });
    });
    
    it('should convert tool_result block with nested content blocks', () => {
      const input: ContentBlock = {
        type: 'tool_result',
        toolUseId: 'call-456',
        content: [
          { type: 'text', text: 'Result text' },
        ],
      };
      
      const result = toMembraneContentBlock(input);
      
      expect((result as any).content).toHaveLength(1);
      expect((result as any).content[0].type).toBe('text');
    });
  });
});

// ============================================================================
// Request Conversion Tests
// ============================================================================

describe('Request Conversion', () => {
  it('should convert LLMRequest to NormalizedRequest', () => {
    const input: LLMRequest = {
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'Hello' }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Hi!' }] },
      ],
      system_prompt: 'You are helpful.',
      config: {
        model: 'claude-3-opus-20240229',
        temperature: 0.7,
        max_tokens: 4096,
        top_p: 0.9,
        botName: 'Claude',
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
      },
      stop_sequences: ['User:', 'Alice:'],
    };
    
    const result = toMembraneRequest(input);
    
    expect(result.messages).toHaveLength(2);
    expect(result.system).toBe('You are helpful.');
    expect(result.config.model).toBe('claude-3-opus-20240229');
    expect(result.config.maxTokens).toBe(4096);
    expect(result.config.temperature).toBe(0.7);
    expect(result.config.topP).toBe(0.9);
    expect(result.config.presencePenalty).toBe(0.1);
    expect(result.config.frequencyPenalty).toBe(0.2);
    expect(result.stopSequences).toEqual(['User:', 'Alice:']);
  });
  
  it('should handle prefill_thinking config', () => {
    const input: LLMRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'Think' }] }],
      config: {
        model: 'claude-3-opus-20240229',
        temperature: 1.0,
        max_tokens: 8192,
        top_p: 1.0,
        botName: 'Claude',
        prefill_thinking: true,
      },
    };
    
    const result = toMembraneRequest(input);
    
    expect(result.config.thinking?.enabled).toBe(true);
  });
  
  it('should set toolMode to xml for direct Claude models', () => {
    const input: LLMRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'Test' }] }],
      config: {
        model: 'claude-3-5-sonnet-20241022',
        temperature: 1.0,
        max_tokens: 4096,
        top_p: 1.0,
        botName: 'Claude',
      },
    };
    
    const result = toMembraneRequest(input);
    
    expect(result.toolMode).toBe('xml');
  });
  
  it('should set toolMode to native for OpenRouter models', () => {
    const input: LLMRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'Test' }] }],
      config: {
        model: 'anthropic/claude-3-opus',
        temperature: 1.0,
        max_tokens: 4096,
        top_p: 1.0,
        botName: 'Claude',
      },
    };
    
    const result = toMembraneRequest(input);
    
    expect(result.toolMode).toBe('native');
  });
  
  it('should set toolMode to native for non-Claude OpenRouter models', () => {
    const input: LLMRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'Test' }] }],
      config: {
        model: 'meta-llama/llama-3.1-70b-instruct',
        temperature: 1.0,
        max_tokens: 4096,
        top_p: 1.0,
        botName: 'Claude',
      },
    };
    
    const result = toMembraneRequest(input);
    
    expect(result.toolMode).toBe('native');
  });
});

// ============================================================================
// Tool Mode Resolution Tests
// ============================================================================

describe('resolveToolModeForModel', () => {
  it('should return xml for direct Claude models', () => {
    expect(resolveToolModeForModel('claude-3-5-sonnet-20241022')).toBe('xml');
    expect(resolveToolModeForModel('claude-3-opus-20240229')).toBe('xml');
    expect(resolveToolModeForModel('claude-3-5-haiku-20241022')).toBe('xml');
  });
  
  it('should return native for OpenRouter prefixed models', () => {
    expect(resolveToolModeForModel('anthropic/claude-3-opus')).toBe('native');
    expect(resolveToolModeForModel('meta-llama/llama-3.1-70b-instruct')).toBe('native');
    expect(resolveToolModeForModel('openai/gpt-4-turbo')).toBe('native');
  });
  
  it('should return native for unknown models (fallback)', () => {
    expect(resolveToolModeForModel('some-other-model')).toBe('native');
  });
});

// ============================================================================
// Response Conversion Tests
// ============================================================================

describe('Response Conversion', () => {
  it('should convert NormalizedResponse to LLMCompletion', () => {
    const input: NormalizedResponse = {
      content: [{ type: 'text', text: 'Hello!' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      details: {
        stop: { reason: 'end_turn', wasTruncated: false },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 10,
          cacheReadTokens: 20,
        },
        timing: { totalDurationMs: 1500, attempts: 1 },
        model: {
          requested: 'claude-3-opus-20240229',
          actual: 'claude-3-opus-20240229',
          provider: 'anthropic',
        },
        cache: {
          markersInRequest: 2,
          tokensCreated: 10,
          tokensRead: 20,
          hitRatio: 0.2,
        },
      },
      raw: { request: {}, response: { id: 'resp-123' } },
    };
    
    const result = fromMembraneResponse(input);
    
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheCreationTokens).toBe(10);
    expect(result.usage.cacheReadTokens).toBe(20);
    expect(result.model).toBe('claude-3-opus-20240229');
    expect(result.raw).toEqual({ id: 'resp-123' });
  });
  
  it('should map all stop reasons correctly', () => {
    const testCases: Array<{ input: string; expected: string }> = [
      { input: 'end_turn', expected: 'end_turn' },
      { input: 'max_tokens', expected: 'max_tokens' },
      { input: 'stop_sequence', expected: 'stop_sequence' },
      { input: 'tool_use', expected: 'tool_use' },
      { input: 'refusal', expected: 'refusal' },
      { input: 'abort', expected: 'end_turn' }, // abort maps to end_turn
    ];
    
    for (const { input, expected } of testCases) {
      const response: NormalizedResponse = {
        content: [],
        stopReason: input as any,
        usage: { inputTokens: 0, outputTokens: 0 },
        details: {
          stop: { reason: input as any, wasTruncated: false },
          usage: { inputTokens: 0, outputTokens: 0 },
          timing: { totalDurationMs: 0, attempts: 1 },
          model: { requested: '', actual: '', provider: '' },
          cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
        },
        raw: { request: null, response: null },
      };
      
      const result = fromMembraneResponse(response);
      expect(result.stopReason).toBe(expected);
    }
  });
});

// ============================================================================
// Tool Definition Conversion Tests
// ============================================================================

describe('Tool Definition Conversion', () => {
  it('should convert tool definition to membrane format', () => {
    const input = {
      name: 'get_weather',
      description: 'Get weather for a location',
      inputSchema: {
        type: 'object' as const,
        properties: {
          location: { type: 'string', description: 'City name' },
        },
        required: ['location'],
      },
    };
    
    const result = toMembraneToolDefinition(input);
    
    expect(result.name).toBe('get_weather');
    expect(result.description).toBe('Get weather for a location');
    expect(result.inputSchema.type).toBe('object');
    expect(result.inputSchema.properties.location.type).toBe('string');
    expect(result.inputSchema.required).toEqual(['location']);
  });
  
  it('should roundtrip tool definitions', () => {
    const original = {
      name: 'search',
      description: 'Search the web',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    };
    
    const membrane = toMembraneToolDefinition(original);
    const result = fromMembraneToolDefinition(membrane);
    
    expect(result.name).toBe(original.name);
    expect(result.description).toBe(original.description);
    expect(result.inputSchema.required).toEqual(original.inputSchema.required);
  });
});

// ============================================================================
// Edge Case Tests - Session 4 Validation
// ============================================================================

describe('Edge Cases: Thinking Block Conversion', () => {
  it('should convert membrane thinking block to text with tags', () => {
    const thinkingBlock = {
      type: 'thinking' as const,
      thinking: 'Let me think about this problem step by step...',
    };
    
    const result = fromMembraneContentBlock(thinkingBlock);
    
    expect(result.type).toBe('text');
    expect((result as any).text).toBe('<thinking>Let me think about this problem step by step...</thinking>');
  });
  
  it('should handle thinking blocks in response conversion', () => {
    const input: NormalizedResponse = {
      content: [
        { type: 'thinking', thinking: 'Analyzing the request...' },
        { type: 'text', text: 'Here is my answer.' },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 30 },
      details: {
        stop: { reason: 'end_turn', wasTruncated: false },
        usage: { inputTokens: 50, outputTokens: 30 },
        timing: { totalDurationMs: 500, attempts: 1 },
        model: { requested: 'claude-3-opus', actual: 'claude-3-opus', provider: 'anthropic' },
        cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
      },
      raw: { request: null, response: null },
    };
    
    const result = fromMembraneResponse(input);
    
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toBe('<thinking>Analyzing the request...</thinking>');
    expect(result.content[1].type).toBe('text');
    expect((result.content[1] as any).text).toBe('Here is my answer.');
  });
  
  it('should handle redacted thinking blocks gracefully', () => {
    // Redacted thinking blocks have type 'redacted_thinking' in some responses
    const redactedBlock = {
      type: 'redacted_thinking' as any,
      data: '[content redacted]',
    };
    
    // Should pass through as unknown type
    const result = fromMembraneContentBlock(redactedBlock);
    expect(result.type).toBe('redacted_thinking');
  });
});

describe('Edge Cases: Tool Results with Images', () => {
  it('should convert tool_result with image content blocks', () => {
    const input: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'call-mcp-123',
      content: [
        { type: 'text', text: 'Screenshot captured successfully' },
        {
          type: 'image',
          source: {
            type: 'base64',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ...',
            media_type: 'image/png',
          },
        },
      ],
    };
    
    const membrane = toMembraneContentBlock(input);
    const result = fromMembraneContentBlock(membrane);
    
    expect(result.type).toBe('tool_result');
    expect((result as any).content).toHaveLength(2);
    expect((result as any).content[1].type).toBe('image');
    expect((result as any).content[1].source.media_type).toBe('image/png');
  });
  
  it('should handle tool_result with isError flag', () => {
    const input: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'call-failed',
      content: 'Error: Connection refused',
      isError: true,
    };
    
    const membrane = toMembraneContentBlock(input);
    const result = fromMembraneContentBlock(membrane);
    
    expect(result.type).toBe('tool_result');
    expect((result as any).isError).toBe(true);
    expect((result as any).content).toBe('Error: Connection refused');
  });
});

describe('Edge Cases: Empty Content', () => {
  it('should handle message with empty content array', () => {
    const input: ParticipantMessage = {
      participant: 'Claude',
      content: [],
    };
    
    const result = toMembraneMessage(input);
    expect(result.content).toHaveLength(0);
    expect(result.participant).toBe('Claude');
  });
  
  it('should handle request with no tools', () => {
    const input: LLMRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'Hello' }] }],
      config: {
        model: 'claude-3-5-sonnet-20241022',
        temperature: 1.0,
        max_tokens: 4096,
        top_p: 1.0,
        botName: 'Claude',
      },
    };
    
    const result = toMembraneRequest(input);
    expect(result.tools).toBeUndefined();
  });
  
  it('should handle request with no stop sequences', () => {
    const input: LLMRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'Hello' }] }],
      config: {
        model: 'claude-3-5-sonnet-20241022',
        temperature: 1.0,
        max_tokens: 4096,
        top_p: 1.0,
        botName: 'Claude',
      },
    };
    
    const result = toMembraneRequest(input);
    expect(result.stopSequences).toBeUndefined();
  });
});

describe('Edge Cases: Multi-participant Conversations', () => {
  it('should preserve all participant names in conversion', () => {
    const messages: ParticipantMessage[] = [
      { participant: 'Alice', content: [{ type: 'text', text: 'Hey everyone!' }] },
      { participant: 'Bob', content: [{ type: 'text', text: 'Hi Alice!' }] },
      { participant: 'Claude', content: [{ type: 'text', text: 'Hello!' }] },
      { participant: 'Charlie', content: [{ type: 'text', text: 'Whats up?' }] },
      { participant: 'Claude', content: [{ type: 'text', text: 'Not much, you?' }] },
    ];
    
    const membrane = toMembraneMessages(messages);
    const result = fromMembraneMessages(membrane);
    
    expect(result.map(m => m.participant)).toEqual([
      'Alice', 'Bob', 'Claude', 'Charlie', 'Claude'
    ]);
  });
  
  it('should handle request with participant-based stop sequences', () => {
    const input: LLMRequest = {
      messages: [
        { participant: 'Alice', content: [{ type: 'text', text: 'Hello' }] },
        { participant: 'Claude', content: [] },
      ],
      config: {
        model: 'claude-3-5-sonnet-20241022',
        temperature: 1.0,
        max_tokens: 4096,
        top_p: 1.0,
        botName: 'Claude',
      },
      stop_sequences: ['Alice:', 'Bob:', 'Charlie:'],
    };
    
    const result = toMembraneRequest(input);
    expect(result.stopSequences).toEqual(['Alice:', 'Bob:', 'Charlie:']);
  });
});

describe('Edge Cases: Cache Control', () => {
  it('should preserve cache control through conversion', () => {
    const messages: ParticipantMessage[] = [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'Cached message' }],
        cacheControl: { type: 'ephemeral' },
      },
      {
        participant: 'User',
        content: [{ type: 'text', text: 'Uncached message' }],
      },
    ];
    
    const membrane = toMembraneMessages(messages);
    const result = fromMembraneMessages(membrane);
    
    expect(result[0].cacheControl).toEqual({ type: 'ephemeral' });
    expect(result[1].cacheControl).toBeUndefined();
  });
});

describe('Edge Cases: Response Usage Details', () => {
  it('should extract all cache-related usage from details', () => {
    const input: NormalizedResponse = {
      content: [{ type: 'text', text: 'Response' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1000, outputTokens: 200 },
      details: {
        stop: { reason: 'end_turn', wasTruncated: false },
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 500,
          cacheReadTokens: 400,
        },
        timing: { totalDurationMs: 2000, attempts: 1 },
        model: {
          requested: 'claude-3-5-sonnet-20241022',
          actual: 'claude-3-5-sonnet-20241022',
          provider: 'anthropic',
        },
        cache: {
          markersInRequest: 3,
          tokensCreated: 500,
          tokensRead: 400,
          hitRatio: 0.44,
        },
      },
      raw: { request: null, response: null },
    };
    
    const result = fromMembraneResponse(input);
    
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(200);
    expect(result.usage.cacheCreationTokens).toBe(500);
    expect(result.usage.cacheReadTokens).toBe(400);
  });
  
  it('should handle response with no cache tokens', () => {
    const input: NormalizedResponse = {
      content: [{ type: 'text', text: 'Response' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      details: {
        stop: { reason: 'end_turn', wasTruncated: false },
        usage: { inputTokens: 100, outputTokens: 50 },
        timing: { totalDurationMs: 500, attempts: 1 },
        model: { requested: 'gpt-4', actual: 'gpt-4', provider: 'openai' },
        cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
      },
      raw: { request: null, response: null },
    };
    
    const result = fromMembraneResponse(input);
    
    expect(result.usage.cacheCreationTokens).toBeUndefined();
    expect(result.usage.cacheReadTokens).toBeUndefined();
  });
});

describe('Edge Cases: Model-specific Tool Mode Selection', () => {
  it('should return xml for all Claude model variants', () => {
    const claudeModels = [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-latest',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
      'claude-3-sonnet-20240229',
      'claude-2.1',
      'claude-instant-1.2',
    ];
    
    for (const model of claudeModels) {
      expect(resolveToolModeForModel(model)).toBe('xml');
    }
  });
  
  it('should return native for all OpenRouter models', () => {
    const openrouterModels = [
      'anthropic/claude-3-opus',
      'anthropic/claude-3-sonnet',
      'openai/gpt-4-turbo',
      'meta-llama/llama-3.1-70b-instruct',
      'google/gemini-pro',
      'mistralai/mistral-large',
    ];
    
    for (const model of openrouterModels) {
      expect(resolveToolModeForModel(model)).toBe('native');
    }
  });
  
  it('should return native for unknown models as safe default', () => {
    expect(resolveToolModeForModel('unknown-model')).toBe('native');
    expect(resolveToolModeForModel('gpt-4')).toBe('native');
    expect(resolveToolModeForModel('llama-3-70b')).toBe('native');
  });
});

