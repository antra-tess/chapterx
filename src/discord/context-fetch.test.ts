/**
 * Tests for the context fetch pipeline.
 *
 * These test the extracted, standalone functions in context-fetch.ts
 * using mocked FetchDeps — no Discord.js client or push cache needed.
 *
 * Run with: npm test -- context-fetch
 */

import { describe, it, expect } from 'vitest'
import type { Message, TextChannel } from 'discord.js'
import {
  parseHistoryCommand,
  extractMessageIdFromUrl,
  extractChannelIdFromUrl,
  fetchChannelMessages,
  type FetchDeps,
} from './context-fetch.js'

// ────────────────────────────────────────────────────────────────────────────
// Constants — all IDs must be numeric (Discord snowflake format)
// ────────────────────────────────────────────────────────────────────────────

const BOT_ID = '900000000000000001'
const OTHER_BOT_ID = '900000000000000002'
const GUILD_ID = '800000000000000001'
const CH1_ID = '100000000000000001'
const CH2_ID = '100000000000000002'

/** Build a Discord message URL from numeric IDs. */
function discordUrl(channelId: string, messageId: string, guildId = GUILD_ID): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

/** Create a mock Message with minimal fields needed by the fetch pipeline. */
function msg(id: string, content: string, opts?: {
  authorId?: string
  memberRoles?: string[]
}): Message {
  const roleCache = new Map<string, { name: string }>()
  if (opts?.memberRoles) {
    opts.memberRoles.forEach((name, i) => {
      roleCache.set(String(i), { name })
    })
  }

  return {
    id,
    content,
    member: opts?.memberRoles ? {
      roles: {
        cache: {
          values: () => roleCache.values(),
          [Symbol.iterator]: () => roleCache.values(),
        },
      },
    } : null,
    author: { id: opts?.authorId ?? '700000000000000001' },
  } as unknown as Message
}

/** Create a mock TextChannel. */
function channel(id: string): TextChannel {
  return {
    id,
    isTextBased: () => true,
    name: `channel-${id}`,
  } as unknown as TextChannel
}

/**
 * Create mock FetchDeps backed by in-memory message arrays.
 *
 * Channels is a map of channelId → Message[] (in any order — will be sorted internally).
 */
function createMockDeps(
  channels: Record<string, Message[]>,
  botUserId: string = BOT_ID,
): FetchDeps {
  return {
    fetchBatch: async (ch: TextChannel, opts: { before?: string; limit: number }) => {
      const msgs = channels[ch.id] ?? []
      // Sort newest-first (matching Discord API behavior)
      const sorted = [...msgs].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))

      let startIdx = 0
      if (opts.before) {
        startIdx = sorted.findIndex(m => m.id < opts.before!)
        if (startIdx === -1) return [] // All messages are newer than cursor
      }
      return sorted.slice(startIdx, startIdx + opts.limit)
    },

    fetchSingle: async (ch: TextChannel, id: string) => {
      const msgs = channels[ch.id] ?? []
      return msgs.find(m => m.id === id) ?? null
    },

    resolveChannel: async (id: string) => {
      if (channels[id] !== undefined) {
        return channel(id)
      }
      return null
    },

    botUserId,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// parseHistoryCommand
// ────────────────────────────────────────────────────────────────────────────

