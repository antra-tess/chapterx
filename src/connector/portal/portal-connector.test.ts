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
import { logger } from '../../utils/logger.js'

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
  const handlers = new Map<string, Array<(arg: unknown) => void>>()
  const client = {
    on: vi.fn((name: string, fn: (arg: unknown) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn])
    }),
    connect: vi.fn(async () => undefined),
    /** Fire a client event, as PortalClient's emitter would. */
    emit: (name: string, arg?: unknown) => {
      for (const fn of handlers.get(name) ?? []) fn(arg)
    },
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

  it('a failed fetch ends the walk where it is, as on the Discord backend', async () => {
    h = makeHarness()
    h.client.fetchHistory.mockRejectedValue(new Error('relay timeout') as never)

    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(5, 'bot-a', 4)))).toBe(1)
    expect(h.client.fetchHistory).toHaveBeenCalledTimes(1)
  })

  it('ends the walk when the channel\'s history runs out, without paging on', async () => {
    h = makeHarness()
    h.client.fetchHistory.mockImplementation(historyOf(Array.from({ length: 30 }, (_, i) => msg(i + 1, 'human'))) as any)

    // The link is to a message the channel no longer has.
    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(40, 'bot-a', 35)))).toBe(1)
    expect(h.client.fetchHistory).toHaveBeenCalledTimes(2) // a page, then an empty one
  })

  it('stops at a relay system notice, as the Discord walk stops at a message no bot wrote', async () => {
    h = makeHarness()
    const notice = { ...msg(2, 'human', 1), author: { kind: 'system' } }
    const all = [msg(1, 'bot-a'), notice, msg(3, 'persona', 2)]
    h.client.fetchHistory.mockImplementation(historyOf(all as any) as any)

    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(4, 'bot-a', 3)))).toBe(2)
  })

  it('stops paging after five pages and ends the walk there', async () => {
    h = makeHarness()
    const filler = Array.from({ length: 600 }, (_, i) => msg(1000 + i, 'human'))
    const all = [msg(1, 'human'), msg(2, 'persona', 1), ...filler]
    h.client.fetchHistory.mockImplementation(historyOf(all) as any)

    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never)

    // Found, the persona's message would make it 2; five pages end the walk at 1.
    expect(await h.connector.getBotReplyChainDepth(CH, inbound(msg(5000, 'bot-a', 2)))).toBe(1)
    expect(h.client.fetchHistory).toHaveBeenCalledTimes(5)
    expect(debug).toHaveBeenCalledWith({ channelId: CH, pages: 5 }, 'portal: reply-chain walk ended at its page bound')
    debug.mockRestore()
  })
})

/** A pinned message as list_pins returns it. */
function pinned(n: number, content: string) {
  return { ...msg(n, 'human'), content, cleanContent: content }
}

