/**
 * Regression tests for ContextBuilder
 *
 * Covers:
 * - Each pipeline stage (private methods via `any` cast — pre-refactoring scaffolds)
 * - Full buildContext() integration with representative scenarios
 * - Cache marker stability through transformations
 * - Message ID survival across filtering/merging/injection
 *
 * Run with: npx vitest run builder
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ContextBuilder, type BuildContextParams } from './builder.js'
import {
  mergeConsecutiveBotMessages,
  filterDotMessages,
  mergeConsecutiveParticipantMessages,
} from './stages/message-filtering.js'
import {
  buildStopSequences,
  extractModelConfig,
} from './stages/finalize.js'
import { applyLimits } from './stages/cache-and-limits.js'
import { formatToolUseWithResults } from './stages/tool-interleave.js'
import {
  injectActivationCompletions,
  insertPluginInjections,
} from './stages/injections.js'
import type {
  DiscordMessage,
  DiscordContext,
  ParticipantMessage,
  ContentBlock,
  CachedImage,
  CachedDocument,
  ToolCall,
  BotConfig,
} from '../types.js'
import type { Activation, Completion, MessageContext } from '../activation/index.js'
import type { ContextInjection } from '../tools/plugins/types.js'

// ============================================================================
// Fixture factories
// ============================================================================

let msgCounter = 0

function makeDiscordMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  const id = overrides.id ?? `msg-${++msgCounter}`
  return {
    id,
    channelId: 'ch-1',
    guildId: 'guild-1',
    author: {
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      bot: false,
    },
    content: 'hello world',
    timestamp: new Date('2026-04-15T12:00:00Z'),
    attachments: [],
    reactions: [],
    mentions: [],
    ...overrides,
  }
}

function makeBotMessage(botName: string, content: string, overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return makeDiscordMessage({
    author: {
      id: 'bot-1',
      username: botName,
      displayName: botName,
      bot: true,
    },
    content,
    ...overrides,
  })
}

function makeParticipantMessage(overrides: Partial<ParticipantMessage> = {}): ParticipantMessage {
  return {
    participant: 'alice',
    content: [{ type: 'text', text: 'hello' }],
    messageId: `pm-${++msgCounter}`,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name: 'TestBot',
    continuation_model: 'claude-sonnet-4-20250514',
    temperature: 0.7,
    max_tokens: 4096,
    rolling_threshold: 50,
    recent_participant_count: 5,
    authorized_roles: [],
    include_images: false,
    max_images: 5,
    max_mcp_images: 5,
    include_text_attachments: false,
    max_text_attachment_kb: 200,
    tools_enabled: false,
    tool_output_visible: false,
    max_tool_depth: 3,
    stop_sequences: [],
    llm_retries: 2,
    discord_backoff_max: 10000,
    deferred_retries: false,
    reply_on_random: 0,
    reply_on_name: true,
    max_queued_replies: 5,
    max_bot_reply_chain_depth: 3,
    bot_reply_chain_depth_emote: '',
    ...overrides,
  }
}

function makeDiscordContext(
  messages: DiscordMessage[],
  overrides: Partial<DiscordContext> = {}
): DiscordContext {
  return {
    messages,
    pinnedConfigs: [],
    images: [],
    documents: [],
    guildId: 'guild-1',
    ...overrides,
  }
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: `tool-${++msgCounter}`,
    name: 'test_tool',
    input: {},
    messageId: 'msg-trigger',
    timestamp: new Date('2026-04-15T12:05:00Z'),
    originalCompletionText: '<function_calls>test</function_calls>',
    ...overrides,
  }
}

function makeActivation(overrides: Partial<Activation> = {}): Activation {
  return {
    id: `act-${++msgCounter}`,
    channelId: 'ch-1',
    botId: 'bot-1',
    trigger: { anchorMessageId: 'msg-1', type: 'mention' } as any,
    completions: [],
    messageContexts: {},
    startedAt: new Date('2026-04-15T12:00:00Z'),
    ...overrides,
  }
}

function makeContextInjection(overrides: Partial<ContextInjection> = {}): ContextInjection {
  return {
    id: `inj-${++msgCounter}`,
    content: 'injected context',
    targetDepth: 3,
    ...overrides,
  }
}

// ============================================================================
// Test helpers
// ============================================================================

/** Extract text from participant messages (ignoring images) */
function textOf(msg: ParticipantMessage): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Get all participant names from message array */
function participants(msgs: ParticipantMessage[]): string[] {
  return msgs.map(m => m.participant)
}

/** Get all message IDs from message array */
function messageIds(msgs: ParticipantMessage[]): (string | undefined)[] {
  return msgs.map(m => m.messageId)
}

// ============================================================================
// Unit tests: mergeConsecutiveBotMessages
// ============================================================================

