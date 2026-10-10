/**
 * Tests for the typing indicator's lifecycle.
 *
 * WHAT THESE PROTECT: a bot sitting in Discord's "typing" state with no request
 * in flight. Discord's indicator expires after ~10s, so a stuck one is never a
 * stale UI state -- an interval is actively re-sending it, orphaned from the
 * connector's map and unreachable by stopTyping.
 *
 * These races are live rather than theoretical because callers are
 * fire-and-forget: agent/loop.ts calls `startTyping(...).catch(() => {})`, and
 * processBatch never awaits its activationPromise, so two activations on one
 * channel overlap freely.
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

const CH = '100000000000000001'
const REFRESH_MS = 8000

function makeHarness(opts: { fetchGate?: boolean } = {}) {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-typing-test-'))
  const connector = new DiscordConnector(new EventQueue(), {
    token: 'fake',
    cacheDir: tmpCache,
    maxBackoffMs: 1000,
  })

  const sendTyping = vi.fn().mockResolvedValue(undefined)
  const channel = { isTextBased: () => true, sendTyping }

  // When gated, channels.fetch hangs until released -- this is what lets a test
  // land stopTyping in the middle of startTyping's awaits.
  let release: (() => void) | undefined
  const fetch = opts.fetchGate
    ? vi.fn(() => new Promise((res) => { release = () => res(channel) }))
    : vi.fn().mockResolvedValue(channel)

  // destroy() is what close() calls; without it the harness throws and the
  // test fails for a reason that has nothing to do with the code under test.
  ;(connector as any).client = { channels: { fetch }, destroy: async () => {} }

  return {
    connector,
    sendTyping,
    release: () => release?.(),
    intervals: () => (connector as any).typingIntervals as Map<string, unknown>,
    cleanup: () => rmSync(tmpCache, { recursive: true, force: true }),
  }
}

describe('typing indicator lifecycle', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { h?.cleanup(); vi.useRealTimers() })

  it('stops refreshing after stopTyping', async () => {
    h = makeHarness()
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a second startTyping does not orphan the first interval', async () => {
    // Two overlapping activations on one channel. An interval dropped from the
    // map while still running keeps sending typing forever, and no stopTyping
    // can reach it again.
    h = makeHarness()
    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a stopTyping during startTyping wins, rather than being overtaken', async () => {
    // THE "typing forever with nothing in flight" CASE. A fast activation
    // finishes and calls stopTyping while a start is still awaiting Discord.
    // The stop must win; it must not be silently overtaken.
    h = makeHarness({ fetchGate: true })

    const starting = h.connector.startTyping(CH)   // blocks inside channels.fetch
    await h.connector.stopTyping(CH)               // lands first; map is empty
    h.release()                                    // start resumes and registers
    await starting

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('leaves no live timer once stopped', async () => {
    // Ask the TIMER SYSTEM, not the map: an orphan is by definition the thing
    // the map no longer holds, so `typingIntervals.size === 0` cannot detect
    // one. Only the timer count can.
    h = makeHarness()
    // The connector opens 2 timers of its own at construction, so the absolute
    // count is not the signal -- the DELTA is.
    const baseline = vi.getTimerCount()

    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    expect(h.intervals().size).toBe(0)
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('still types while a request IS in flight', async () => {
    // The control. A fix that simply never types would pass every test above.
    h = makeHarness()
    await h.connector.startTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('a start still pending at shutdown never installs a timer', async () => {
    // Shutdown is the sharpest ordering: a start is still awaiting Discord when
    // the connector closes, and a stop arrives after the close. Nothing in that
    // sequence may leave a timer behind -- one that survives close() sends
    // typing through a dead client forever.
    h = makeHarness({ fetchGate: true })

    const starting = h.connector.startTyping(CH)   // generation 1, blocks in fetch
    await h.connector.close()                      // clears intervals + generations
    await h.connector.stopTyping(CH)               // must NOT be able to re-mint 1
    h.release()
    await starting

    expect(h.intervals().size).toBe(0)
    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('does not send typing after a stop that landed mid-fetch', async () => {
    // Pins the post-await identity re-check. Every other test here watches
    // TIMERS; this one watches a single stray SEND, and nothing else would
    // notice if the re-check disappeared. Note its limit: sending is
    // asynchronous and cannot be un-sent, so a stop can always land mid-send.
    // The check narrows that window rather than closing it, leaving at most one
    // indicator, which Discord expires by itself in ~10s.
    h = makeHarness({ fetchGate: true })

    await h.connector.startTyping(CH)   // registers synchronously; tick blocks in fetch
    await h.connector.stopTyping(CH)    // stop wins the map
    h.release()                         // fetch resolves into a tick that was cancelled
    await vi.advanceTimersByTimeAsync(0)

    expect(h.sendTyping).not.toHaveBeenCalled()
  })
})