describe('PortalConnector pins', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  it('pinMessage refuses, so a tool that pins to take effect reports that it didn\'t', async () => {
    h = makeHarness()
    await expect(h.connector.pinMessage(CH, 'rm_chan-1_5')).rejects.toThrow(/portal backend/)
  })

  it('a failed list_pins caches nothing, and the next read asks again', async () => {
    h = makeHarness()
    h.client.call.mockRejectedValueOnce(new Error('relay down') as never)
    h.client.call.mockResolvedValueOnce({ messages: [pinned(10, '.config\n---\nmood: calm')] } as never)

    expect(await h.connector.fetchPinnedConfigs(CH)).toEqual([])
    expect(h.connector.getCachedPinnedConfigs(CH)).toBeNull()
    expect(await h.connector.fetchPinnedConfigs(CH)).toEqual(['mood: calm'])
    expect(h.client.call).toHaveBeenCalledTimes(2)
  })

  it('a refresh asked for during a load loads once more, and a reader waiting on it gets the newest pins', async () => {
    h = makeHarness()
    const replies: Array<(v: unknown) => void> = []
    h.client.call.mockImplementation((() => new Promise((res) => replies.push(res))) as never)
    await h.connector.start()
    const tick = () => new Promise((r) => setTimeout(r, 0))

    const read = h.connector.fetchPinnedConfigs(CH) // a cache miss starts a load
    h.client.emit('event', { type: 'pins_update', channelId: CH }) // a pin changes meanwhile
    expect(h.client.call).toHaveBeenCalledTimes(1) // one request at a time per channel

    replies[0]!({ messages: [pinned(10, '.config\n---\nmood: older')] })
    await tick()
    expect(h.client.call).toHaveBeenCalledTimes(2) // the load asks again for the change
    replies[1]!({ messages: [pinned(20, '.config\n---\nmood: newer')] })

    expect(await read).toEqual(['mood: newer'])
    expect(h.connector.getCachedPinnedConfigs(CH)).toEqual(['mood: newer'])
  })

  it('a pins_update inside a thread refreshes the thread\'s pins', async () => {
    h = makeHarness()
    h.client.call.mockResolvedValue({ messages: [pinned(30, '.steer be brief')] } as never)
    await h.connector.start()

    h.client.emit('event', { type: 'pins_update', channelId: 'parent', threadId: 'thread-1' })
    await new Promise((r) => setTimeout(r, 0))

    expect((h.client.call.mock.calls[0] as any)[1]).toEqual({ channelId: 'thread-1' })
    expect(h.connector.getCachedPinnedSteers('thread-1')).toHaveLength(1)
    expect(h.connector.getCachedPinnedSteers('parent')).toBeNull()
  })

  it('a reader waits for a refresh in progress rather than answering from the cache', async () => {
    h = makeHarness()
    const replies: Array<(v: unknown) => void> = []
    h.client.call.mockImplementation((() => new Promise((res) => replies.push(res))) as never)
    await h.connector.start()
    const first = h.connector.fetchPinnedSteerMessages(CH)
    replies[0]!({ messages: [] })
    await first

    h.client.emit('event', { type: 'pins_update', channelId: CH }) // a .steer was just pinned
    const read = h.connector.fetchPinnedSteerMessages(CH)
    replies[1]!({ messages: [pinned(30, '.steer be brief')] })

    expect(await read).toHaveLength(1)
  })

  it('a failed refresh leaves the old pins for the gate, and the next read asks again', async () => {
    h = makeHarness()
    h.client.call.mockResolvedValueOnce({ messages: [pinned(40, '.sleep')] } as never)
    h.client.call.mockRejectedValueOnce(new Error('relay down') as never)
    h.client.call.mockResolvedValueOnce({ messages: [] } as never)
    await h.connector.start()
    await h.connector.fetchPinnedSleeps(CH)

    h.client.emit('event', { type: 'pins_update', channelId: CH }) // the .sleep was unpinned
    await new Promise((r) => setTimeout(r, 0))
    expect(h.connector.getCachedPinnedSleeps(CH)).toHaveLength(1)

    expect(await h.connector.fetchPinnedSleeps(CH)).toEqual([])
    expect(h.client.call).toHaveBeenCalledTimes(3)
  })

  it('a resume neither drops nor reloads the pin cache', async () => {
    h = makeHarness()
    h.client.call.mockResolvedValue({ messages: [pinned(40, '.sleep')] } as never)
    await h.connector.start()
    await h.connector.fetchPinnedSleeps(CH)

    h.client.emit('resumed', 3)
    await h.connector.fetchPinnedSleeps(CH)

    expect(h.client.call).toHaveBeenCalledTimes(1)
    expect(h.connector.getCachedPinnedSleeps(CH)).toHaveLength(1)
  })

  it('a load in flight across a fresh ready asks again once its request fails', async () => {
    h = makeHarness()
    const replies: Array<{ res: (v: unknown) => void; rej: (e: Error) => void }> = []
    h.client.call.mockImplementation((() => new Promise((res, rej) => replies.push({ res, rej }))) as never)
    await h.connector.start()
    const cold = h.connector.fetchPinnedSleeps(CH) // a load starts, and its request is lost with the connection
    h.client.emit('ready', {})

    replies[0]!.rej(new Error('RPC list_pins timed out'))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.client.call).toHaveBeenCalledTimes(2)
    replies[1]!.res({ messages: [pinned(40, '.sleep')] })

    expect(await cold).toHaveLength(1)
  })
})