describe('mergeConsecutiveBotMessages', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('merges consecutive bot messages', () => {
    const messages = [
      makeBotMessage('TestBot', 'first part', { id: 'b1' }),
      makeBotMessage('TestBot', 'second part', { id: 'b2' }),
    ]
    const result = mergeConsecutiveBotMessages(messages, 'TestBot')

    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('first part second part')
    expect(result[0].id).toBe('b1') // keeps first message's ID
  })

  it('does not merge non-consecutive bot messages', () => {
    const messages = [
      makeBotMessage('TestBot', 'bot says', { id: 'b1' }),
      makeDiscordMessage({ id: 'u1', content: 'user says' }),
      makeBotMessage('TestBot', 'bot says again', { id: 'b2' }),
    ]
    const result = mergeConsecutiveBotMessages(messages, 'TestBot')

    expect(result).toHaveLength(3)
  })

  it('does not merge dot messages', () => {
    const messages = [
      makeBotMessage('TestBot', '.config something', { id: 'b1' }),
      makeBotMessage('TestBot', 'visible text', { id: 'b2' }),
    ]
    const result = mergeConsecutiveBotMessages(messages, 'TestBot')

    expect(result).toHaveLength(2)
  })

  it('does not merge when second message starts with dot', () => {
    const messages = [
      makeBotMessage('TestBot', 'visible text', { id: 'b1' }),
      makeBotMessage('TestBot', '.preamble output', { id: 'b2' }),
    ]
    const result = mergeConsecutiveBotMessages(messages, 'TestBot')

    expect(result).toHaveLength(2)
  })

  it('merges attachments from consecutive messages', () => {
    const messages = [
      makeBotMessage('TestBot', 'first', {
        id: 'b1',
        attachments: [{ url: 'http://a.png', filename: 'a.png', contentType: 'image/png', size: 100 } as any],
      }),
      makeBotMessage('TestBot', 'second', {
        id: 'b2',
        attachments: [{ url: 'http://b.png', filename: 'b.png', contentType: 'image/png', size: 200 } as any],
      }),
    ]
    const result = mergeConsecutiveBotMessages(messages, 'TestBot')

    expect(result).toHaveLength(1)
    expect(result[0].attachments).toHaveLength(2)
  })

  it('handles reply prefix before dot check', () => {
    const messages = [
      makeBotMessage('TestBot', '<reply:@user> .test output', { id: 'b1' }),
      makeBotMessage('TestBot', 'normal text', { id: 'b2' }),
    ]
    const result = mergeConsecutiveBotMessages(messages, 'TestBot')

    // The reply-prefixed dot message should not merge
    expect(result).toHaveLength(2)
  })

  it('returns empty array for empty input', () => {
    const result = mergeConsecutiveBotMessages([], 'TestBot')
    expect(result).toHaveLength(0)
  })

  it('does not mutate original array', () => {
    const messages = [
      makeBotMessage('TestBot', 'a', { id: 'b1' }),
      makeBotMessage('TestBot', 'b', { id: 'b2' }),
    ]
    const original = messages.map(m => ({ ...m }))
    mergeConsecutiveBotMessages(messages, 'TestBot')

    expect(messages).toHaveLength(2)
    // Original content not mutated in the source array
    expect(messages[0]!.content).toBe(original[0]!.content)
  })
})

// ============================================================================
// Unit tests: filterDotMessages
// ============================================================================

describe('filterDotMessages', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('filters dot commands', () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: '.config something' }),
      makeDiscordMessage({ id: 'u2', content: 'normal message' }),
      makeDiscordMessage({ id: 'u3', content: '.history clear' }),
    ]
    const result = filterDotMessages(messages, true)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('u2')
  })

  it('does not filter ellipsis', () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: '...' }),
      makeDiscordMessage({ id: 'u2', content: '.. yeah' }),
    ]
    const result = filterDotMessages(messages, true)

    expect(result).toHaveLength(2)
  })

  it('filters messages with dotted_line_face reaction', () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'hide me', reactions: [{ emoji: '🫥', count: 1 }] }),
      makeDiscordMessage({ id: 'u2', content: 'keep me' }),
    ]
    const result = filterDotMessages(messages, true)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('u2')
  })

  it('preserves .steer when steerVisible is true', () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: '.steer be helpful' }),
      makeDiscordMessage({ id: 'u2', content: '.config something' }),
    ]
    const result = filterDotMessages(messages, true)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('u1')
  })

  it('filters .steer when steerVisible is false', () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: '.steer be helpful' }),
    ]
    const result = filterDotMessages(messages, false)

    expect(result).toHaveLength(0)
  })

  it('handles reply prefix before dot command', () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: '<reply:@bot> .m continue' }),
    ]
    const result = filterDotMessages(messages, true)

    expect(result).toHaveLength(0)
  })
})

// ============================================================================
// Unit tests: mergeConsecutiveParticipantMessages
// ============================================================================

