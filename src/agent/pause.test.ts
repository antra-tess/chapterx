/**
 * Tests for `.pause` parsing + PauseState behaviour.
 *
 * Run with: npm test -- pause
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { parsePauseMessage, isPauseActive, PauseState, type PauseConnectorLike } from './pause.js'
import type { TrackedPin } from '../discord/connector.js'

const BOT = 'haiku45'
const DISPLAY = 'Haiku'
const CH = 'ch-1'

function pin(id: string, content: string): TrackedPin {
  return { id, content, authorId: 'u-1', authorBot: false }
}

function pause(
  id: string,
  opts: {
    target?: string
    startedAt: string
    duration?: number
    messages?: number
    reason?: string
    extraYaml?: string
  },
): TrackedPin {
  const header = opts.target ? `.pause ${opts.target}` : '.pause'
  const body: string[] = [`started_at: ${opts.startedAt}`]
  if (opts.duration !== undefined) body.push(`duration_seconds: ${opts.duration}`)
  if (opts.messages !== undefined) body.push(`messages: ${opts.messages}`)
  if (opts.reason !== undefined) body.push(`reason: ${opts.reason}`)
  if (opts.extraYaml) body.push(opts.extraYaml)
  return pin(id, `${header}\n---\n${body.join('\n')}`)
}

class FakeConnector implements PauseConnectorLike {
  constructor(public pins: Map<string, TrackedPin[]> = new Map()) {}
  getCachedPinnedPauses(channelId: string): TrackedPin[] | null {
    return this.pins.get(channelId) ?? null
  }
  set(channelId: string, arr: TrackedPin[]) { this.pins.set(channelId, arr) }
}

// ────────────────────────────────────────────────────────────────────────────
// parsePauseMessage
// ────────────────────────────────────────────────────────────────────────────

describe('parsePauseMessage: happy paths', () => {
  it('parses a duration-only pause', () => {
    const parsed = parsePauseMessage(
      `.pause @${BOT}\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: 600`,
      BOT,
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.startedAt).toBe(Date.parse('2026-04-16T20:30:00Z'))
    expect(parsed!.durationSeconds).toBe(600)
    expect(parsed!.messages).toBeUndefined()
  })

  it('parses a count-only pause', () => {
    const parsed = parsePauseMessage(
      `.pause ${BOT}\n---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 10`,
      BOT,
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.messages).toBe(10)
    expect(parsed!.durationSeconds).toBeUndefined()
  })

  it('parses a both-gates pause with reason', () => {
    const parsed = parsePauseMessage(
      `.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: 300\nmessages: 5\nreason: debugging`,
      BOT,
    )
    expect(parsed).toEqual({
      startedAt: Date.parse('2026-04-16T20:30:00Z'),
      durationSeconds: 300,
      messages: 5,
      reason: 'debugging',
    })
  })

  it('coerces a non-integer messages value to floor', () => {
    const parsed = parsePauseMessage(
      `.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5.9`,
      BOT,
    )
    expect(parsed!.messages).toBe(5)
  })
})

describe('parsePauseMessage: invalid inputs', () => {
  it('rejects content that does not start with .pause', () => {
    expect(parsePauseMessage('hello\n---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5', BOT)).toBeNull()
  })

  it('rejects missing `---` separator', () => {
    expect(parsePauseMessage('.pause\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5', BOT)).toBeNull()
  })

  it('rejects malformed YAML body', () => {
    expect(parsePauseMessage('.pause\n---\n:: :: not yaml', BOT)).toBeNull()
  })

  it('rejects missing started_at', () => {
    expect(parsePauseMessage('.pause\n---\nmessages: 5', BOT)).toBeNull()
  })

  it('rejects non-ISO started_at', () => {
    expect(parsePauseMessage('.pause\n---\nstarted_at: never\nmessages: 5', BOT)).toBeNull()
  })

  it('rejects neither-gate-set', () => {
    expect(parsePauseMessage('.pause\n---\nstarted_at: 2026-04-16T20:30:00Z', BOT)).toBeNull()
  })

  it('rejects zero / negative gates as if unset (effectively neither set)', () => {
    expect(parsePauseMessage(
      '.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: 0\nmessages: 0',
      BOT,
    )).toBeNull()
    expect(parsePauseMessage(
      '.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: -1',
      BOT,
    )).toBeNull()
  })
})

describe('parsePauseMessage: target matching', () => {
  const body = '---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5'

  it('empty target (just `.pause`) matches every bot', () => {
    expect(parsePauseMessage(`.pause\n${body}`, BOT)).not.toBeNull()
    expect(parsePauseMessage(`.pause\n${body}`, 'someOtherBot')).not.toBeNull()
  })

  it('exact botName match (case-insensitive)', () => {
    expect(parsePauseMessage(`.pause ${BOT}\n${body}`, BOT)).not.toBeNull()
    expect(parsePauseMessage(`.pause HAIKU45\n${body}`, BOT)).not.toBeNull()
  })

  it('display-name match (case-insensitive)', () => {
    expect(parsePauseMessage(`.pause Haiku\n${body}`, BOT, DISPLAY)).not.toBeNull()
    expect(parsePauseMessage(`.pause haiku\n${body}`, BOT, DISPLAY)).not.toBeNull()
  })

  it('@-prefixed target strips the @', () => {
    expect(parsePauseMessage(`.pause @${BOT}\n${body}`, BOT)).not.toBeNull()
    expect(parsePauseMessage(`.pause @Haiku\n${body}`, BOT, DISPLAY)).not.toBeNull()
  })

  it('<@id> mention target strips the wrapper', () => {
    expect(parsePauseMessage(`.pause <@haiku45>\n${body}`, BOT)).not.toBeNull()
    expect(parsePauseMessage(`.pause <@!haiku45>\n${body}`, BOT)).not.toBeNull()
  })

  it('non-matching target returns null', () => {
    expect(parsePauseMessage(`.pause otherBot\n${body}`, BOT)).toBeNull()
    expect(parsePauseMessage(`.pause @otherBot\n${body}`, BOT, DISPLAY)).toBeNull()
  })

  it('`.pause all` is NOT treated specially — use empty target to mean all', () => {
    // Since `.config` never learned `all`, `.pause` doesn't either.
    expect(parsePauseMessage(`.pause all\n${body}`, BOT)).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// isPauseActive
// ────────────────────────────────────────────────────────────────────────────

describe('isPauseActive', () => {
  const START = Date.parse('2026-04-16T20:30:00Z')

  it('is inactive before started_at (clock-skew safety)', () => {
    expect(isPauseActive({ startedAt: START, durationSeconds: 600 }, 0, START - 1_000)).toBe(false)
  })

  it('is active within the time window', () => {
    expect(isPauseActive({ startedAt: START, durationSeconds: 600 }, 0, START + 60_000)).toBe(true)
  })

  it('is inactive at/after the time window ends', () => {
    expect(isPauseActive({ startedAt: START, durationSeconds: 600 }, 0, START + 600_000)).toBe(false)
    expect(isPauseActive({ startedAt: START, durationSeconds: 600 }, 0, START + 1_000_000)).toBe(false)
  })

  it('is active below the count gate', () => {
    expect(isPauseActive({ startedAt: START, messages: 10 }, 9, START + 1_000)).toBe(true)
  })

  it('is inactive at the count boundary (count >= messages expires)', () => {
    expect(isPauseActive({ startedAt: START, messages: 10 }, 10, START + 1_000)).toBe(false)
    expect(isPauseActive({ startedAt: START, messages: 10 }, 11, START + 1_000)).toBe(false)
  })

  it('with both gates: ends at whichever trips first (count)', () => {
    const p = { startedAt: START, durationSeconds: 600, messages: 3 }
    expect(isPauseActive(p, 2, START + 1_000)).toBe(true)    // within both
    expect(isPauseActive(p, 3, START + 1_000)).toBe(false)   // count tripped first
  })

  it('with both gates: ends at whichever trips first (time)', () => {
    const p = { startedAt: START, durationSeconds: 600, messages: 100 }
    expect(isPauseActive(p, 0, START + 599_999)).toBe(true)
    expect(isPauseActive(p, 0, START + 600_000)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// PauseState
// ────────────────────────────────────────────────────────────────────────────

describe('PauseState.observeMessage', () => {
  let connector: FakeConnector
  let state: PauseState

  beforeEach(() => {
    connector = new FakeConnector()
    state = new PauseState(connector)
  })

  it('starts counts at zero on cold read', () => {
    expect(state.getCount(CH, 'pin-1')).toBe(0)
  })

  it('increments per call', () => {
    state.observeMessage(CH, 'pin-1')
    state.observeMessage(CH, 'pin-1')
    state.observeMessage(CH, 'pin-1')
    expect(state.getCount(CH, 'pin-1')).toBe(3)
  })

  it('tracks per-pin counts independently', () => {
    state.observeMessage(CH, 'pin-1')
    state.observeMessage(CH, 'pin-2')
    state.observeMessage(CH, 'pin-2')
    expect(state.getCount(CH, 'pin-1')).toBe(1)
    expect(state.getCount(CH, 'pin-2')).toBe(2)
  })

  it('tracks per-channel counts independently', () => {
    state.observeMessage('ch-a', 'pin-1')
    state.observeMessage('ch-b', 'pin-1')
    state.observeMessage('ch-b', 'pin-1')
    expect(state.getCount('ch-a', 'pin-1')).toBe(1)
    expect(state.getCount('ch-b', 'pin-1')).toBe(2)
  })
})

describe('PauseState.pausePinsForBot', () => {
  const START = '2026-04-16T20:30:00Z'
  let connector: FakeConnector
  let state: PauseState

  beforeEach(() => {
    connector = new FakeConnector()
    state = new PauseState(connector, () => DISPLAY)
  })

  it('returns [] when no pauses', () => {
    expect(state.pausePinsForBot(CH, BOT)).toEqual([])
  })

  it('includes pins targeting this bot', () => {
    connector.set(CH, [pause('p1', { target: `@${BOT}`, startedAt: START, duration: 600 })])
    expect(state.pausePinsForBot(CH, BOT)).toEqual(['p1'])
  })

  it('includes pins with no target (apply to all bots)', () => {
    connector.set(CH, [pause('p1', { startedAt: START, messages: 5 })])
    expect(state.pausePinsForBot(CH, BOT)).toEqual(['p1'])
  })

  it('excludes pins targeting another bot', () => {
    connector.set(CH, [pause('p1', { target: 'someOtherBot', startedAt: START, messages: 5 })])
    expect(state.pausePinsForBot(CH, BOT)).toEqual([])
  })

  it('mixes multiple pins — returns only matching', () => {
    connector.set(CH, [
      pause('p1', { target: BOT, startedAt: START, duration: 600 }),
      pause('p2', { target: 'other', startedAt: START, messages: 5 }),
      pause('p3', { startedAt: START, messages: 3 }),
    ])
    expect(state.pausePinsForBot(CH, BOT).sort()).toEqual(['p1', 'p3'])
  })
})

describe('PauseState.isPaused', () => {
  const START = Date.parse('2026-04-16T20:30:00Z')
  let connector: FakeConnector
  let state: PauseState

  beforeEach(() => {
    connector = new FakeConnector()
    state = new PauseState(connector)
  })

  it('returns false with no pauses', () => {
    expect(state.isPaused(CH, BOT, START + 1_000)).toBe(false)
  })

  it('returns false before started_at', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, BOT, START - 10_000)).toBe(false)
  })

  it('returns true during the time window', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, BOT, START + 60_000)).toBe(true)
  })

  it('returns false after the time window', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, BOT, START + 600_000)).toBe(false)
  })

  it('count gate: active below threshold, inactive at/above', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', messages: 3 })])
    expect(state.isPaused(CH, BOT, START + 1_000)).toBe(true)  // count=0
    state.observeMessage(CH, 'p1')
    state.observeMessage(CH, 'p1')
    expect(state.isPaused(CH, BOT, START + 1_000)).toBe(true)  // count=2, still below 3
    state.observeMessage(CH, 'p1')
    expect(state.isPaused(CH, BOT, START + 1_000)).toBe(false) // count=3, expired
  })

  it('pin for another bot does not pause this bot', () => {
    connector.set(CH, [pause('p1', { target: 'someOtherBot', startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, BOT, START + 60_000)).toBe(false)
  })

  it('invalid pins (malformed) do not pause the bot', () => {
    connector.set(CH, [pin('p1', '.pause\nnot-yaml-body')])
    expect(state.isPaused(CH, BOT, START + 60_000)).toBe(false)
  })

  it('multiple pins: paused if ANY active', () => {
    connector.set(CH, [
      pause('p1', { target: 'other', startedAt: '2026-04-16T20:30:00Z', duration: 600 }),
      pause('p2', { startedAt: '2026-04-16T20:30:00Z', messages: 5 }),
    ])
    expect(state.isPaused(CH, BOT, START + 60_000)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Semantic check: "pause for N messages" blocks N, (N+1)th passes
// ────────────────────────────────────────────────────────────────────────────

describe('pause semantics: N-blocked', () => {
  it('with the loop-ordering (isPaused check BEFORE observe): N blocked, (N+1)th passes', () => {
    const connector = new FakeConnector()
    const state = new PauseState(connector)
    const START = Date.parse('2026-04-16T20:30:00Z')
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', messages: 3 })])

    // Simulate the loop.ts order: for each event, (1) check isPaused, (2) observeMessage.
    const passedAt: number[] = []
    for (let i = 1; i <= 5; i++) {
      const paused = state.isPaused(CH, BOT, START + 1_000)
      state.observeMessage(CH, 'p1')
      if (!paused) passedAt.push(i)
    }
    // Events 1, 2, 3 should be blocked; 4 and 5 pass.
    expect(passedAt).toEqual([4, 5])
  })
})