describe('PortalConnector events wait for their channel\'s pins', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  const message = (n: number) => ({ type: 'message_create', message: msg(n, 'human'), addressedToMe: false, reasons: ['subscription'] })

  /** The connector's queue, recording each event with the sleep pins the loop
   *  would read for its channel at the moment it arrives. */
  function watchQueue() {
    const queued: Array<{ id: string; sleeps: number | null }> = []
    vi.spyOn((h.connector as any).queue, 'push').mockImplementation(((ev: { channelId: string; data: { id: string } }) => {
      queued.push({ id: ev.data.id, sleeps: h.connector.getCachedPinnedSleeps(ev.channelId)?.length ?? null })
    }) as never)
    return queued
  }

  it('a channel\'s first events wait, in order, for its pins, and later ones ask for nothing', async () => {
    h = makeHarness()
    const replies: Array<(v: unknown) => void> = []
    h.client.call.mockImplementation((() => new Promise((res) => replies.push(res))) as never)
    const queued = watchQueue()
    await h.connector.start()

    h.client.emit('event', message(5))
    h.client.emit('event', message(6))
    expect(queued).toEqual([])
    expect(h.client.call).toHaveBeenCalledTimes(1)
    expect((h.client.call.mock.calls[0] as any)[1]).toEqual({ channelId: CH })

    replies[0]!({ messages: [pinned(40, '.sleep')] })
    await new Promise((r) => setTimeout(r, 0))
    expect(queued).toEqual([
      { id: `rm_${CH}_5`, sleeps: 1 },
      { id: `rm_${CH}_6`, sleeps: 1 },
    ])

    h.client.emit('event', message(7))
    expect(queued[2]).toEqual({ id: `rm_${CH}_7`, sleeps: 1 })
    expect(h.client.call).toHaveBeenCalledTimes(1)
  })

  it('when the first load fails, the events go on and later ones don\'t wait, but a read asks again', async () => {
    h = makeHarness()
    h.client.call.mockRejectedValueOnce(new Error('relay down') as never)
    h.client.call.mockResolvedValueOnce({ messages: [pinned(40, '.sleep')] } as never)
    const queued = watchQueue()
    await h.connector.start()

    h.client.emit('event', message(5))
    await new Promise((r) => setTimeout(r, 0))
    h.client.emit('event', message(6))

    expect(queued).toEqual([
      { id: `rm_${CH}_5`, sleeps: null },
      { id: `rm_${CH}_6`, sleeps: null },
    ])
    expect(h.client.call).toHaveBeenCalledTimes(1)
    expect(await h.connector.fetchPinnedSleeps(CH)).toHaveLength(1)
    expect(h.client.call).toHaveBeenCalledTimes(2)
  })

  it('an event after a pins_update waits for the pins it announced', async () => {
    h = makeHarness()
    const replies: Array<(v: unknown) => void> = []
    h.client.call.mockImplementation((() => new Promise((res) => replies.push(res))) as never)
    const queued = watchQueue()
    await h.connector.start()
    h.client.emit('event', message(5))
    replies[0]!({ messages: [] })
    await new Promise((r) => setTimeout(r, 0))

    h.client.emit('event', { type: 'pins_update', channelId: CH }) // a .sleep was just pinned
    h.client.emit('event', message(6))
    expect(queued).toHaveLength(1)
    replies[1]!({ messages: [pinned(40, '.sleep')] })
    await new Promise((r) => setTimeout(r, 0))

    expect(queued[1]).toEqual({ id: `rm_${CH}_6`, sleeps: 1 })
  })

  it('a fresh ready asks for nothing at once, and a channel\'s next event waits for its pins again', async () => {
    // A pins_update lost in the gap: the .sleep was unpinned while the session was down.
    h = makeHarness()
    const replies: Array<(v: unknown) => void> = []
    h.client.call.mockImplementation((() => new Promise((res) => replies.push(res))) as never)
    const queued = watchQueue()
    await h.connector.start()
    h.client.emit('event', message(5))
    replies[0]!({ messages: [pinned(40, '.sleep')] })
    await new Promise((r) => setTimeout(r, 0))

    h.client.emit('ready', {})
    expect(h.client.call).toHaveBeenCalledTimes(1)
    expect(h.connector.getCachedPinnedSleeps(CH)).toHaveLength(1) // the old pins, until the channel's next event

    h.client.emit('event', message(6))
    expect(h.client.call).toHaveBeenCalledTimes(2)
    replies[1]!({ messages: [] })
    await new Promise((r) => setTimeout(r, 0))
    expect(queued[1]).toEqual({ id: `rm_${CH}_6`, sleeps: 0 })
  })
})