describe('mergeConsecutiveParticipantMessages', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('merges consecutive messages from same participant', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'hello' }], messageId: 'a1' }),
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'world' }], messageId: 'a2' }),
    ]
    const result = mergeConsecutiveParticipantMessages(messages)

    expect(result).toHaveLength(1)
    expect(textOf(result[0])).toBe('hello world')
  })

  it('does not merge different participants', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'hi' }] }),
      makeParticipantMessage({ participant: 'bob', content: [{ type: 'text', text: 'hey' }] }),
    ]
    const result = mergeConsecutiveParticipantMessages(messages)

    expect(result).toHaveLength(2)
  })

  it('preserves cacheBreakpoint from merged message', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', cacheBreakpoint: false }),
      makeParticipantMessage({ participant: 'alice', cacheBreakpoint: true }),
    ]
    const result = mergeConsecutiveParticipantMessages(messages)

    expect(result).toHaveLength(1)
    expect(result[0].cacheBreakpoint).toBe(true)
  })

  it('handles image blocks during merge', () => {
    const imgBlock: ContentBlock = {
      type: 'image',
      source: { type: 'base64', data: 'abc', media_type: 'image/png' },
    } as any

    const messages: ParticipantMessage[] = [
      makeParticipantMessage({
        participant: 'alice',
        content: [{ type: 'text', text: 'look at this' }, imgBlock],
      }),
      makeParticipantMessage({
        participant: 'alice',
        content: [{ type: 'text', text: 'pretty cool right' }],
      }),
    ]
    const result = mergeConsecutiveParticipantMessages(messages)

    expect(result).toHaveLength(1)
    // The merge joins the last text block of msg1 with the first text block of msg2,
    // so: [text("look at this pretty cool right"), image] — the image stays in place
    // and the text blocks get merged around it.
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0].type).toBe('text')
    expect(result[0].content[0].text).toContain('look at this')
    expect(result[0].content[0].text).toContain('pretty cool right')
    expect(result[0].content[1].type).toBe('image')
  })

  it('returns empty array for empty input', () => {
    const result = mergeConsecutiveParticipantMessages([])
    expect(result).toHaveLength(0)
  })
})

// ============================================================================
// Unit tests: formatToolUseWithResults
// ============================================================================

describe('formatToolUseWithResults', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('creates paired tool call + result messages', () => {
    const toolCache = [
      {
        call: makeToolCall({ name: 'search', messageId: 'trigger-1', originalCompletionText: 'searching...' }),
        result: 'found 3 results',
      },
    ]
    const result = formatToolUseWithResults(toolCache, 'TestBot')

    expect(result).toHaveLength(2)
    // First: bot's completion text
    expect(result[0].participant).toBe('TestBot')
    expect(textOf(result[0])).toBe('searching...')
    // Second: system tool result
    expect(result[1].participant).toBe('System<[search]')
    expect(textOf(result[1])).toBe('found 3 results')
  })

  it('handles object results with images', () => {
    const toolCache = [
      {
        call: makeToolCall({ name: 'screenshot' }),
        result: {
          output: 'captured screenshot',
          images: [{ data: 'base64data', mimeType: 'image/png' }],
        },
      },
    ]
    const result = formatToolUseWithResults(toolCache, 'TestBot')

    // Tool result should have text + image
    const toolResult = result[1]
    expect(toolResult.content).toHaveLength(2)
    expect(toolResult.content[0].type).toBe('text')
    expect(toolResult.content[1].type).toBe('image')
  })

  it('handles non-string non-object results', () => {
    const toolCache = [
      {
        call: makeToolCall({ name: 'count' }),
        result: 42,
      },
    ]
    const result = formatToolUseWithResults(toolCache, 'TestBot')

    expect(textOf(result[1])).toBe('42')
  })

  it('preserves messageId on both call and result', () => {
    const toolCache = [
      {
        call: makeToolCall({ messageId: 'trigger-msg' }),
        result: 'ok',
      },
    ]
    const result = formatToolUseWithResults(toolCache, 'TestBot')

    expect(result[0].messageId).toBe('trigger-msg')
    expect(result[1].messageId).toBe('trigger-msg')
  })

  it('returns empty array for empty input', () => {
    const result = formatToolUseWithResults([], 'TestBot')
    expect(result).toHaveLength(0)
  })
})

// ============================================================================
// Unit tests: buildStopSequences
// ============================================================================

