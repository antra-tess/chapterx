/**
 * Thinking cache: one response's thinking per assistant turn.
 *
 * The API validates the thinking blocks of the latest thinking-bearing
 * assistant turn and rejects blocks from several responses flattened into it
 * (a tool loop's steps, or merged consecutive bot messages).
 *
 * Run with: npx vitest run thinking-cache
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  finalStepThinkingBlocks,
  persistThinkingBlocks,
  loadThinkingBlocks,
  attachThinkingBlocks,
  sanitizeLatestThinkingTurn,
  type ThinkingBlock,
  type ThinkingGroup,
} from './thinking-cache.js'
import { ContextBuilder } from '../context/builder.js'
import type { BotConfig, ContentBlock, DiscordMessage } from '../types.js'

function thinking(sig: string): ThinkingBlock {
  return { type: 'thinking', thinking: '', signature: sig }
}

function text(t: string): ContentBlock {
  return { type: 'text', text: t }
}

function group(blocks: ThinkingBlock[], singleResponse = true): ThinkingGroup {
  return { blocks, singleResponse }
}

function sigs(content: ContentBlock[]): string[] {
  return content.map(b =>
    b.type === 'thinking' ? `T:${b.signature}` : b.type === 'text' ? `t:${b.text}` : b.type
  )
}

describe('finalStepThinkingBlocks', () => {
  it('keeps only the blocks after the last tool step', () => {
    const A = thinking('A')
    const B = thinking('B')
    const content = [
      A,
      { type: 'tool_use', id: 'tu1', name: 'search', input: {} },
      { type: 'tool_result', toolUseId: 'tu1', content: 'r' },
      B,
      { type: 'text', text: 'answer' },
    ]
    expect(finalStepThinkingBlocks(content)).toEqual([B])
  })

  it('keeps every block of a response without tools, redacted included', () => {
    const A = thinking('A')
    const R = { type: 'redacted_thinking' as const, data: 'x' }
    expect(finalStepThinkingBlocks([A, R, { type: 'text', text: 'hi' }])).toEqual([A, R])
  })

  it('returns nothing when the loop ended on a tool call', () => {
    expect(finalStepThinkingBlocks([
      thinking('A'),
      { type: 'tool_use', id: 'tu1', name: 'search', input: {} },
    ])).toEqual([])
  })
})

describe('persist / load', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'thinking-cache-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('marks new entries single-response, even with several blocks', () => {
    persistThinkingBlocks(dir, 'bot', 'ch', ['m1'], [thinking('A'), thinking('B')])
    const loaded = loadThinkingBlocks(dir, 'bot', 'ch')
    expect(loaded.get('m1')?.singleResponse).toBe(true)
    expect(loaded.get('m1')?.blocks.map(b => (b as { signature?: string }).signature)).toEqual(['A', 'B'])
  })

  it('treats legacy multi-block entries as possibly multi-response', () => {
    const d = join(dir, 'thinking', 'bot', 'ch')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, '2026-10-03T01.jsonl'), [
      JSON.stringify({ botMessageIds: ['legacy2'], blocks: [thinking('A'), thinking('B')], timestamp: 't' }),
      JSON.stringify({ botMessageIds: ['legacy1'], blocks: [thinking('C')], timestamp: 't' }),
    ].join('\n') + '\n')
    const loaded = loadThinkingBlocks(dir, 'bot', 'ch')
    expect(loaded.get('legacy2')?.singleResponse).toBe(false)
    expect(loaded.get('legacy1')?.singleResponse).toBe(true)
  })
})

describe('sanitizeLatestThinkingTurn', () => {
  it('leaves a valid latest turn and older turns untouched', () => {
    const old = group([thinking('A'), thinking('B')], false)
    const latest = group([thinking('C')])
    const msgs = [
      { content: [...old.blocks, text('one')] as ContentBlock[] },
      { content: [text('user')] as ContentBlock[] },
      { content: [...latest.blocks, text('two')] as ContentBlock[] },
    ]
    expect(sanitizeLatestThinkingTurn(msgs, [old, latest])).toBe(0)
    expect(sigs(msgs[0]!.content)).toEqual(['T:A', 'T:B', 't:one'])
    expect(sigs(msgs[2]!.content)).toEqual(['T:C', 't:two'])
  })

  it('strips a flattened legacy turn and checks the turn before it', () => {
    const prev = group([thinking('P')])
    const flattened = group([thinking('A'), thinking('B')], false)
    const msgs = [
      { content: [...prev.blocks, text('earlier')] as ContentBlock[] },
      { content: [text('user')] as ContentBlock[] },
      { content: [...flattened.blocks, text('reply')] as ContentBlock[] },
      { content: [text('ping')] as ContentBlock[] },
    ]
    expect(sanitizeLatestThinkingTurn(msgs, [prev, flattened])).toBe(2)
    expect(sigs(msgs[2]!.content)).toEqual(['t:reply'])
    expect(sigs(msgs[0]!.content)).toEqual(['T:P', 't:earlier'])
  })

  it('keeps the leading response of a merged turn and drops the rest', () => {
    const g1 = group([thinking('G1')])
    const g2 = group([thinking('G2')])
    const msgs = [{ content: [...g1.blocks, text('first'), ...g2.blocks, text('second')] as ContentBlock[] }]
    expect(sanitizeLatestThinkingTurn(msgs, [g1, g2])).toBe(1)
    expect(sigs(msgs[0]!.content)).toEqual(['T:G1', 't:first', 't:second'])
  })

  it('drops all thinking from a turn whose leading group is unusable', () => {
    const legacy = group([thinking('A'), thinking('B')], false)
    const g2 = group([thinking('G2')])
    const msgs = [{ content: [...legacy.blocks, text('first'), ...g2.blocks, text('second')] as ContentBlock[] }]
    expect(sanitizeLatestThinkingTurn(msgs, [legacy, g2])).toBe(3)
    expect(sigs(msgs[0]!.content)).toEqual(['t:first', 't:second'])
  })

  it('drops thinking blocks of unknown origin', () => {
    const msgs = [{ content: [thinking('X'), text('reply')] as ContentBlock[] }]
    expect(sanitizeLatestThinkingTurn(msgs, [])).toBe(1)
    expect(sigs(msgs[0]!.content)).toEqual(['t:reply'])
  })
})

describe('ContextBuilder with persisted thinking', () => {
  const config = {
    name: 'Fable',
    continuation_model: 'claude-fable-5-1',
    temperature: 1,
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
    preserve_thinking_context: true,
  } as BotConfig

  function msg(id: string, content: string, bot = false): DiscordMessage {
    return {
      id,
      channelId: 'ch-1',
      guildId: 'guild-1',
      author: bot
        ? { id: 'bot-1', username: 'FableBot', displayName: 'Fable', bot: true }
        : { id: 'user-1', username: 'alice', displayName: 'Alice', bot: false },
      content,
      timestamp: new Date('2026-10-03T01:00:00Z'),
      attachments: [],
      reactions: [],
      mentions: [],
    }
  }

  it('drops a pre-fix tool-loop entry from the latest bot turn, keeps the earlier turn', async () => {
    const earlier = group([thinking('E')])
    const flattened = group([thinking('A'), thinking('B')], false)
    const result = await new ContextBuilder().buildContext({
      discordContext: {
        messages: [
          msg('u1', 'hi'),
          msg('b1', 'hello', true),
          msg('u2', 'look this up'),
          msg('b2', 'found it', true),
          msg('u3', 'm'),
        ],
        pinnedConfigs: [],
        images: [],
        documents: [],
        guildId: 'guild-1',
      },
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config,
      botDiscordUsername: 'FableBot',
      thinkingByMessageId: new Map([['b1', earlier], ['b2', flattened]]),
    })

    const botTurns = result.request.messages.filter(m => m.messageId === 'b1' || m.messageId === 'b2')
    expect(botTurns.map(m => sigs(m.content).filter(s => s.startsWith('T:')))).toEqual([['T:E'], []])
  })
})