describe('PortalConnector message bookkeeping', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  it('a reaction on the persona\'s own sent message carries the persona as its author', async () => {
    h = makeHarness()
    await h.connector.start()
    const [id] = await h.connector.sendMessage(CH, 'hello')
    const pushed: any[] = []
    vi.spyOn((h.connector as any).queue, 'push').mockImplementation((e: any) => { pushed.push(e) })

    h.client.call.mockResolvedValue({ messages: [] } as never) // the channel has no pins
    h.client.emit('event', {
      type: 'reaction_add',
      channelId: CH,
      messageId: id,
      reaction: { emoji: '⏩', count: 1, kind: 'native', by: [{ kind: 'user', id: 'h1', name: 'h' }] },
    })
    await new Promise((r) => setTimeout(r, 0)) // the channel's first event waits for its pins

    expect(pushed[0].data.messageAuthorId).toBe('persona-p')
  })

  it('a delete of a message seen only in fetched history carries its author', async () => {
    h = makeHarness()
    await h.connector.start()
    h.client.fetchHistory.mockImplementation(historyOf([msg(7, 'bot-a')]) as any)
    await h.connector.fetchContext({ channelId: CH, depth: 5 })
    const pushed: any[] = []
    vi.spyOn((h.connector as any).queue, 'push').mockImplementation((e: any) => { pushed.push(e) })

    h.client.call.mockResolvedValue({ messages: [] } as never) // the channel has no pins
    h.client.emit('event', { type: 'message_delete', channelId: CH, messageId: `rm_${CH}_7` })
    await new Promise((r) => setTimeout(r, 0)) // the channel's first event waits for its pins

    expect(pushed[0].data.author.id).toBe('a1')
  })

  it('remembers at most 50,000 messages, forgetting the one seen longest ago first', () => {
    h = makeHarness()
    const remember = (id: string, n: number) => (h.connector as any).remember(id, { authorId: 'u', nativeId: String(n) })
    const seen = (h.connector as any).seen as Map<string, unknown>
    for (let n = 0; n <= 50_000; n++) remember(`rm_${n}`, n)

    expect(seen.size).toBe(50_000)
    expect(seen.has('rm_0')).toBe(false)

    remember('rm_1', 1) // seen again: now the newest
    remember('rm_new', 50_001)
    expect(seen.has('rm_1')).toBe(true)
    expect(seen.has('rm_2')).toBe(false)
  })

  it('looks an id up in what it has seen before taking an all-digit id as a snowflake', () => {
    h = makeHarness()
    ;(h.connector as any).remember('12345', { authorId: 'u', nativeId: '999' })
    ;(h.connector as any).remember('55555', { authorId: 'persona-p' }) // a send of its own: no snowflake
    const snowflakeOf = (id: string) => (h.connector as any).snowflakeOf(id)

    expect(snowflakeOf('12345')).toBe('999') // an all-digit relay id it has seen
    expect(snowflakeOf('55555')).toBeUndefined() // seen, with no snowflake known
    expect(snowflakeOf('777')).toBe('777') // an all-digit id it hasn't: a snowflake from a URL
    expect(snowflakeOf('rm_chan-1_1')).toBeUndefined()
  })

  it('gives a reply no target snowflake for a relay id it never saw, whatever the id\'s form', async () => {
    h = makeHarness()
    const reply = { ...msg(20, 'human'), replyToId: '987654321' } // an all-digit relay id
    h.client.fetchHistory.mockImplementation(historyOf([msg(19, 'human'), reply]) as any)

    const ctx = await h.connector.fetchContext({ channelId: CH, depth: 5 })
    const out = ctx.messages.find((m) => m.id === `rm_${CH}_20`)!

    expect(out.referencedMessage).toBe('987654321')
    expect(out.referencedNativeId).toBeUndefined()
  })

  it('a deleted message is forgotten, so a context anchor it was isn\'t extended to', async () => {
    h = makeHarness()
    let all = Array.from({ length: 30 }, (_, i) => msg(i + 1, 'human'))
    h.client.fetchHistory.mockImplementation(((p: { before?: string; limit: number }) => historyOf(all)(p)) as any)
    await h.connector.start()
    await h.connector.fetchContext({ channelId: CH, depth: 20 }) // the connector sees message 15

    all = all.filter((m) => m.nativeId !== '15')
    h.client.emit('event', { type: 'message_delete', channelId: CH, messageId: `rm_${CH}_15` })
    const ctx = await h.connector.fetchContext({ channelId: CH, depth: 10, firstMessageId: `rm_${CH}_15` })

    // Remembered, the anchor would be extended to through everything older, and never found.
    expect(ctx.messages[0]!.id).toBe(`rm_${CH}_21`)
  })

  it('findAndEditBotMessage edits the newest matching message, whatever order history comes in', async () => {
    h = makeHarness()
    const mine = (n: number) => ({ ...msg(n, 'persona'), content: 'Status: old', cleanContent: 'Status: old' })
    h.client.fetchHistory.mockImplementation(historyOf([mine(1), mine(2), mine(3)]) as any)

    expect(await h.connector.findAndEditBotMessage(CH, 'Status:', 'Status: <@alice> done')).toBe(true)
    expect(h.client.editMessage).toHaveBeenCalledWith(`rm_${CH}_3`, 'Status: @alice done')
  })

  it('the attachment sends rewrite <@name> mentions in their text as sendMessage does', async () => {
    h = makeHarness()
    await h.connector.sendMessageWithAttachment(CH, 'for <@alice>', { name: 'a.txt', content: 'x' })
    await h.connector.sendImageAttachment(CH, 'aGk=', 'image/png', 'look, <@bob>')
    await h.connector.sendFileAttachment(CH, Buffer.from('x'), 'f.bin', 'application/octet-stream', 'from <@carol>')

    expect(h.sent.map((m) => m.content)).toEqual(['for @alice', 'look, @bob', 'from @carol'])
  })

  it('editMessage rewrites <@name> mentions as sendMessage does', async () => {
    h = makeHarness()
    await h.connector.editMessage(CH, `rm_${CH}_9`, 'thanks <@bob>')
    expect(h.client.editMessage).toHaveBeenCalledWith(`rm_${CH}_9`, 'thanks @bob')
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

describe('PortalConnector.fetchContext when the relay fails', () => {
  it('a failed fetch_history gives a shorter context, as on the Discord backend, instead of failing it', async () => {
    const h = makeHarness()
    try {
      h.client.fetchHistory.mockRejectedValue(new Error('relay timeout') as never)
      const ctx = await h.connector.fetchContext({ channelId: CH, depth: 10 })
      expect(ctx.messages).toEqual([])
    } finally {
      h.cleanup()
    }
  })
})

describe('PortalConnector member roles, reactions and typing', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => { h?.cleanup(); vi.restoreAllMocks() })

  it('reads a member\'s roles from a partial roster when the member is in it', async () => {
    h = makeHarness()
    h.client.call.mockImplementation((async (method: string) =>
      method === 'list_members'
        ? { members: [{ userId: 'u1', roles: ['r1'] }], membersAvailable: false }
        : { roles: [{ id: 'r1', name: 'mod' }] }) as never)

    expect(await h.connector.fetchMemberRoles('u1', 'g')).toEqual(['mod'])
  })

  it('logs why a member\'s roles are unverified when the member isn\'t listed', async () => {
    h = makeHarness()
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    h.client.call.mockResolvedValue({ members: [{ userId: 'u1', roles: [] }], membersAvailable: false } as never)

    expect(await h.connector.fetchMemberRoles('u9', 'g')).toBeNull()
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9', membersAvailable: false }), expect.stringContaining('partial roster'))
  })

  it('logs why a member\'s roles are unverified when a complete roster doesn\'t list them', async () => {
    h = makeHarness()
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    h.client.call.mockResolvedValue({ members: [{ userId: 'u1', roles: [] }], membersAvailable: true } as never)

    expect(await h.connector.fetchMemberRoles('u9', 'g')).toBeNull()
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u9', membersAvailable: true }),
      expect.stringContaining('not among those list_members returned'),
    )
  })

  it('reactToLatestMessage keeps a relay error to itself, as the Discord backend\'s does', async () => {
    h = makeHarness()
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    h.client.fetchHistory.mockRejectedValue(new Error('relay down') as never)

    await expect(h.connector.reactToLatestMessage(CH, '🚫')).resolves.toBeUndefined()
  })

  it('a failed set_typing is logged, not thrown', async () => {
    h = makeHarness()
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never)
    h.client.call.mockRejectedValue(new Error('relay down') as never)

    await h.connector.startTyping(CH)
    await new Promise((r) => setTimeout(r, 0))
    await h.connector.stopTyping(CH)

    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ channelId: CH }), 'portal: set_typing failed')
  })
})

