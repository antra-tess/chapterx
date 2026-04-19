/**
 * Tests for event-driven pin tracking in DiscordConnector.
 *
 * These test the live pin map that replaced the old fetchPinned-based caches.
 * We instantiate a real DiscordConnector (its Client is just an EventEmitter
 * internally, no network calls until .login()) and drive gateway events via
 * `client.emit(...)`. Private state and helpers are accessed via `as any`.
 *
 * Run with: npm test -- connector.pin-tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Message } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

// ────────────────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────────────────

const CH = '100000000000000001'
const USER = '700000000000000001'
const BOT = '700000000000000099'

type Harness = {
  connector: DiscordConnector
  client: any  // connector.client is private; raw EventEmitter-shaped object here
  pins: () => Map<string, any> | undefined
  cleanup: () => void
}

function fakeMsg(opts: {
  id: string
  content: string
  pinned: boolean
  channelId?: string
  authorId?: string
  authorBot?: boolean
  partial?: boolean
}): Message {
  return {
    id: opts.id,
    content: opts.content,
    pinned: opts.pinned,
    channelId: opts.channelId ?? CH,
    guildId: 'guild-1',
    partial: opts.partial ?? false,
    author: {
      id: opts.authorId ?? USER,
      bot: opts.authorBot ?? false,
      username: 'user',
    },
  } as unknown as Message
}

function makeHarness(): Harness {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-pin-test-'))
  const queue = new EventQueue()
  const connector = new DiscordConnector(queue, {
    token: 'fake',
    cacheDir: tmpCache,
    maxBackoffMs: 1000,
  })
  const client = (connector as any).client

  return {
    connector,
    client,
    pins: () => (connector as any).pinnedByChannel.get(CH),
    cleanup: () => rmSync(tmpCache, { recursive: true, force: true }),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Event → state mutations
// ────────────────────────────────────────────────────────────────────────────

describe('pin tracking: messageCreate', () => {
  let h: Harness
  beforeEach(() => { h = makeHarness() })
  afterEach(() => h.cleanup())

  it('inserts into map when message arrives pre-pinned', () => {
    h.client.emit('messageCreate', fakeMsg({ id: '1', content: '.config\n---\nfoo: bar', pinned: true }))
    const pins = h.pins()
    expect(pins?.size).toBe(1)
    expect(pins?.get('1')?.content).toBe('.config\n---\nfoo: bar')
  })

  it('does not track an unpinned new message', () => {
    h.client.emit('messageCreate', fakeMsg({ id: '1', content: 'hello', pinned: false }))
    expect(h.pins()?.size ?? 0).toBe(0)
  })
})

describe('pin tracking: messageUpdate', () => {
  let h: Harness
  beforeEach(() => { h = makeHarness() })
  afterEach(() => h.cleanup())

  it('inserts when pin flips false → true', () => {
    const oldMsg = fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: false })
    const newMsg = fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: true })
    h.client.emit('messageUpdate', oldMsg, newMsg)
    expect(h.pins()?.size).toBe(1)
    expect(h.pins()?.get('1')?.content).toBe('.config\n---\na: 1')
  })

  it('removes when pin flips true → false', () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: 'x', pinned: false }), fakeMsg({ id: '1', content: 'x', pinned: true }))
    expect(h.pins()?.size).toBe(1)
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: 'x', pinned: true }), fakeMsg({ id: '1', content: 'x', pinned: false }))
    expect(h.pins()?.has('1')).toBe(false)
  })

  it('updates existing entry on content edit while still pinned', () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: 'old', pinned: false }), fakeMsg({ id: '1', content: 'old', pinned: true }))
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: 'old', pinned: true }), fakeMsg({ id: '1', content: 'new', pinned: true }))
    expect(h.pins()?.get('1')?.content).toBe('new')
  })

  it('inserts with only newMsg when oldMsg is partial (uncached old pin flip)', () => {
    const oldMsg = { id: '1', partial: true, content: undefined, pinned: undefined } as unknown as Message
    const newMsg = fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: true })
    h.client.emit('messageUpdate', oldMsg, newMsg)
    expect(h.pins()?.get('1')?.content).toBe('.config\n---\na: 1')
  })

  it('non-pin edit on unpinned message does not leak into map', () => {
    const oldMsg = fakeMsg({ id: '1', content: 'hi', pinned: false })
    const newMsg = fakeMsg({ id: '1', content: 'hello', pinned: false })
    h.client.emit('messageUpdate', oldMsg, newMsg)
    expect(h.pins()?.size ?? 0).toBe(0)
  })
})

describe('pin tracking: messageDelete', () => {
  let h: Harness
  beforeEach(() => { h = makeHarness() })
  afterEach(() => h.cleanup())

  it('drops the id from the map', () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: 'x', pinned: false }), fakeMsg({ id: '1', content: 'x', pinned: true }))
    expect(h.pins()?.size).toBe(1)
    h.client.emit('messageDelete', fakeMsg({ id: '1', content: 'x', pinned: true }))
    expect(h.pins()?.has('1')).toBe(false)
  })

  it('is a no-op for an unknown id', () => {
    h.client.emit('messageDelete', fakeMsg({ id: 'never-pinned', content: 'x', pinned: false }))
    expect(h.pins()?.size ?? 0).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Read path: fetchPinnedConfigs / fetchPinnedSteerMessages
// ────────────────────────────────────────────────────────────────────────────

describe('fetchPinnedConfigs', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
    // Stub bootstrap so cold-path tests don't hit network
    ;(h.connector as any).bootstrapChannelPins = vi.fn(async () => {
      (h.connector as any).pinnedByChannel.set(CH, new Map())
    })
  })
  afterEach(() => h.cleanup())

  it('returns only .config entries, parsed via extractConfigs', async () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: 'hello', pinned: false }), fakeMsg({ id: '1', content: 'hello', pinned: true }))
    h.client.emit('messageUpdate', fakeMsg({ id: '2', content: '.config\n---\na: 1', pinned: false }), fakeMsg({ id: '2', content: '.config\n---\na: 1', pinned: true }))
    h.client.emit('messageUpdate', fakeMsg({ id: '3', content: '.steer foo', pinned: false }), fakeMsg({ id: '3', content: '.steer foo', pinned: true }))
    const configs = await h.connector.fetchPinnedConfigs(CH)
    expect(configs).toEqual(['a: 1'])
  })

  it('preserves .config target parsing (".config foo" → "target: foo\\n...")', async () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: '.config botA\n---\nx: 1', pinned: false }), fakeMsg({ id: '1', content: '.config botA\n---\nx: 1', pinned: true }))
    const configs = await h.connector.fetchPinnedConfigs(CH)
    expect(configs).toEqual(['target: botA\nx: 1'])
  })

  it('sorts by message id (ascending) so later pins override earlier', async () => {
    // Insert out of order
    h.client.emit('messageUpdate', fakeMsg({ id: '2', content: '.config\n---\nb: 2', pinned: false }), fakeMsg({ id: '2', content: '.config\n---\nb: 2', pinned: true }))
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: false }), fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: true }))
    const configs = await h.connector.fetchPinnedConfigs(CH)
    expect(configs).toEqual(['a: 1', 'b: 2'])
  })

  it('triggers bootstrap on cold miss', async () => {
    const spy = (h.connector as any).bootstrapChannelPins as ReturnType<typeof vi.fn>
    await h.connector.fetchPinnedConfigs('unknown-channel-id')
    expect(spy).toHaveBeenCalledWith('unknown-channel-id')
  })

  it('does not trigger bootstrap on warm hit', async () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: false }), fakeMsg({ id: '1', content: '.config\n---\na: 1', pinned: true }))
    const spy = (h.connector as any).bootstrapChannelPins as ReturnType<typeof vi.fn>
    spy.mockClear()
    await h.connector.fetchPinnedConfigs(CH)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('fetchPinnedSteerMessages', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
    ;(h.connector as any).bootstrapChannelPins = vi.fn(async () => {
      (h.connector as any).pinnedByChannel.set(CH, new Map())
    })
  })
  afterEach(() => h.cleanup())

  it('returns only non-bot-authored .steer entries', async () => {
    h.client.emit('messageUpdate', fakeMsg({ id: '1', content: '.steer human', pinned: false, authorId: USER, authorBot: false }), fakeMsg({ id: '1', content: '.steer human', pinned: true, authorId: USER, authorBot: false }))
    h.client.emit('messageUpdate', fakeMsg({ id: '2', content: '.steer bot', pinned: false, authorId: BOT, authorBot: true }), fakeMsg({ id: '2', content: '.steer bot', pinned: true, authorId: BOT, authorBot: true }))
    h.client.emit('messageUpdate', fakeMsg({ id: '3', content: '.config\n---\na: 1', pinned: false }), fakeMsg({ id: '3', content: '.config\n---\na: 1', pinned: true }))
    const steers = await h.connector.fetchPinnedSteerMessages(CH)
    expect(steers).toEqual([{ content: '.steer human', authorId: USER }])
  })
})