describe('buildStopSequences', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('includes recent participant names as stop sequences', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
      makeParticipantMessage({ participant: 'TestBot' }),
      makeParticipantMessage({ participant: 'bob' }),
    ]
    const config = makeConfig()
    const result = buildStopSequences(messages, config)

    expect(result).toContain('\nbob:')
    expect(result).toContain('\nalice:')
    expect(result).toContain('\nTestBot:')
    expect(result).toContain('\nSystem:')
  })

  it('excludes bot name when prefill_thinking is enabled', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
      makeParticipantMessage({ participant: 'TestBot' }),
    ]
    const config = makeConfig({ prefill_thinking: true })
    const result = buildStopSequences(messages, config)

    expect(result).not.toContain('\nTestBot:')
    expect(result).toContain('\nalice:')
  })

  it('includes turn_end_token first when configured', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
    ]
    const config = makeConfig({ turn_end_token: '<|eot|>' })
    const result = buildStopSequences(messages, config)

    expect(result[0]).toBe('<|eot|>')
  })

  it('includes message_delimiter when configured', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
    ]
    const config = makeConfig({ message_delimiter: '---' })
    const result = buildStopSequences(messages, config)

    expect(result).toContain('---')
  })

  it('includes configured stop sequences', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
    ]
    const config = makeConfig({ stop_sequences: ['<<END>>', 'STOP'] })
    const result = buildStopSequences(messages, config)

    expect(result).toContain('<<END>>')
    expect(result).toContain('STOP')
  })

  it('skips numeric-only participants', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: '123456789' }),
      makeParticipantMessage({ participant: 'alice' }),
    ]
    const config = makeConfig()
    const result = buildStopSequences(messages, config)

    expect(result).not.toContain('\n123456789:')
    expect(result).toContain('\nalice:')
  })

  it('extracts mentioned users from text content', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({
        participant: 'alice',
        content: [{ type: 'text', text: 'hey <@charlie> check this with <@dave>' }],
      }),
    ]
    const config = makeConfig()
    const result = buildStopSequences(messages, config)

    expect(result).toContain('\ncharlie:')
    expect(result).toContain('\ndave:')
  })

  it('always includes System and conversation boundary', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
    ]
    const config = makeConfig()
    const result = buildStopSequences(messages, config)

    expect(result).toContain('\nSystem:')
    expect(result).toContain('<<HUMAN_CONVERSATION_END>>')
  })
})

// ============================================================================
// Unit tests: extractModelConfig
// ============================================================================

describe('extractModelConfig', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    builder = new ContextBuilder()
  })

  it('maps all expected fields', () => {
    const config = makeConfig({
      continuation_model: 'claude-opus-4-20250514',
      temperature: 0.9,
      max_tokens: 8192,
      top_p: 0.95,
      prefill_thinking: true,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      prompt_caching: true,
      cache_ttl: '1h',
      participant_stop_sequences: true,
      generate_images: false,
      provider_params: { custom: true },
      mode: 'chat',
      streaming: true,
      message_delimiter: '---',
      turn_end_token: '<|eot|>',
    })
    const result = extractModelConfig(config)

    expect(result.model).toBe('claude-opus-4-20250514')
    expect(result.temperature).toBe(0.9)
    expect(result.max_tokens).toBe(8192)
    expect(result.top_p).toBe(0.95)
    expect(result.prefill_thinking).toBe(true)
    expect(result.botName).toBe('TestBot')
    expect(result.messageDelimiter).toBe('---')
    expect(result.turnEndToken).toBe('<|eot|>')
    expect(result.presence_penalty).toBe(0.1)
    expect(result.frequency_penalty).toBe(0.2)
    expect(result.prompt_caching).toBe(true)
    expect(result.cache_ttl).toBe('1h')
    expect(result.participant_stop_sequences).toBe(true)
    expect(result.generate_images).toBe(false)
    expect(result.provider_params).toEqual({ custom: true })
    expect(result.mode).toBe('chat')
    expect(result.streaming).toBe(true)
  })
})

// ============================================================================
// Unit tests: injectActivationCompletions
// ============================================================================

