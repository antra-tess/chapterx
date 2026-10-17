/**
 * Tests for the typing indicator's lifecycle.
 *
 * WHAT THESE PROTECT: a bot sitting in Discord's "typing" state with no request
 * in flight. Discord's indicator expires after ~10s, so a stuck one is never a
 * stale UI state -- an interval is actively re-sending it, orphaned from the
 * connector's map and unreachable by stopTyping.
 *
 * These races were live before this change, when startTyping awaited the
 * channel fetch and the first send before it registered its interval. Callers are
 * fire-and-forget (agent/loop.ts calls `startTyping(...).catch(() => {})`
 * without awaiting it), so an activation could reach stopTyping while
 * startTyping was still waiting, and a start still pending from one activation
 * could register after the next one's start. (Activations on one channel don't
 * overlap: processBatch skips a channel already in activeChannels.) Now
 * startTyping registers before any await, and what can still be pending is a
 * tick's fetch and send.
 *
 * The invariant under test: a typing timer exists if and only if it is in
 * `typingIntervals`, and both start and stop mutate that map synchronously.
 *
 * Run with: npm test -- connector.typing
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

  // When gated, each channels.fetch hangs until released -- this is what lets a
  // test land a stop, a close or a second start while a tick awaits its fetch.
  // Each held fetch is kept apart, so a test can release the oldest alone.
  const held: Array<() => void> = []
  const fetch = opts.fetchGate
    ? vi.fn(() => new Promise((res) => { held.push(() => res(channel)) }))
    : vi.fn().mockResolvedValue(channel)

  // destroy() is what close() calls; without it the harness throws and the
  // test fails for a reason that has nothing to do with the code under test.
  // When destroyGate is set, destroy() hangs until releaseDestroy(), so a test
  // can start typing while close() is still awaiting it.
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
    // close() logs at info level, and the logger can hold a timer of its own
    // while it writes, which would make the timer counts below depend on the
    // log file rather than on the connector.
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
    // Two starts on one channel before a stop. An interval dropped from the
    // map while still running keeps its timer alive forever, and no stopTyping
    // can reach it again.
    h = makeHarness()
    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a stopTyping while the first tick awaits Discord wins, rather than being overtaken', async () => {
    // THE "typing forever with nothing in flight" CASE. A fast activation
    // finishes and calls stopTyping while the start's first tick is still
    // awaiting Discord. The stop must win; it must not be silently overtaken.
    h = makeHarness({ fetchGate: true })
    const baseline = vi.getTimerCount()

    const starting = h.connector.startTyping(CH)   // registers; its first tick blocks in channels.fetch
    await h.connector.stopTyping(CH)               // clears the timer the start registered
    expect(h.fetch).toHaveBeenCalledTimes(1)
    h.release()                                    // the tick resumes and finds itself stopped
    await starting

    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('leaves no live timer once stopped', async () => {
    // Ask the TIMER SYSTEM, not the map: an orphan is by definition the thing
    // the map no longer holds, so `typingIntervals.size === 0` cannot detect
    // one. Only the timer count can.
    h = makeHarness()
    // Constructing the connector opens timers too (2 in this harness), so the
    // absolute count is not the signal -- the DELTA is.
    const baseline = vi.getTimerCount()

    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('keeps refreshing the indicator while nothing stops it', async () => {
    // The control: an activation still running keeps its indicator. A fix that
    // simply never types would pass every test above.
    h = makeHarness()
    await h.connector.startTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('a start whose first tick is still awaiting its channel fetch at shutdown leaves no timer and sends nothing', async () => {
    // Shutdown is the sharpest ordering: a start's first tick is still awaiting
    // its channel fetch when the connector closes, and a stop arrives after it.
    // Nothing in that sequence may leave a timer behind -- one that survived
    // close() would keep fetching through the destroyed client until exit.
    h = makeHarness({ fetchGate: true })
    const baseline = vi.getTimerCount()

    const starting = h.connector.startTyping(CH)   // registers; its first tick blocks in fetch
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.connector.close()                      // clears every timer and the map
    await h.connector.stopTyping(CH)               // finds nothing left to clear
    h.release()
    await starting

    expect(h.intervals().size).toBe(0)
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('does not send typing after a stop that landed mid-fetch', async () => {
    // Pins the post-await identity re-check against a stop, by watching for a
    // single stray SEND. Note its limit: sending is
    // asynchronous and cannot be un-sent, so a stop can always land mid-send.
    // The check narrows that window rather than closing it, leaving at most the
    // indicators already in flight, each of which Discord expires in ~10s.
    h = makeHarness({ fetchGate: true })

    await h.connector.startTyping(CH)   // registers synchronously; tick blocks in fetch
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.connector.stopTyping(CH)    // stop wins the map
    h.release()                         // fetch resolves into a tick that was cancelled
    await vi.advanceTimersByTimeAsync(0)

    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a first tick still awaiting its channel fetch when close() runs sends nothing, with no stop after the close', async () => {
    // close() clears the map as well as the timers: the tick in flight finds
    // its handle gone after the fetch, and sends nothing.
    h = makeHarness({ fetchGate: true })
    const baseline = vi.getTimerCount()

    await h.connector.startTyping(CH)   // registers; its first tick blocks in fetch
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.connector.close()
    h.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a replacing start while the first tick awaits its channel fetch leaves the replaced tick sending nothing', async () => {
    // Pins the check after the fetch as an identity check: a stop or a close
    // empties the map, but a replacing start leaves the channel's key in place
    // with another handle, so only comparing the handle stops the old tick.
    h = makeHarness({ fetchGate: true })

    await h.connector.startTyping(CH)   // its first tick blocks in fetch
    await h.connector.startTyping(CH)   // replaces it; its own first tick blocks too
    expect(h.fetch).toHaveBeenCalledTimes(2)

    h.releaseOldest()                   // only the replaced tick resumes
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sendTyping).not.toHaveBeenCalled()

    h.release()                         // the current tick resumes and sends
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sendTyping).toHaveBeenCalledTimes(1)
    expect(h.intervals().size).toBe(1)
  })

  it('refuses a start while close() is still awaiting the client\'s destroy', async () => {
    // The flag is set before close() awaits destroy(), so a start that lands
    // during that await is refused too.
    h = makeHarness({ destroyGate: true })

    const closing = h.connector.close()           // clears the timers, then awaits destroy()
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
    // An activation that began before the agent loop stopped can reach
    // startTyping after close(), while shutdown still awaits its other steps.
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
    // Nothing awaits a tick, so its catch is all that keeps a failed refresh
    // from becoming an unhandled rejection.
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
