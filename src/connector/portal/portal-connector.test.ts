/**
 * PortalConnector against a fake portal client: what the agent loop, the API
 * server and sleep get from each IConnector method on the portal backend.
 *
 * The fake stands in for PortalClient's RPCs, so these tests check the
 * connector's own logic (splitting, pin caching, the reply-chain walk, member
 * lookups), not the relay.
 *
 * Run with: npm test -- portal-connector
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PortalConnector } from './portal-connector.js'
import { EventQueue } from '../../agent/event-queue.js'

const CH = 'chan-1'

interface Sent {
  channelId: string
  content?: string
  replyToId?: string
}

function makeHarness() {
  const tmpCache = mkdtempSync(join(tmpdir(), 'portal-connector-test-'))
  const connector = new PortalConnector(new EventQueue(), {
    url: 'ws://relay.invalid',
    token: 'token',
    personaId: 'persona-p',
    cacheDir: tmpCache,
  })
  const sent: Sent[] = []
  let nextId = 1
  const client = {
    sendMessage: vi.fn(async (p: Sent) => {
      sent.push({ channelId: p.channelId, content: p.content, replyToId: p.replyToId })
      return { messageId: `rm_${p.channelId}_${nextId++}` }
    }),
    fetchHistory: vi.fn(async () => ({ messages: [] as unknown[] })),
    call: vi.fn(async () => ({})),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
    close: vi.fn(),
    cache: {
      getChannel: () => undefined,
      allChannels: () => [],
      allGuilds: () => [],
      persona: { displayName: 'p' },
    },
  }
  ;(connector as any).client = client
  return {
    connector,
    client,
    sent,
    cleanup: () => rmSync(tmpCache, { recursive: true, force: true }),
  }
}

const fenceMarkers = (s: string) => (s.match(/```/g) ?? []).length

/** A portal message in channel CH with the given snowflake, author and reply. */
function msg(n: number, author: 'human' | 'bot-a' | 'persona', replyTo?: number) {
  const a =
    author === 'human'
      ? { kind: 'user', userId: 'h1', username: 'h', displayName: 'H', bot: false }
      : author === 'bot-a'
        ? { kind: 'user', userId: 'a1', username: 'a', displayName: 'A', bot: true }
        : { kind: 'persona', personaId: 'persona-p', displayName: 'p', avatarUrl: '' }
  return {
    id: `rm_${CH}_${n}`,
    nativeId: String(n),
    channelId: CH,
    guildId: 'g',
    author: a,
    content: 'x',
    cleanContent: 'x',
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    replyToId: replyTo === undefined ? undefined : `rm_${CH}_${replyTo}`,
    createdAt: new Date(0).toISOString(),
  }
}

/** fetch_history over `all`: the `limit` messages older than `before` (by
 *  snowflake), oldest first, so the connector can't lean on the order. */
function historyOf(all: ReturnType<typeof msg>[]) {
  return async ({ before, limit }: { before?: string; limit: number }) => {
    const older = all
      .filter((m) => before === undefined || BigInt(m.nativeId) < BigInt(before))
      .sort((x, y) => (BigInt(y.nativeId) > BigInt(x.nativeId) ? 1 : -1))
      .slice(0, limit)
    return { messages: older.reverse() }
  }
}

/** The inbound object the loop hands getBotReplyChainDepth for message `m`. */
function inbound(m: ReturnType<typeof msg>) {
  const human = m.author.kind === 'user' && !(m.author as { bot: boolean }).bot
  const id = m.author.kind === 'persona' ? 'persona-p' : (m.author as { userId: string }).userId
  return { id: m.id, author: { id, bot: !human }, reference: m.replyToId ? { messageId: m.replyToId } : undefined }
}