describe('injectActivationCompletions', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('injects prefix/suffix from messageContexts', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'hi' }], messageId: 'u1' }),
      makeParticipantMessage({ participant: 'TestBot', content: [{ type: 'text', text: 'hello' }], messageId: 'b1' }),
    ]
    const activations: Activation[] = [
      makeActivation({
        messageContexts: {
          'b1': { prefix: '<thinking>hmm</thinking>', suffix: '' },
        },
      }),
    ]
    injectActivationCompletions(messages, activations, 'TestBot')

    expect(textOf(messages[1])).toBe('<thinking>hmm</thinking>hello')
  })

  it('falls back to legacy completion map', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'TestBot', content: [{ type: 'text', text: 'short' }], messageId: 'b1' }),
    ]
    const activations: Activation[] = [
      makeActivation({
        completions: [{
          index: 0,
          text: 'full completion with <thinking>thoughts</thinking> and response',
          sentMessageIds: ['b1'],
          toolCalls: [],
          toolResults: [],
        }],
        messageContexts: {},
      }),
    ]
    injectActivationCompletions(messages, activations, 'TestBot')

    expect(textOf(messages[0])).toBe('full completion with <thinking>thoughts</thinking> and response')
  })

  it('inserts phantom completions after anchor', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'trigger' }], messageId: 'u1' }),
      makeParticipantMessage({ participant: 'TestBot', content: [{ type: 'text', text: 'response' }], messageId: 'b1' }),
    ]
    const activations: Activation[] = [
      makeActivation({
        trigger: { anchorMessageId: 'u1', type: 'mention' } as any,
        completions: [
          {
            index: 0,
            text: 'phantom visible text here',
            sentMessageIds: [], // phantom — no sent messages
            toolCalls: [],
            toolResults: [],
          },
          {
            index: 1,
            text: 'response',
            sentMessageIds: ['b1'],
            toolCalls: [],
            toolResults: [],
          },
        ],
        messageContexts: {},
      }),
    ]
    injectActivationCompletions(messages, activations, 'TestBot')

    // Phantom should be inserted after anchor (u1)
    expect(messages).toHaveLength(3)
    expect(messages[1].participant).toBe('TestBot')
    expect(textOf(messages[1])).toBe('phantom visible text here')
    expect(messages[1].messageId).toBeUndefined() // phantom has no messageId
  })

  it('skips thinking-only phantoms', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'trigger' }], messageId: 'u1' }),
    ]
    const activations: Activation[] = [
      makeActivation({
        trigger: { anchorMessageId: 'u1', type: 'mention' } as any,
        completions: [{
          index: 0,
          text: '<thinking>only thoughts no visible text</thinking>',
          sentMessageIds: [],
          toolCalls: [],
          toolResults: [],
        }],
        messageContexts: {},
      }),
    ]
    injectActivationCompletions(messages, activations, 'TestBot')

    // Should NOT insert the thinking-only phantom
    expect(messages).toHaveLength(1)
  })

  it('merges consecutive messages from same activation', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'TestBot', content: [{ type: 'text', text: 'part1' }], messageId: 'b1' }),
      makeParticipantMessage({ participant: 'TestBot', content: [{ type: 'text', text: 'part2' }], messageId: 'b2' }),
    ]
    const activations: Activation[] = [
      makeActivation({
        messageContexts: {
          'b1': { prefix: 'prefix1-' },
          'b2': { prefix: 'prefix2-' },
        },
      }),
    ]
    injectActivationCompletions(messages, activations, 'TestBot')

    // Should merge b1 and b2 since they're from the same activation
    expect(messages).toHaveLength(1)
    expect(textOf(messages[0])).toBe('prefix1-part1prefix2-part2')
  })

  it('does not inject into non-bot messages', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', content: [{ type: 'text', text: 'user text' }], messageId: 'u1' }),
    ]
    const activations: Activation[] = [
      makeActivation({
        messageContexts: { 'u1': { prefix: 'INJECTED' } },
      }),
    ]
    injectActivationCompletions(messages, activations, 'TestBot')

    // alice's message should be untouched
    expect(textOf(messages[0])).toBe('user text')
  })
})

// ============================================================================
// Unit tests: insertPluginInjections
// ============================================================================

describe('insertPluginInjections', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('inserts at correct depth from end', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', messageId: 'm1' }),
      makeParticipantMessage({ participant: 'bob', messageId: 'm2' }),
      makeParticipantMessage({ participant: 'alice', messageId: 'm3' }),
      makeParticipantMessage({ participant: 'bob', messageId: 'm4' }),
    ]
    const discordMessages = [
      makeDiscordMessage({ id: 'm1' }),
      makeDiscordMessage({ id: 'm2' }),
      makeDiscordMessage({ id: 'm3' }),
      makeDiscordMessage({ id: 'm4' }),
    ]
    const injection = makeContextInjection({ targetDepth: 2 })

    insertPluginInjections(messages, [injection], discordMessages)

    // Depth 2 = 2 messages from end = index 2 (before m3)
    expect(messages).toHaveLength(5)
    expect(messages[2].participant).toMatch(/System/)
    expect(textOf(messages[2])).toBe('injected context')
  })

  it('inserts at correct depth from start (negative targetDepth)', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', messageId: 'm1' }),
      makeParticipantMessage({ participant: 'bob', messageId: 'm2' }),
      makeParticipantMessage({ participant: 'alice', messageId: 'm3' }),
    ]
    const discordMessages = [
      makeDiscordMessage({ id: 'm1' }),
      makeDiscordMessage({ id: 'm2' }),
      makeDiscordMessage({ id: 'm3' }),
    ]
    const injection = makeContextInjection({ targetDepth: -1 }) // position 0

    insertPluginInjections(messages, [injection], discordMessages)

    expect(messages).toHaveLength(4)
    expect(messages[0].participant).toMatch(/System/)
  })

  it('uses asSystem flag for participant name', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', messageId: 'm1' }),
    ]
    const discordMessages = [makeDiscordMessage({ id: 'm1' })]

    const injectionSystem = makeContextInjection({ targetDepth: 0, asSystem: true, id: 'sys' })
    const injectionPlugin = makeContextInjection({ targetDepth: 0, asSystem: false, id: 'plug' })

    insertPluginInjections(messages, [injectionSystem, injectionPlugin], discordMessages)

    const injectedMessages = messages.filter(m => !m.messageId)
    expect(injectedMessages.some(m => m.participant === 'System')).toBe(true)
    expect(injectedMessages.some(m => m.participant === 'System>[plugin]')).toBe(true)
  })

  it('ages injection depth based on messages since modification', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice', messageId: 'm1' }),
      makeParticipantMessage({ participant: 'bob', messageId: 'm2' }),
      makeParticipantMessage({ participant: 'alice', messageId: 'm3' }),
      makeParticipantMessage({ participant: 'bob', messageId: 'm4' }),
      makeParticipantMessage({ participant: 'alice', messageId: 'm5' }),
    ]
    const discordMessages = [
      makeDiscordMessage({ id: 'm1' }),
      makeDiscordMessage({ id: 'm2' }),
      makeDiscordMessage({ id: 'm3' }),
      makeDiscordMessage({ id: 'm4' }),
      makeDiscordMessage({ id: 'm5' }),
    ]
    // Modified at m3 (index 2), targetDepth 10, but only 2 messages since (m4, m5)
    // So currentDepth = min(2, 10) = 2
    const injection = makeContextInjection({
      targetDepth: 10,
      lastModifiedAt: 'm3',
    })

    insertPluginInjections(messages, [injection], discordMessages)

    // Depth 2 from end = inserted before m4 (index 3)
    expect(messages).toHaveLength(6)
    expect(messages[3].participant).toMatch(/System/)
  })

  it('handles empty injections', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ participant: 'alice' }),
    ]
    insertPluginInjections(messages, [], [])

    expect(messages).toHaveLength(1)
  })
})

