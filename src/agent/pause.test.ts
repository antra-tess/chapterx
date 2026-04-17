/**
 * Tests for `.pause` parsing + PauseState behaviour.
 *
 * Run with: npm test -- pause
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { parsePauseMessage, isPauseActive, PauseState, type PauseConnectorLike, type BotIdentity } from './pause.js'
import type { TrackedPin } from '../discord/connector.js'

const BOT = 'haiku45'
const DISPLAY = 'Haiku'
const CH = 'ch-1'

// Keep existing tests ergonomic: a helper that builds a BotIdentity from the
// two positional strings the old parsePauseMessage signature took.
function id(botId: string, configName?: string, extra: Partial<BotIdentity> = {}): BotIdentity {
  return { botId, configName, ...extra }
}

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
      id(BOT),
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.startedAt).toBe(Date.parse('2026-04-16T20:30:00Z'))
    expect(parsed!.durationSeconds).toBe(600)
    expect(parsed!.messages).toBeUndefined()
  })

  it('parses a count-only pause', () => {
    const parsed = parsePauseMessage(
      `.pause ${BOT}\n---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 10`,
      id(BOT),
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.messages).toBe(10)
    expect(parsed!.durationSeconds).toBeUndefined()
  })

  it('parses a both-gates pause with reason', () => {
    const parsed = parsePauseMessage(
      `.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: 300\nmessages: 5\nreason: debugging`,
      id(BOT),
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
      id(BOT),
    )
    expect(parsed!.messages).toBe(5)
  })
})

describe('parsePauseMessage: invalid inputs', () => {
  it('rejects content that does not start with .pause', () => {
    expect(parsePauseMessage('hello\n---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5', id(BOT))).toBeNull()
  })

  it('rejects missing `---` separator', () => {
    expect(parsePauseMessage('.pause\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5', id(BOT))).toBeNull()
  })

  it('rejects malformed YAML body', () => {
    expect(parsePauseMessage('.pause\n---\n:: :: not yaml', id(BOT))).toBeNull()
  })

  it('rejects missing started_at', () => {
    expect(parsePauseMessage('.pause\n---\nmessages: 5', id(BOT))).toBeNull()
  })

  it('rejects non-ISO started_at', () => {
    expect(parsePauseMessage('.pause\n---\nstarted_at: never\nmessages: 5', id(BOT))).toBeNull()
  })

  it('rejects neither-gate-set', () => {
    expect(parsePauseMessage('.pause\n---\nstarted_at: 2026-04-16T20:30:00Z', id(BOT))).toBeNull()
  })

  it('rejects zero / negative gates as if unset (effectively neither set)', () => {
    expect(parsePauseMessage(
      '.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: 0\nmessages: 0',
      id(BOT),
    )).toBeNull()
    expect(parsePauseMessage(
      '.pause\n---\nstarted_at: 2026-04-16T20:30:00Z\nduration_seconds: -1',
      id(BOT),
    )).toBeNull()
  })
})

describe('parsePauseMessage: target matching', () => {
  const body = '---\nstarted_at: 2026-04-16T20:30:00Z\nmessages: 5'

  it('empty target (just `.pause`) matches every bot', () => {
    expect(parsePauseMessage(`.pause\n${body}`, id(BOT))).not.toBeNull()
    expect(parsePauseMessage(`.pause\n${body}`, id('someOtherBot'))).not.toBeNull()
  })

  it('exact botName match (case-insensitive)', () => {
    expect(parsePauseMessage(`.pause ${BOT}\n${body}`, id(BOT))).not.toBeNull()
    expect(parsePauseMessage(`.pause HAIKU45\n${body}`, id(BOT))).not.toBeNull()
  })

  it('config-name match (case-insensitive)', () => {
    expect(parsePauseMessage(`.pause Haiku\n${body}`, id(BOT, DISPLAY))).not.toBeNull()
    expect(parsePauseMessage(`.pause haiku\n${body}`, id(BOT, DISPLAY))).not.toBeNull()
  })

  it('discord username match (case-insensitive)', () => {
    expect(parsePauseMessage(
      `.pause opus4.7\n${body}`,
      id('opus47', 'Opus4.7', { discordUsername: 'opus4.7' }),
    )).not.toBeNull()
  })

  it('discord global-name match — handles spaces (the real-world bug)', () => {
    // Admin writes `.pause Opus 4.7` (the name they see in Discord).
    // botId is `opus47`, config name is `Opus4.7` (no space) — neither matches.
    // The Discord global name `Opus 4.7` is the one that must resolve it.
    expect(parsePauseMessage(
      `.pause Opus 4.7\n${body}`,
      id('opus47', 'Opus4.7', { discordGlobalName: 'Opus 4.7' }),
    )).not.toBeNull()
  })

  it('<@userId> mention matches discordUserId', () => {
    expect(parsePauseMessage(
      `.pause <@1234567890>\n${body}`,
      id('opus47', 'Opus4.7', { discordUserId: '1234567890' }),
    )).not.toBeNull()
    expect(parsePauseMessage(
      `.pause <@!1234567890>\n${body}`,
      id('opus47', 'Opus4.7', { discordUserId: '1234567890' }),
    )).not.toBeNull()
  })

  it('@-prefixed target strips the @', () => {
    expect(parsePauseMessage(`.pause @${BOT}\n${body}`, id(BOT))).not.toBeNull()
    expect(parsePauseMessage(`.pause @Haiku\n${body}`, id(BOT, DISPLAY))).not.toBeNull()
  })

  it('<@name> textual target falls back to string compare against botId', () => {
    expect(parsePauseMessage(`.pause <@haiku45>\n${body}`, id(BOT))).not.toBeNull()
    expect(parsePauseMessage(`.pause <@!haiku45>\n${body}`, id(BOT))).not.toBeNull()
  })

  it('non-matching target returns null', () => {
    expect(parsePauseMessage(`.pause otherBot\n${body}`, id(BOT))).toBeNull()
    expect(parsePauseMessage(`.pause @otherBot\n${body}`, id(BOT, DISPLAY))).toBeNull()
  })

  it('`.pause all` is NOT treated specially — use empty target to mean all', () => {
    // Since `.config` never learned `all`, `.pause` doesn't either.
    expect(parsePauseMessage(`.pause all\n${body}`, id(BOT))).toBeNull()
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
    state = new PauseState(connector, () => id(BOT))
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
    state = new PauseState(connector, () => id(BOT, DISPLAY))
  })

  it('returns [] when no pauses', () => {
    expect(state.pausePinsForBot(CH)).toEqual([])
  })

  it('includes pins targeting this bot', () => {
    connector.set(CH, [pause('p1', { target: `@${BOT}`, startedAt: START, duration: 600 })])
    expect(state.pausePinsForBot(CH)).toEqual(['p1'])
  })

  it('includes pins with no target (apply to all bots)', () => {
    connector.set(CH, [pause('p1', { startedAt: START, messages: 5 })])
    expect(state.pausePinsForBot(CH)).toEqual(['p1'])
  })

  it('excludes pins targeting another bot', () => {
    connector.set(CH, [pause('p1', { target: 'someOtherBot', startedAt: START, messages: 5 })])
    expect(state.pausePinsForBot(CH)).toEqual([])
  })

  it('mixes multiple pins — returns only matching', () => {
    connector.set(CH, [
      pause('p1', { target: BOT, startedAt: START, duration: 600 }),
      pause('p2', { target: 'other', startedAt: START, messages: 5 }),
      pause('p3', { startedAt: START, messages: 3 }),
    ])
    expect(state.pausePinsForBot(CH).sort()).toEqual(['p1', 'p3'])
  })

  it('matches a Discord-global-name target with spaces (the real-world bug)', () => {
    const c = new FakeConnector()
    const s = new PauseState(c, () => id('opus47', 'Opus4.7', { discordGlobalName: 'Opus 4.7' }))
    c.set(CH, [pause('p1', { target: 'Opus 4.7', startedAt: START, duration: 7200 })])
    expect(s.pausePinsForBot(CH)).toEqual(['p1'])
  })

  it('matches a <@userId> target against discordUserId', () => {
    const c = new FakeConnector()
    const s = new PauseState(c, () => id('opus47', 'Opus4.7', { discordUserId: '1234567890' }))
    c.set(CH, [pause('p1', { target: '<@1234567890>', startedAt: START, duration: 7200 })])
    expect(s.pausePinsForBot(CH)).toEqual(['p1'])
  })
})

describe('PauseState.isPaused', () => {
  const START = Date.parse('2026-04-16T20:30:00Z')
  let connector: FakeConnector
  let state: PauseState

  beforeEach(() => {
    connector = new FakeConnector()
    state = new PauseState(connector, () => id(BOT))
  })

  it('returns false with no pauses', () => {
    expect(state.isPaused(CH, START + 1_000)).toBe(false)
  })

  it('returns false before started_at', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, START - 10_000)).toBe(false)
  })

  it('returns true during the time window', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, START + 60_000)).toBe(true)
  })

  it('returns false after the time window', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, START + 600_000)).toBe(false)
  })

  it('count gate: active below threshold, inactive at/above', () => {
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', messages: 3 })])
    expect(state.isPaused(CH, START + 1_000)).toBe(true)  // count=0
    state.observeMessage(CH, 'p1')
    state.observeMessage(CH, 'p1')
    expect(state.isPaused(CH, START + 1_000)).toBe(true)  // count=2, still below 3
    state.observeMessage(CH, 'p1')
    expect(state.isPaused(CH, START + 1_000)).toBe(false) // count=3, expired
  })

  it('pin for another bot does not pause this bot', () => {
    connector.set(CH, [pause('p1', { target: 'someOtherBot', startedAt: '2026-04-16T20:30:00Z', duration: 600 })])
    expect(state.isPaused(CH, START + 60_000)).toBe(false)
  })

  it('invalid pins (malformed) do not pause the bot', () => {
    connector.set(CH, [pin('p1', '.pause\nnot-yaml-body')])
    expect(state.isPaused(CH, START + 60_000)).toBe(false)
  })

  it('multiple pins: paused if ANY active', () => {
    connector.set(CH, [
      pause('p1', { target: 'other', startedAt: '2026-04-16T20:30:00Z', duration: 600 }),
      pause('p2', { startedAt: '2026-04-16T20:30:00Z', messages: 5 }),
    ])
    expect(state.isPaused(CH, START + 60_000)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Semantic check: "pause for N messages" blocks N, (N+1)th passes
// ────────────────────────────────────────────────────────────────────────────

describe('pause semantics: N-blocked', () => {
  it('with the loop-ordering (isPaused check BEFORE observe): N blocked, (N+1)th passes', () => {
    const connector = new FakeConnector()
    const state = new PauseState(connector, () => id(BOT))
    const START = Date.parse('2026-04-16T20:30:00Z')
    connector.set(CH, [pause('p1', { startedAt: '2026-04-16T20:30:00Z', messages: 3 })])

    // Simulate the loop.ts order: for each event, (1) check isPaused, (2) observeMessage.
    const passedAt: number[] = []
    for (let i = 1; i <= 5; i++) {
      const paused = state.isPaused(CH, START + 1_000)
      state.observeMessage(CH, 'p1')
      if (!paused) passedAt.push(i)
    }
    // Events 1, 2, 3 should be blocked; 4 and 5 pass.
    expect(passedAt).toEqual([4, 5])
  })
})
