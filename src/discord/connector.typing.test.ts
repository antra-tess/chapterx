/**
 * Tests for the typing indicator's lifecycle.
 *
 * THE BUG THESE PIN: a bot sometimes sits in Discord's "typing" state with no
 * request in flight. Discord's indicator expires after ~10s, so a STUCK
 * indicator is not a stale UI state -- something is actively re-sending it.
 * That something is an orphaned setInterval inside DiscordConnector.
 *
 * Two ways one gets orphaned, both live because activations are fire-and-forget
 * (agent/loop.ts calls `startTyping(...).catch(() => {})`, and processBatch
 * never awaits its activationPromise, so two activations on one channel can
 * overlap):
 *
 *   1. DOUBLE START. startTyping overwrote typingIntervals[channelId] without
 *      clearing what was already there, so the first interval was dropped from
 *      the map while still firing. stopTyping could then only ever clear the
 *      most recent one.
 *
 *   2. STOP-BEFORE-START RACE. startTyping awaits channels.fetch() and
 *      sendTyping() BEFORE registering its interval. A fast activation calls
 *      stopTyping while the map is still empty -- clearing nothing -- and the
 *      interval registers afterwards with nobody left to stop it. This is the
 *      one that produces "typing forever, nothing in flight".
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

  ;(connector as any).client = { channels: { fetch } }

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
    // Two overlapping activations on one channel. Before the fix the first
    // interval was dropped from the map while still running, so it kept
    // sending typing forever and no stopTyping could ever reach it.
    h = makeHarness()
    await h.connector.startTyping(CH)
    await h.connector.startTyping(CH)
    await h.connector.stopTyping(CH)

    h.sendTyping.mockClear()
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3)
    expect(h.sendTyping).not.toHaveBeenCalled()
  })

  it('a stopTyping during startTyping wins, rather than being overtaken', async () => {
    // THE "typing forever with nothing in flight" CASE. startTyping is
    // fire-and-forget, so a fast activation finishes and calls stopTyping while
    // startTyping is still awaiting Discord. The stop must not be silently lost.
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
    // NOT the Map -- the Map is exactly where an orphan ISN'T. Asserting
    // typingIntervals.size === 0 passed against the buggy code, because the
    // orphaned interval had already been evicted from the map while still
    // running. Ask the timer system instead; it can see what the map cannot.
    h = makeHarness()
    // The connector opens 2 timers of its own at construction, so the absolute
    // count is not the signal -- the DELTA is. Asserting 0 here failed against
    // correct code, which is its own small lesson about checks.
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
})