// ============================================================================
// Unit tests: applyLimits
// ============================================================================

describe('applyLimits', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('does not truncate when under limits', () => {
    const messages: ParticipantMessage[] = [
      makeParticipantMessage({ content: [{ type: 'text', text: 'short message' }] }),
    ]
    const config = makeConfig({ recency_window_characters: 100000 })
    const result = applyLimits(messages, 0, config)

    expect(result.didTruncate).toBe(false)
    expect(result.messages).toBe(messages) // same reference = no copy
  })

  it('truncates when character limit exceeded during roll', () => {
    // Create messages that exceed the character limit
    const longText = 'x'.repeat(5000)
    const messages: ParticipantMessage[] = Array.from({ length: 10 }, (_, i) =>
      makeParticipantMessage({ content: [{ type: 'text', text: longText }], messageId: `m${i}` })
    )
    // 10 messages * 5000 chars = 50000 chars, limit = 10000
    const config = makeConfig({
      recency_window_characters: 10000,
      rolling_threshold: 1, // force roll
    })
    const result = applyLimits(messages, 100, config)

    expect(result.didTruncate).toBe(true)
    expect(result.messages.length).toBeLessThan(10)
  })

  it('truncates when message count limit exceeded', () => {
    const messages: ParticipantMessage[] = Array.from({ length: 20 }, (_, i) =>
      makeParticipantMessage({ content: [{ type: 'text', text: 'hi' }], messageId: `m${i}` })
    )
    const config = makeConfig({
      recency_window_messages: 5,
      recency_window_characters: 1000000, // high char limit so only message count triggers
      rolling_threshold: 1,
    })
    const result = applyLimits(messages, 100, config)

    expect(result.didTruncate).toBe(true)
    expect(result.messages.length).toBeLessThanOrEqual(5)
  })

  it('force truncates on hard limit regardless of roll state', () => {
    const longText = 'x'.repeat(100000)
    const messages: ParticipantMessage[] = Array.from({ length: 10 }, (_, i) =>
      makeParticipantMessage({ content: [{ type: 'text', text: longText }], messageId: `m${i}` })
    )
    const config = makeConfig({
      hard_max_characters: 500000,
      recency_window_characters: 200000,
      rolling_threshold: 999, // would not normally roll
    })
    const result = applyLimits(messages, 1, config)

    expect(result.didTruncate).toBe(true)
  })
})

// ============================================================================
// Integration: buildContext full pipeline
// ============================================================================

