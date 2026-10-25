/**
 * Discord's typing indicator expires after ~10s, so a stuck one means an
 * interval is still re-sending it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'
import { logger } from '../utils/logger.js'

const CH = '100000000000000001'
const REFRESH_MS = 8000

function makeHarness(opts: { fetchGate?: boolean; destroyGate?: boolean } = {}) {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-typing-test-'))
  const connector = new DiscordConnector(new EventQueue(), {
    token: 'fake',
    cacheDir: tmpCache,
    maxBackoffMs: 1000,
  })

  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const channel = { isTextBased: () => true, sendTyping }

  const held: Array<() => void> = []
  const fetch = opts.fetchGate
    ? vi.fn(() => new Promise((res) => { held.push(() => res(channel)) }))
    : vi.fn().mockResolvedValue(channel)

  let destroyHeld: (() => void) | undefined
  const destroy = opts.destroyGate
    ? () => new Promise<void>((res) => { destroyHeld = res })
    : async () => {}
  ;(connector as any).client = { channels: { fetch }, destroy }

  return {
    connector,
    sendTyping,
    fetch,
    release: () => { while (held.length > 0) held.shift()!() },
    releaseOldest: () => held.shift()?.(),
    releaseDestroy: () => destroyHeld?.(),
    intervals: () => (connector as any).typingIntervals as Map<string, unknown>,
    cleanup: () => rmSync(tmpCache, { recursive: true, force: true }),
  }
}

describe('typing indicator lifecycle', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => { h?.cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('stops refreshing after stopTyping', async () => {
    h = makeHarness()
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a second startTyping does not orphan the first interval', async () => {
    h = makeHarness()
    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a stopTyping while the first tick awaits Discord wins, rather than being overtaken', async () => {
    h = makeHarness({ fetchGate: true })
    const baseline = vi.getTimerCount()

    const starting = h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    h.release()
    await starting

    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('leaves no live timer once stopped', async () => {
    h = makeHarness()
    const baseline = vi.getTimerCount()

    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('keeps refreshing the indicator while nothing stops it', async () => {
    h = makeHarness()
    await h.connector.startTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('a start whose first tick is still awaiting its channel fetch at shutdown leaves no timer and sends nothing', async () => {
    h = makeHarness({ fetchGate: true })
    const baseline = vi.getTimerCount()

    const starting = h.connector.startTyping(CH)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.connector.close()
    await h.connector.stopTyping(CH)
    h.release()
    await starting

    expect(h.intervals().size).toBe(0)
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('does not send typing after a stop that landed mid-fetch', async () => {
    // Sending is asynchronous and cannot be un-sent, so a stop can always land
    // mid-send, leaving at most the indicators already in flight, each of which
    // Discord expires in ~10s.
    h = makeHarness({ fetchGate: true })

    await h.connector.startTyping(CH)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.connector.stopTyping(CH)
    h.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a first tick still awaiting its channel fetch when close() runs sends nothing, with no stop after the close', async () => {
    h = makeHarness({ fetchGate: true })
    const baseline = vi.getTimerCount()

    await h.connector.startTyping(CH)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.connector.close()
    h.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a replacing start while the first tick awaits its channel fetch leaves the replaced tick sending nothing', async () => {
    h = makeHarness({ fetchGate: true })

    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    expect(h.fetch).toHaveBeenCalledTimes(2)

    h.releaseOldest()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sendTyping).not.toHaveBeenCalled()

    h.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sendTyping).toHaveBeenCalledTimes(1)
    expect(h.intervals().size).toBe(1)
  })

  it('refuses a start while close() is still awaiting the client\'s destroy', async () => {
    h = makeHarness({ destroyGate: true })

    const closing = h.connector.close()
    const baseline = vi.getTimerCount()
    await h.connector.startTyping(CH)
    await vi.advanceTimersByTimeAsync(REFRESH_MS)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.fetch).not.toHaveBeenCalled()
    h.releaseDestroy()
    await closing
  })

  it('refuses a start after close(): no timer is added and nothing is sent', async () => {
    h = makeHarness()
    await h.connector.close()
    const baseline = vi.getTimerCount()

    await h.connector.startTyping(CH)
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a fetch that rejects is caught, logged, and tried again at the next refresh', async () => {
    h = makeHarness()
    h.fetch.mockRejectedValue(new Error('Discord is unavailable'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await h.connector.startTyping(CH)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: CH }), 'Failed to refresh typing')

    await vi.advanceTimersByTimeAsync(REFRESH_MS)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.intervals().size).toBe(1)
  })

  it('a sendTyping that rejects is caught, logged, and tried again at the next refresh', async () => {
    h = makeHarness()
    h.sendTyping.mockRejectedValue(new Error('Missing Permissions'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await h.connector.startTyping(CH)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sendTyping).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: CH }), 'Failed to refresh typing')

    await vi.advanceTimersByTimeAsync(REFRESH_MS)
    expect(h.sendTyping).toHaveBeenCalledTimes(2)
  })

  it('sends the first indicator at once, not at the first refresh', async () => {
    h = makeHarness()

    await h.connector.startTyping(CH)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sendTyping).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1)
    expect(h.sendTyping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sendTyping).toHaveBeenCalledTimes(2)
  })
})