describe('PortalConnector.getBotReplyChainDepth', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  it('scores a human\'s reply 0 without fetching anything', async () => {
    h = makeHarness()
    const all = [msg(1, 'human'), msg(2, 'bot-a', 1), msg(3, 'persona', 2)]
    h.client.fetchHistory.mockImplementation(historyOf(all) as any)

    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(4, 'human', 3)))).toBe(0)
    expect(h.client.fetchHistory).not.toHaveBeenCalled()
  })

  it('counts a bot\'s reply and each bot turn above it, as the Discord walker does', async () => {
    h = makeHarness()
    const all = [msg(1, 'human'), msg(2, 'bot-a', 1), msg(3, 'persona', 2)]
    h.client.fetchHistory.mockImplementation(historyOf(all) as any)

    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(4, 'bot-a', 3)))).toBe(3)
  })

  it('pages back past the latest 100 messages for an older link', async () => {
    h = makeHarness()
    const filler = Array.from({ length: 150 }, (_, i) => msg(100 + i, 'human'))
    const all = [msg(1, 'human'), msg(2, 'bot-a', 1), msg(3, 'persona', 2), ...filler]
    h.client.fetchHistory.mockImplementation(historyOf(all) as any)

    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(300, 'bot-a', 3)))).toBe(3)
    expect(h.client.fetchHistory).toHaveBeenCalledTimes(2)
    expect((h.client.fetchHistory.mock.calls[1] as any)[0].before).toBe('150')
  })

  it('stops paging after five pages and ends the walk there', async () => {
    h = makeHarness()
    const filler = Array.from({ length: 600 }, (_, i) => msg(1000 + i, 'human'))
    const all = [msg(1, 'human'), msg(2, 'persona', 1), ...filler]
    h.client.fetchHistory.mockImplementation(historyOf(all) as any)

    // Found, the persona's message would make it 2; five pages end the walk at 1.
    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(5000, 'bot-a', 2)))).toBe(1)
    expect(h.client.fetchHistory).toHaveBeenCalledTimes(5)
  })
})

describe('PortalConnector sending', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  it('keeps a long code block a code block in every message, as the Discord path does', async () => {
    h = makeHarness()
    const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i} // padding text`).join('\n')
    await h.connector.sendMessage(CH, 'Here is the file:\n\n```ts\n' + code + '\n```\n\nThat is all.')

    expect(h.sent.length).toBeGreaterThan(1)
    for (const m of h.sent) expect(fenceMarkers(m.content!) % 2).toBe(0)
    expect(h.sent[1]!.content!.startsWith('```ts')).toBe(true)
  })

  it('replies to the trigger from the first chunk only', async () => {
    h = makeHarness()
    await h.connector.sendMessage(CH, 'x'.repeat(4000), 'rm_chan-1_99')

    expect(h.sent.length).toBeGreaterThan(1)
    expect(h.sent[0]!.replyToId).toBe('rm_chan-1_99')
    for (const m of h.sent.slice(1)) expect(m.replyToId).toBeUndefined()
  })

  it('rewrites <@name> mentions to @name before splitting', async () => {
    h = makeHarness()
    await h.connector.sendMessage(CH, 'hello <@alice> and <@!bob>, not <@123456>')

    expect(h.sent[0]!.content).toBe('hello @alice and @bob, not <@123456>')
  })

  it('sendSegmentChunks returns each message with its bridges and the carry after the last', async () => {
    h = makeHarness()
    const code = Array.from({ length: 120 }, (_, i) => `line ${i} of the block`).join('\n')
    const { chunks, endCarry } = await h.connector.sendSegmentChunks(CH, '```\n' + code, 'rm_chan-1_7', [])

    expect(chunks.length).toBe(h.sent.length)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.id)).toEqual(h.sent.map((_, i) => `rm_${CH}_${i + 1}`))
    expect(chunks[0]!.bridgeClose).toBeTruthy()
    expect(chunks[1]!.bridgeOpen).toBeTruthy()
    expect(endCarry.length).toBe(1) // the fence is still open after the last message
    expect(h.sent[0]!.replyToId).toBe('rm_chan-1_7')
    expect(h.sent[1]!.replyToId).toBeUndefined()
  })

  it('sendSegmentChunks continues a construct inherited from an earlier send', async () => {
    h = makeHarness()
    const first = await h.connector.sendSegmentChunks(CH, '```\nopen block', undefined, [])
    const second = await h.connector.sendSegmentChunks(CH, 'still code\n```\nafter', undefined, first.endCarry)

    expect(second.chunks[0]!.bridgeOpen).toBeTruthy()
    expect(h.sent[h.sent.length - 1]!.content!.startsWith('```')).toBe(true)
    expect(second.endCarry).toEqual([])
  })
})