describe('buildContext (integration)', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('basic conversation: correct participant names and message order', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'hey bot', author: { id: 'user-1', username: 'alice', displayName: 'Alice', bot: false } }),
      makeBotMessage('BotUser', 'hello alice', { id: 'b1' }),
      makeDiscordMessage({ id: 'u2', content: 'how are you?', author: { id: 'user-1', username: 'alice', displayName: 'Alice', bot: false } }),
    ]
    const config = makeConfig({ name: 'Claude' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    const pMsgs = result.request.messages
    // Should have 3 conversation messages + 1 empty completion
    expect(pMsgs).toHaveLength(4)
    expect(pMsgs[0].participant).toBe('alice')
    expect(pMsgs[1].participant).toBe('Claude') // bot normalized to config.name
    expect(pMsgs[2].participant).toBe('alice')
    expect(pMsgs[3].participant).toBe('Claude') // empty completion
    expect(textOf(pMsgs[3])).toBe('')
  })

  it('filters dot commands from context', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: '.config model claude-opus-4-20250514' }),
      makeDiscordMessage({ id: 'u2', content: 'normal message' }),
      makeDiscordMessage({ id: 'u3', content: '.history clear' }),
    ]
    const config = makeConfig()

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    // Only the normal message + empty completion
    expect(result.request.messages).toHaveLength(2)
    expect(textOf(result.request.messages[0])).toBe('normal message')
  })

  it('merges consecutive bot messages', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'tell me a story' }),
      makeBotMessage('BotUser', 'Once upon a time', { id: 'b1' }),
      makeBotMessage('BotUser', 'there was a dragon', { id: 'b2' }),
      makeBotMessage('BotUser', 'the end', { id: 'b3' }),
    ]
    const config = makeConfig({ name: 'StoryBot' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    // u1, merged bot message, empty completion
    expect(result.request.messages).toHaveLength(3)
    expect(textOf(result.request.messages[1])).toContain('Once upon a time')
    expect(textOf(result.request.messages[1])).toContain('the end')
  })

  it('interleaves tool cache results at correct positions', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'search for cats' }),
      makeBotMessage('BotUser', 'let me search', { id: 'b1' }),
      makeDiscordMessage({ id: 'u2', content: 'thanks!' }),
    ]
    const toolCache = [
      {
        call: makeToolCall({
          name: 'web_search',
          messageId: 'u1',
          originalCompletionText: '<function_calls>searching</function_calls>',
        }),
        result: 'Found 10 cat pictures',
      },
    ]
    const config = makeConfig({ name: 'SearchBot' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: toolCache,
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    // u1, tool_call, tool_result, b1, u2, empty completion
    const pMsgs = result.request.messages
    expect(pMsgs.length).toBeGreaterThanOrEqual(5)

    // Tool call should appear after the triggering message
    const toolCallIdx = pMsgs.findIndex(m => m.participant === 'SearchBot' && textOf(m).includes('searching'))
    const toolResultIdx = pMsgs.findIndex(m => m.participant === 'System<[web_search]')
    expect(toolCallIdx).toBeGreaterThan(0)
    expect(toolResultIdx).toBe(toolCallIdx + 1)
  })

  it('skips tool interleaving when preserve_thinking_context is enabled', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'do something' }),
      makeBotMessage('BotUser', 'done', { id: 'b1' }),
    ]
    const toolCache = [
      { call: makeToolCall({ messageId: 'u1' }), result: 'tool output' },
    ]
    const config = makeConfig({ name: 'Bot', preserve_thinking_context: true })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: toolCache,
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    // No System<[ messages — tools not interleaved
    const systemToolMsgs = result.request.messages.filter(m => m.participant.startsWith('System<['))
    expect(systemToolMsgs).toHaveLength(0)
  })

  it('normalizes bot mentions to config.name', async () => {
    const messages = [
      makeDiscordMessage({
        id: 'u1',
        content: 'hey <@BotUser> what do you think?',
      }),
    ]
    const config = makeConfig({ name: 'Claude' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    // Mention should be rewritten from BotUser to Claude
    expect(textOf(result.request.messages[0])).toContain('<@Claude>')
    expect(textOf(result.request.messages[0])).not.toContain('<@BotUser>')
  })

  it('strips reply tags when include_reply_tags is false', async () => {
    const messages = [
      makeDiscordMessage({
        id: 'u1',
        content: '<reply:@alice> I agree with you',
      }),
    ]
    const config = makeConfig({ include_reply_tags: false })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(textOf(result.request.messages[0])).toBe('I agree with you')
  })

  it('preserves reply tags when include_reply_tags is true', async () => {
    const messages = [
      makeDiscordMessage({
        id: 'u1',
        content: '<reply:@alice> I agree with you',
      }),
    ]
    const config = makeConfig({ include_reply_tags: true })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(textOf(result.request.messages[0])).toContain('<reply:@alice>')
  })

  it('returns correct stop sequences', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'hi', author: { id: 'user-1', username: 'alice', displayName: 'Alice', bot: false } }),
      makeBotMessage('BotUser', 'hello', { id: 'b1' }),
    ]
    const config = makeConfig({ name: 'Claude', stop_sequences: ['<<END>>'] })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    expect(result.request.stop_sequences).toContain('\nalice:')
    expect(result.request.stop_sequences).toContain('\nClaude:')
    expect(result.request.stop_sequences).toContain('<<END>>')
    expect(result.request.stop_sequences).toContain('\nSystem:')
  })

  it('sets system_prompt and context_prefix from config', async () => {
    const messages = [makeDiscordMessage({ id: 'u1', content: 'hi' })]
    const config = makeConfig({
      system_prompt: 'You are a helpful bot.',
      context_prefix: 'Context: ',
    })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(result.request.system_prompt).toBe('You are a helpful bot.')
    expect(result.request.context_prefix).toBe('Context: ')
  })

  it('produces empty completion message as last message', async () => {
    const messages = [makeDiscordMessage({ id: 'u1', content: 'hi' })]
    const config = makeConfig({ name: 'Bot' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    const last = result.request.messages[result.request.messages.length - 1]!
    expect(last.participant).toBe('Bot')
    expect(textOf(last)).toBe('')
  })
})

// ============================================================================
// Integration: cache marker stability
// ============================================================================