describe('parseHistoryCommand', () => {
  it('returns null for bare .history (clear)', () => {
    expect(parseHistoryCommand('.history')).toBeNull()
  })

  it('returns null for .history with only whitespace body', () => {
    expect(parseHistoryCommand('.history\n  \n  ')).toBeNull()
  })

  it('returns null for .history with bot mention (clear for specific bot)', () => {
    expect(parseHistoryCommand(`.history <@${BOT_ID}>`)).toBeNull()
  })

  it('returns null for .history with bot name (clear for specific bot)', () => {
    expect(parseHistoryCommand('.history Claude')).toBeNull()
  })

  it('returns false for malformed body (no --- separator)', () => {
    expect(parseHistoryCommand('.history\nlast: https://discord.com/channels/1/2/3')).toBe(false)
  })

  it('returns null for --- body without last: field', () => {
    expect(parseHistoryCommand('.history\n---\nfirst: https://discord.com/channels/1/2/3')).toBeNull()
  })

  it('returns null for --- body with empty last: field', () => {
    expect(parseHistoryCommand('.history\n---\nlast:')).toBeNull()
  })

  it('parses range with last: only', () => {
    const url = discordUrl(CH1_ID, '333')
    const result = parseHistoryCommand(`.history\n---\nlast: ${url}`)
    expect(result).toEqual({ last: url })
  })

  it('parses range with both first: and last:', () => {
    const firstUrl = discordUrl(CH1_ID, '100')
    const lastUrl = discordUrl(CH1_ID, '333')
    const result = parseHistoryCommand(`.history\n---\nfirst: ${firstUrl}\nlast: ${lastUrl}`)
    expect(result).toEqual({ first: firstUrl, last: lastUrl })
  })

  it('ignores blank lines in YAML body', () => {
    const url = discordUrl(CH1_ID, '333')
    const result = parseHistoryCommand(`.history\n---\n\nlast: ${url}\n\n`)
    expect(result).toEqual({ last: url })
  })

  it('handles .history with bot mention AND range body', () => {
    const url = discordUrl(CH1_ID, '333')
    const result = parseHistoryCommand(`.history <@${BOT_ID}>\n---\nlast: ${url}`)
    expect(result).toEqual({ last: url })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// URL extraction helpers
// ────────────────────────────────────────────────────────────────────────────

describe('extractMessageIdFromUrl', () => {
  it('extracts message ID from standard Discord URL', () => {
    expect(extractMessageIdFromUrl('https://discord.com/channels/111/222/333')).toBe('333')
  })

  it('extracts message ID from URL with large snowflake IDs', () => {
    expect(extractMessageIdFromUrl(
      `https://discord.com/channels/${GUILD_ID}/${CH1_ID}/5555555555555555555`
    )).toBe('5555555555555555555')
  })

  it('returns null for malformed URL', () => {
    expect(extractMessageIdFromUrl('not-a-url')).toBeNull()
  })

  it('returns null for URL with missing segments', () => {
    expect(extractMessageIdFromUrl('https://discord.com/channels/111/222')).toBeNull()
  })
})

describe('extractChannelIdFromUrl', () => {
  it('extracts channel ID from standard Discord URL', () => {
    expect(extractChannelIdFromUrl('https://discord.com/channels/111/222/333')).toBe('222')
  })

  it('returns null for malformed URL', () => {
    expect(extractChannelIdFromUrl('not-a-url')).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — basic fetch (no .history)
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — basic fetch', () => {
  const CH = CH1_ID

  it('fetches messages backward from trigger in chronological order', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'oldest'),
        msg('2', 'middle'),
        msg('3', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['1', '2', '3'])
    expect(result.didClear).toBe(false)
    expect(result.originChannelId).toBeNull()
  })

  it('includes the trigger message (startFromId)', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [msg('1', 'hello'), msg('2', 'trigger')],
    })

    const result = await fetchChannelMessages(ch, '2', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toContain('2')
  })

  it('respects maxMessages limit', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'a'), msg('2', 'b'), msg('3', 'c'),
        msg('4', 'd'), msg('5', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '5', undefined, 3, [], false, deps)
    expect(result.messages.length).toBeLessThanOrEqual(3)
    expect(result.messages[result.messages.length - 1]!.id).toBe('5')
  })

  it('handles empty channel', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({ [CH]: [] })

    const result = await fetchChannelMessages(ch, undefined, undefined, 100, [], false, deps)
    expect(result.messages).toEqual([])
    expect(result.didClear).toBe(false)
  })

  it('handles channel with only the trigger message', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({ [CH]: [msg('1', 'only message')] })

    const result = await fetchChannelMessages(ch, '1', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['1'])
  })

  it('returns messages in chronological order (oldest first)', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('10', 'first'), msg('20', 'second'), msg('30', 'third'),
        msg('40', 'fourth'), msg('50', 'fifth'),
      ],
    })

    const result = await fetchChannelMessages(ch, '50', undefined, 100, [], false, deps)
    const ids = result.messages.map(m => m.id)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  it('handles startFromId = undefined (no trigger message)', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [msg('1', 'a'), msg('2', 'b'), msg('3', 'c')],
    })

    const result = await fetchChannelMessages(ch, undefined, undefined, 100, [], false, deps)
    expect(result.messages.length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — .history clear
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — .history clear', () => {
  const CH = CH1_ID

  it('clears everything before .history, keeps messages after', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old message'),
        msg('2', 'should be cleared'),
        msg('3', '.history'),
        msg('4', 'after history'),
        msg('5', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '5', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['4', '5'])
    expect(result.didClear).toBe(true)
  })

  it('sets didClear = true', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [msg('1', 'old'), msg('2', '.history'), msg('3', 'trigger')],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    expect(result.didClear).toBe(true)
  })

  it('handles .history as the last message before trigger (nothing between)', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [msg('1', 'old'), msg('2', '.history'), msg('3', 'trigger')],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['3'])
  })

  it('handles .history with nothing after it except trigger', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'very old'),
        msg('2', 'old'),
        msg('3', '.history'),
        msg('4', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '4', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['4'])
    expect(result.didClear).toBe(true)
  })

  it('multiple .history commands — newest wins', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'ancient'),
        msg('2', '.history'),   // older — should be ignored
        msg('3', 'between'),
        msg('4', '.history'),   // newer — should win
        msg('5', 'after'),
        msg('6', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '6', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['5', '6'])
    expect(result.didClear).toBe(true)
  })

  it('preserves multiple messages between .history and trigger', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'cleared'),
        msg('2', '.history'),
        msg('3', 'kept-1'),
        msg('4', 'kept-2'),
        msg('5', 'kept-3'),
        msg('6', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '6', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['3', '4', '5', '6'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — .history bot targeting
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — .history bot targeting', () => {
  const CH = CH1_ID

  it('.history targeted at this bot clears context', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', `.history <@${BOT_ID}>`),
        msg('3', 'trigger'),
      ],
    }, BOT_ID)

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['3'])
    expect(result.didClear).toBe(true)
  })

  it('.history targeted at different bot is skipped', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', `.history <@${OTHER_BOT_ID}>`),
        msg('3', 'trigger'),
      ],
    }, BOT_ID)

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    // .history was skipped — all messages present (minus .history msg itself which is skipped via continue)
    expect(result.messages.map(m => m.id)).toEqual(['1', '3'])
    expect(result.didClear).toBe(false)
  })

  it('.history @OtherBot then bare .history (older) — bare wins for this bot', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'very old'),
        msg('2', '.history'),                          // bare — applies to all bots
        msg('3', 'between'),
        msg('4', `.history <@${OTHER_BOT_ID}>`),       // newer but for different bot — skipped
        msg('5', 'after'),
        msg('6', 'trigger'),
      ],
    }, BOT_ID)

    const result = await fetchChannelMessages(ch, '6', undefined, 100, [], false, deps)
    // .history @other is skipped, then bare .history at id=2 is found
    expect(result.messages.map(m => m.id)).toEqual(['3', '5', '6'])
    expect(result.didClear).toBe(true)
  })

  it('handles .history with ! in mention format (<@!botId>)', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', `.history <@!${BOT_ID}>`),
        msg('3', 'trigger'),
      ],
    }, BOT_ID)

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    expect(result.didClear).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — .history range
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — .history range', () => {
  it('fetches from linked channel and prepends to newer messages', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'old in ch1'),
        msg('200', `.history\n---\nlast: ${discordUrl(CH2_ID, '350')}`),
        msg('300', 'after history'),
        msg('400', 'trigger'),
      ],
      [CH2_ID]: [
        msg('250', 'from ch2 oldest'),
        msg('300', 'from ch2 middle'),
        msg('350', 'from ch2 newest'),
      ],
    })

    const result = await fetchChannelMessages(ch, '400', undefined, 100, [], false, deps)
    // [ch2 messages in chronological order] + [ch1 messages after .history]
    expect(result.messages.map(m => m.id)).toEqual(['250', '300', '350', '300', '400'])
    expect(result.didClear).toBe(true)
    expect(result.originChannelId).toBe(CH1_ID)
  })

  it('sets originChannelId to the channel the .history was in', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', `.history\n---\nlast: ${discordUrl(CH2_ID, '200')}`),
        msg('200', 'trigger'),
      ],
      [CH2_ID]: [msg('150', 'linked'), msg('200', 'linked end')],
    })

    const result = await fetchChannelMessages(ch, '200', undefined, 100, [], false, deps)
    expect(result.originChannelId).toBe(CH1_ID)
  })

  it('range with first: and last: boundaries', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', `.history\n---\nfirst: ${discordUrl(CH2_ID, '220')}\nlast: ${discordUrl(CH2_ID, '280')}`),
        msg('200', 'trigger'),
      ],
      [CH2_ID]: [
        msg('200', 'too old'),
        msg('220', 'range start'),
        msg('240', 'in range'),
        msg('260', 'in range'),
        msg('280', 'range end'),
        msg('300', 'too new'),
      ],
    })

    const result = await fetchChannelMessages(ch, '200', undefined, 100, [], false, deps)
    // Range should include messages from 220 to 280 (inclusive)
    const ids = result.messages.map(m => m.id)
    expect(ids).toContain('220')
    expect(ids).toContain('240')
    expect(ids).toContain('260')
    expect(ids).toContain('280')
    // Should NOT include '200' from ch2 ('too old')
    expect(result.messages.find(m => m.id === '200' && m.content === 'too old')).toBeUndefined()
  })

  it('handles inaccessible target channel gracefully (treats as clear)', async () => {
    const NONEXISTENT = '100000000000099999'
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'old'),
        msg('200', `.history\n---\nlast: ${discordUrl(NONEXISTENT, '300')}`),
        msg('300', 'after'),
        msg('400', 'trigger'),
      ],
      // NONEXISTENT channel doesn't exist in mock
    })

    const result = await fetchChannelMessages(ch, '400', undefined, 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['300', '400'])
    expect(result.didClear).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — .history interactions
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — .history interactions', () => {
  it('.history in linked range channel is resolved recursively', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', `.history\n---\nlast: ${discordUrl(CH2_ID, '400')}`),
        msg('200', 'trigger in ch1'),
      ],
      [CH2_ID]: [
        msg('100', 'very old in ch2'),
        msg('200', '.history'),  // clear in ch2
        msg('300', 'after clear in ch2'),
        msg('400', 'end of ch2'),
      ],
    })

    const result = await fetchChannelMessages(ch, '200', undefined, 100, [], false, deps)
    // ch2 had a .history clear at id=200, so only ch2 messages after it should appear
    const ch2Messages = result.messages.filter(m => m.content.includes('ch2'))
    expect(ch2Messages.map(m => m.id)).toEqual(['300', '400'])
    // Plus ch1 trigger
    expect(result.messages[result.messages.length - 1]!.id).toBe('200')
  })

  it('.history clear after .history range (clear is newer) — clear wins', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'ancient'),
        msg('200', `.history\n---\nlast: ${discordUrl(CH2_ID, '300')}`), // range — older
        msg('300', 'between'),
        msg('400', '.history'), // clear — newer, wins
        msg('500', 'after clear'),
        msg('600', 'trigger'),
      ],
      [CH2_ID]: [
        msg('300', 'linked msg'),
      ],
    })

    const result = await fetchChannelMessages(ch, '600', undefined, 100, [], false, deps)
    // Clear at 400 is newest .history → only 500, 600
    expect(result.messages.map(m => m.id)).toEqual(['500', '600'])
    expect(result.didClear).toBe(true)
    // originChannelId should be null since the effective .history was a clear, not a range
    expect(result.originChannelId).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — recursion safety
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — recursion safety', () => {
  it('stops at max recursion depth (cycle A→B→A)', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', `.history\n---\nlast: ${discordUrl(CH2_ID, '100')}`),
        msg('200', 'trigger'),
      ],
      [CH2_ID]: [
        msg('050', `.history\n---\nlast: ${discordUrl(CH1_ID, '100')}`),
        msg('100', 'end'),
      ],
    })

    // Should not infinite loop — returns within max depth
    const result = await fetchChannelMessages(ch, '200', undefined, 100, [], false, deps)
    expect(result.didClear).toBe(true)
    expect(result.messages).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — stopAtId boundary
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — stopAtId boundary', () => {
  const CH = CH1_ID

  it('stops at stopAtId and includes the boundary message', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'too old'),
        msg('2', 'boundary'),
        msg('3', 'in range'),
        msg('4', 'in range'),
        msg('5', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '5', '2', 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['2', '3', '4', '5'])
    expect(result.messages.find(m => m.id === '1')).toBeUndefined()
  })

  it('stops even if maxMessages not reached', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'a'), msg('2', 'b'), msg('3', 'c'),
        msg('4', 'd'), msg('5', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '5', '3', 1000, [], false, deps)
    expect(result.messages.find(m => m.id === '2')).toBeUndefined()
    expect(result.messages.find(m => m.id === '1')).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — ignoreHistory flag
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — ignoreHistory', () => {
  const CH = CH1_ID

  it('skips .history processing when ignoreHistory is true', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', '.history'),
        msg('3', 'after'),
        msg('4', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '4', undefined, 100, [], true, deps)
    // .history is included as a regular message
    expect(result.messages.map(m => m.id)).toEqual(['1', '2', '3', '4'])
    expect(result.didClear).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — authorization
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — authorization', () => {
  const CH = CH1_ID

  it('.history by authorized user is processed', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', '.history', { memberRoles: ['admin'] }),
        msg('3', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, ['admin'], false, deps)
    expect(result.didClear).toBe(true)
    expect(result.messages.map(m => m.id)).toEqual(['3'])
  })

  it('.history by unauthorized user is skipped', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', '.history', { memberRoles: ['user'] }),
        msg('3', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, ['admin'], false, deps)
    expect(result.didClear).toBe(false)
    expect(result.messages.map(m => m.id)).toEqual(['1', '3'])
  })

  it('.history by user with no member data is skipped when roles required', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', '.history'),  // member is null
        msg('3', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, ['admin'], false, deps)
    expect(result.didClear).toBe(false)
  })

  it('empty authorizedRoles means no authorization required', async () => {
    const ch = channel(CH)
    const deps = createMockDeps({
      [CH]: [
        msg('1', 'old'),
        msg('2', '.history'),
        msg('3', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '3', undefined, 100, [], false, deps)
    expect(result.didClear).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// fetchChannelMessages — edge cases from review
// ────────────────────────────────────────────────────────────────────────────

describe('fetchChannelMessages — edge cases', () => {
  it('.history range overriding an older .history clear (range is newer, wins)', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'ancient'),
        msg('200', '.history'),                                                 // older clear
        msg('300', 'between'),
        msg('400', `.history\n---\nlast: ${discordUrl(CH2_ID, '300')}`),        // newer range — wins
        msg('500', 'after range'),
        msg('600', 'trigger'),
      ],
      [CH2_ID]: [
        msg('100', 'linked-1'),
        msg('200', 'linked-2'),
        msg('300', 'linked-3'),
      ],
    })

    const result = await fetchChannelMessages(ch, '600', undefined, 100, [], false, deps)
    // Newest-first: trigger(600), 500, then .history range at 400 → fetch CH2 → return
    // Range wins, older clear is never reached
    expect(result.didClear).toBe(true)
    expect(result.originChannelId).toBe(CH1_ID)
    // Should be [CH2 messages] + [500, 600]
    expect(result.messages.map(m => m.id)).toEqual(['100', '200', '300', '500', '600'])
  })

  it('message starting with .history but not a command is treated as regular message', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'old'),
        msg('200', '.historybook is a great read'),  // NOT a .history command
        msg('300', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '300', undefined, 100, [], false, deps)
    // .historybook should NOT trigger .history processing
    expect(result.didClear).toBe(false)
    expect(result.messages.map(m => m.id)).toEqual(['100', '200', '300'])
  })

  it('stopAtId when exact boundary ID does not exist (gap between messages)', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'too old'),
        msg('300', 'just above boundary'),
        msg('500', 'in range'),
        msg('700', 'trigger'),
      ],
    })

    // stopAtId='200' falls between 100 and 300
    // The <= check catches msg 100 (100 <= 200), but 100 !== 200 so it's NOT included
    const result = await fetchChannelMessages(ch, '700', '200', 100, [], false, deps)
    expect(result.messages.map(m => m.id)).toEqual(['300', '500', '700'])
    expect(result.messages.find(m => m.id === '100')).toBeUndefined()
  })

  it('maxMessages budget exhaustion during .history range recursion', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', `.history\n---\nlast: ${discordUrl(CH2_ID, '500')}`),
        msg('200', 'msg-a'),
        msg('300', 'msg-b'),
        msg('400', 'msg-c'),
        msg('500', 'trigger'),
      ],
      [CH2_ID]: [
        msg('100', 'linked-1'),
        msg('200', 'linked-2'),
        msg('300', 'linked-3'),
        msg('400', 'linked-4'),
        msg('500', 'linked-5'),
      ],
    })

    // maxMessages=6: trigger(500) + 3 messages(400,300,200) = 4 collected when .history hit
    // Recursive call gets maxMessages - 4 = 2 → only 2 messages from CH2
    const result = await fetchChannelMessages(ch, '500', undefined, 6, [], false, deps)
    expect(result.messages.length).toBeLessThanOrEqual(6)
    expect(result.didClear).toBe(true)
  })

  it('.history range pointing to same channel (self-referential)', async () => {
    const ch = channel(CH1_ID)
    const deps = createMockDeps({
      [CH1_ID]: [
        msg('100', 'very old'),
        msg('200', 'old'),
        msg('300', 'between'),
        msg('400', `.history\n---\nfirst: ${discordUrl(CH1_ID, '100')}\nlast: ${discordUrl(CH1_ID, '200')}`),
        msg('500', 'after'),
        msg('600', 'trigger'),
      ],
    })

    const result = await fetchChannelMessages(ch, '600', undefined, 100, [], false, deps)
    // Range fetches msg 100-200 from same channel, then messages after .history (500, 600)
    expect(result.didClear).toBe(true)
    expect(result.messages.map(m => m.id)).toEqual(['100', '200', '500', '600'])
  })
})
