/**
 * `.pause` pin support.
 *
 * Soma (or a human admin) pins a message of the form:
 *
 *     .pause @BotName
 *     ---
 *     started_at: 2026-04-16T20:30:00Z
 *     duration_seconds: 600      # optional (time gate)
 *     messages: 10               # optional (count gate)
 *     reason: debugging          # optional, for humans
 *
 * At least one of `duration_seconds` / `messages` must be set. If both are
 * set, the pause ends at whichever trips first. `started_at` is authoritative
 * (not the pin's Discord createdAt) so the author controls timing precisely.
 *
 * Target matching mirrors `.config`:
 *   - empty target (just `.pause` on the first line) = applies to every bot
 *   - `.pause @BotName` / `.pause BotName` = that bot only (case-insensitive;
 *     matched against botId or the bot's display name)
 */

import * as YAML from 'yaml'
import { logger } from '../utils/logger.js'
import type { TrackedPin } from '../discord/connector.js'

export interface ParsedPause {
  startedAt: number            // epoch ms
  durationSeconds?: number     // time gate (unset => no time gate)
  messages?: number            // count gate (unset => no count gate)
  reason?: string
}

export interface PauseConnectorLike {
  getCachedPinnedPauses(channelId: string): TrackedPin[] | null
}

/**
 * Parse a `.pause` pinned message. Returns null when the content isn't a valid
 * `.pause` for this bot — i.e. any of: not a `.pause` message at all,
 * malformed header, target doesn't match this bot, invalid YAML, missing
 * `started_at`, or neither gate set.
 */
export function parsePauseMessage(
  content: string,
  botName: string,
  botDisplayName?: string,
): ParsedPause | null {
  if (!content.startsWith('.pause')) return null

  const lines = content.split('\n')
  // Header: `.pause [target]` + `---` + yaml body
  if (lines.length < 3 || lines[1] !== '---') return null

  // Extract target from the first line (whatever follows `.pause`).
  const rawTarget = lines[0]!.slice('.pause'.length).trim()
  const target = rawTarget.length > 0 ? rawTarget : undefined

  if (target) {
    // Strip Discord mention syntax (`<@123>` / `<@!123>` / `@Name`).
    const stripped = target
      .replace(/^<@!?([^>]+)>$/, '$1')
      .replace(/^@/, '')
      .toLowerCase()
    const matchesBotId = stripped === botName.toLowerCase()
    const matchesDisplayName = !!(botDisplayName && stripped === botDisplayName.toLowerCase())
    if (!matchesBotId && !matchesDisplayName) return null
  }

  // Parse the YAML body.
  const yamlBody = lines.slice(2).join('\n')
  let parsed: unknown
  try {
    parsed = YAML.parse(yamlBody)
  } catch (error) {
    logger.warn({ error, yamlBody }, 'Failed to parse .pause YAML body')
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const obj = parsed as Record<string, unknown>

  // started_at is required — ISO-8601 string.
  const startedAtRaw = obj.started_at
  if (typeof startedAtRaw !== 'string') return null
  const startedAt = Date.parse(startedAtRaw)
  if (Number.isNaN(startedAt)) return null

  // duration_seconds: positive number. Zero / negative / non-numeric => unset.
  const durationSeconds =
    typeof obj.duration_seconds === 'number' && obj.duration_seconds > 0
      ? obj.duration_seconds
      : undefined

  // messages: positive integer. Zero / negative / non-numeric => unset.
  const messages =
    typeof obj.messages === 'number' && obj.messages > 0 && Number.isFinite(obj.messages)
      ? Math.floor(obj.messages)
      : undefined

  // At least one gate must be set.
  if (durationSeconds === undefined && messages === undefined) return null

  const reason = typeof obj.reason === 'string' ? obj.reason : undefined

  return { startedAt, durationSeconds, messages, reason }
}

/**
 * Is a parsed pause still in effect, given the observed message count and `now`?
 *
 * Semantics:
 *   - Before `started_at`: not active (pause hasn't begun).
 *   - duration_seconds set + elapsed >= duration_seconds: expired.
 *   - messages set + observedCount >= messages: expired.
 *   - Otherwise: active.
 *
 * When both gates are set, the pause ends at whichever trips first.
 */
export function isPauseActive(
  pause: ParsedPause,
  observedCount: number,
  now: number,
): boolean {
  if (now < pause.startedAt) return false
  if (pause.durationSeconds !== undefined) {
    const elapsedSeconds = (now - pause.startedAt) / 1000
    if (elapsedSeconds >= pause.durationSeconds) return false
  }
  if (pause.messages !== undefined) {
    if (observedCount >= pause.messages) return false
  }
  return true
}

/**
 * Per-bot pause state. Keyed by `(channelId, pinId)` so multiple concurrent
 * pause pins on the same channel each track their own count.
 *
 * The pin message itself is the source of truth — `started_at`, gates, reason.
 * This class only keeps the (non-persisted) "how many non-dot messages have I
 * observed since the pin appeared" counter, needed for the message-count gate.
 *
 * Bot restart: counters reset to 0. The time gate still resolves correctly
 * because `started_at` lives in the pin. The count gate may extend slightly
 * past intended — accepted as a v1 trade-off.
 */
export class PauseState {
  private counters = new Map<string, Map<string, number>>()

  constructor(
    private connector: PauseConnectorLike,
    private getBotDisplayName: () => string | undefined = () => undefined,
  ) {}

  getCount(channelId: string, pinId: string): number {
    return this.counters.get(channelId)?.get(pinId) ?? 0
  }

  observeMessage(channelId: string, pinId: string): void {
    let m = this.counters.get(channelId)
    if (!m) {
      m = new Map()
      this.counters.set(channelId, m)
    }
    m.set(pinId, (m.get(pinId) ?? 0) + 1)
  }

  /**
   * Pin IDs of pauses applicable to this bot in this channel. The caller
   * iterates this list and calls `observeMessage` per pin on each non-dot
   * event. Cheap: one sync read + N small YAML parses (N ≈ number of pinned
   * pauses, usually 0 or 1).
   */
  pausePinsForBot(channelId: string, botName: string): string[] {
    const pins = this.connector.getCachedPinnedPauses(channelId) ?? []
    const out: string[] = []
    for (const pin of pins) {
      if (parsePauseMessage(pin.content, botName, this.getBotDisplayName())) {
        out.push(pin.id)
      }
    }
    return out
  }

  /**
   * Is this (channelId, botName) currently paused? True if ANY active pause
   * pin applies to this bot.
   */
  isPaused(channelId: string, botName: string, now: number): boolean {
    const pins = this.connector.getCachedPinnedPauses(channelId) ?? []
    for (const pin of pins) {
      const parsed = parsePauseMessage(pin.content, botName, this.getBotDisplayName())
      if (!parsed) continue
      if (isPauseActive(parsed, this.getCount(channelId, pin.id), now)) return true
    }
    return false
  }
}