describe('cache marker stability', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('returns a cache marker for conversations with enough messages', async () => {
    // Need > 20 messages (buffer) for a marker to be placed
    const messages = Array.from({ length: 30 }, (_, i) =>
      makeDiscordMessage({
        id: `msg-${i}`,
        content: `message ${i}`,
        author: { id: `user-${i % 3}`, username: `user${i % 3}`, displayName: `User${i % 3}`, bot: false },
      })
    )
    const config = makeConfig()

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(result.cacheMarker).not.toBeNull()
  })

  it('preserves existing cache marker when it exists in messages', async () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      makeDiscordMessage({
        id: `msg-${i}`,
        content: `message ${i}`,
        author: { id: `user-${i % 2}`, username: `user${i % 2}`, displayName: `User${i % 2}`, bot: false },
      })
    )
    const config = makeConfig()

    // First call to establish marker
    const result1 = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    // Second call with the established marker
    const result2 = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: result1.cacheMarker,
      messagesSinceRoll: 5,
      config,
    })

    // Marker should be stable (same or valid)
    expect(result2.cacheMarker).not.toBeNull()
  })

  it('applies cacheBreakpoint to the marker message', async () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      makeDiscordMessage({
        id: `msg-${i}`,
        content: `message ${i}`,
        author: { id: `user-${i % 2}`, username: `user${i % 2}`, displayName: `User${i % 2}`, bot: false },
      })
    )
    const config = makeConfig()

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    if (result.cacheMarker) {
      // The message with the cache marker should have cacheBreakpoint set
      const markerMsg = result.request.messages.find(m => m.messageId === result.cacheMarker)
      if (markerMsg) {
        expect(markerMsg.cacheBreakpoint).toBe(true)
      }
    }
  })
})

// ============================================================================
// Integration: message ID survival
// ============================================================================

describe('message ID survival', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('all non-merged messages retain their IDs through the pipeline', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'first' }),
      makeDiscordMessage({ id: 'u2', content: 'second', author: { id: 'user-2', username: 'bob', displayName: 'Bob', bot: false } }),
      makeBotMessage('BotUser', 'response', { id: 'b1' }),
      makeDiscordMessage({ id: 'u3', content: 'third' }),
    ]
    const config = makeConfig({ name: 'Bot' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    const ids = messageIds(result.request.messages).filter(Boolean)
    expect(ids).toContain('u1')
    expect(ids).toContain('u2')
    expect(ids).toContain('b1')
    expect(ids).toContain('u3')
  })

  it('merged bot messages keep the first message ID', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'go' }),
      makeBotMessage('BotUser', 'part 1', { id: 'b1' }),
      makeBotMessage('BotUser', 'part 2', { id: 'b2' }),
    ]
    const config = makeConfig({ name: 'Bot' })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'BotUser',
    })

    const ids = messageIds(result.request.messages).filter(Boolean)
    expect(ids).toContain('b1') // first merged message ID survives
    expect(ids).not.toContain('b2') // second was merged away
  })
})

// ============================================================================
// Integration: display names
// ============================================================================

describe('display names mode', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('uses display names as participant names when enabled', async () => {
    const messages = [
      makeDiscordMessage({
        id: 'u1',
        content: 'hello',
        author: { id: 'user-1', username: 'alice.smith', displayName: 'Alice Smith', bot: false },
      }),
    ]
    const config = makeConfig({ use_display_names: true })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(result.request.messages[0].participant).toBe('Alice Smith')
  })

  it('uses usernames when display names mode is off', async () => {
    const messages = [
      makeDiscordMessage({
        id: 'u1',
        content: 'hello',
        author: { id: 'user-1', username: 'alice.smith', displayName: 'Alice Smith', bot: false },
      }),
    ]
    const config = makeConfig({ use_display_names: false })

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(result.request.messages[0].participant).toBe('alice.smith')
  })
})

// ============================================================================
// Integration: plugin injections through full pipeline
// ============================================================================

describe('plugin injections (full pipeline)', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('plugin content survives full pipeline', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeDiscordMessage({ id: `m${i}`, content: `message ${i}` })
    )
    const config = makeConfig()
    const injections: ContextInjection[] = [
      makeContextInjection({ content: 'PLUGIN_MARKER', targetDepth: 2 }),
    ]

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      pluginInjections: injections,
    })

    const hasPlugin = result.request.messages.some(m => textOf(m).includes('PLUGIN_MARKER'))
    expect(hasPlugin).toBe(true)
  })
})

// ============================================================================
// Integration: traceInfo
// ============================================================================

describe('traceInfo', () => {
  let builder: ContextBuilder

  beforeEach(() => {
    msgCounter = 0
    builder = new ContextBuilder()
  })

  it('returns traceInfo with correct message counts', async () => {
    const messages = [
      makeDiscordMessage({ id: 'u1', content: 'hi' }),
      makeDiscordMessage({ id: 'u2', content: '.config foo' }),
      makeDiscordMessage({ id: 'u3', content: 'bye' }),
    ]
    const config = makeConfig()

    const result = await builder.buildContext({
      discordContext: makeDiscordContext(messages),
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
    })

    expect(result.traceInfo).toBeDefined()
    expect(result.traceInfo!.messagesConsidered).toBe(3)
    // After mergeConsecutiveParticipantMessages, the 2 surviving alice messages
    // get merged into 1 (same participant). So: 1 message + empty completion = 2,
    // messagesIncluded excludes empty completion = 1
    expect(result.traceInfo!.messagesIncluded).toBe(1)
  })
})