describe('PortalConnector.fetchContext with a target message', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  it('ends the context at a target given as a snowflake, fetching it as the one message before the next snowflake', async () => {
    h = makeHarness()
    h.client.fetchHistory.mockImplementation(historyOf(Array.from({ length: 20 }, (_, i) => msg(i + 1, 'human'))) as any)

    const ctx = await h.connector.fetchContext({ channelId: CH, depth: 5, targetMessageId: '10' })

    expect(ctx.messages.map((m) => m.id)).toEqual([6, 7, 8, 9, 10].map((n) => `rm_${CH}_${n}`))
    expect(h.client.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({ before: '11', limit: 1 }))
  })

  it('a failed fetch of the target leaves it out instead of failing the context', async () => {
    h = makeHarness()
    const serve = historyOf(Array.from({ length: 20 }, (_, i) => msg(i + 1, 'human')))
    h.client.fetchHistory.mockImplementation((async (p: { before?: string; limit: number }) => {
      if (p.limit === 1) throw new Error('relay timeout')
      return serve(p)
    }) as any)

    const ctx = await h.connector.fetchContext({ channelId: CH, depth: 5, targetMessageId: '10' })

    expect(ctx.messages.map((m) => m.id)).toEqual([5, 6, 7, 8, 9].map((n) => `rm_${CH}_${n}`))
  })

  it('extends back to an anchor only by a snowflake it has seen, never by parsing the relay id', async () => {
    h = makeHarness()
    h.client.fetchHistory.mockImplementation(historyOf(Array.from({ length: 30 }, (_, i) => msg(i + 1, 'human'))) as any)

    // A fresh connector hasn't seen message 15, so the anchor can't be dated.
    const unseen = await h.connector.fetchContext({ channelId: CH, depth: 10, firstMessageId: `rm_${CH}_15` })
    expect(unseen.messages[0]!.id).toBe(`rm_${CH}_21`)

    // Once a fetch has seen it, the context extends back to it.
    await h.connector.fetchContext({ channelId: CH, depth: 20 })
    const seen = await h.connector.fetchContext({ channelId: CH, depth: 10, firstMessageId: `rm_${CH}_15` })
    expect(seen.messages[0]!.id).toBe(`rm_${CH}_15`)
  })

  it('takes nothing for a target the channel no longer holds, rather than the message before it', async () => {
    h = makeHarness()
    const all = Array.from({ length: 20 }, (_, i) => msg(i + 1, 'human')).filter((m) => m.nativeId !== '10')
    h.client.fetchHistory.mockImplementation(historyOf(all) as any)

    const ctx = await h.connector.fetchContext({ channelId: CH, depth: 5, targetMessageId: '10' })

    expect(ctx.messages.map((m) => m.id)).toEqual([5, 6, 7, 8, 9].map((n) => `rm_${CH}_${n}`))
  })
})
