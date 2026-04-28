/**
 * `.sleep` pin support.
 *
 * Soma (or a human admin) pins a message of the form:
 *
 *     .sleep @BotName
 *     ---
 *     started_at: 2026-04-16T20:30:00Z
 *     duration_seconds: 600      # optional (time gate)
 *     messages: 10               # optional (count gate)
 *     reason: debugging          # optional, for humans
 *
 * At least one of `duration_seconds` / `messages` must be set. If both are
 * set, the sleep ends at whichever trips first. `started_at` is authoritative
 * (not the pin's Discord createdAt) so the author controls timing precisely.
 *
 * Target matching mirrors `.config`:
 *   - empty target (just `.sleep` on the first line) = applies to every bot
 *   - `.sleep @BotName` / `.sleep BotName` = that bot only (case-insensitive;
 *     matched against botId or the bot's display name)
 */

import * as YAML from 'yaml'
import { logger } from '../utils/logger.js'
import type { TrackedPin } from '../discord/connector.js'

export interface ParsedSleep {
  startedAt: number            // epoch ms
  durationSeconds?: number     // time gate (unset => no time gate)
  messages?: number            // count gate (unset => no count gate)
  reason?: string
}

/**
 * All identity forms a `.sleep` target may address this bot by. Any non-empty
 * field is a valid match; case-insensitive. The parser tries each in turn, so
 * admins can write `.sleep opus47` (dir name), `.sleep Opus4.7` (config name),
 * `.sleep Opus 4.7` (Discord global name, with spaces), `.sleep @opus4.7`
 * (Discord username), or `.sleep <@123…>` (user-ID mention) and all resolve.
 */
export interface BotIdentity {
  /** EMS directory / internal bot id — e.g. `opus47`. */
  botId: string
  /** Config `name:` field — e.g. `Opus4.7`. */
  configName?: string
  /** Discord account username — e.g. `opus4.7`. */
  discordUsername?: string
  /** Discord account global display name — e.g. `Opus 4.7` (with spaces). */
  discordGlobalName?: string
  /** Discord user ID snowflake — matches `<@id>` mentions. */
  discordUserId?: string
}

export interface SleepConnectorLike {
  getCachedPinnedSleeps(channelId: string): TrackedPin[] | null
}

/**
 * Parse a `.sleep` pinned message. Returns null when the content isn't a valid
 * `.sleep` for this bot — i.e. any of: not a `.sleep` message at all,
 * malformed header, target doesn't match this bot, invalid YAML, missing
 * `started_at`, or neither gate set.
 */
export function parseSleepMessage(
  content: string,
  identity: BotIdentity,
): ParsedSleep | null {
  if (!content.startsWith('.sleep')) return null

  const lines = content.split('\n')
  // Header: `.sleep [target]` + `---` + yaml body
  if (lines.length < 3 || lines[1] !== '---') return null

  // Extract target from the first line (whatever follows `.sleep`).
  const rawTarget = lines[0]!.slice('.sleep'.length).trim()
  const target = rawTarget.length > 0 ? rawTarget : undefined

  if (target) {
    // Strip Discord mention syntax (`<@123>` / `<@!123>` / `@Name`).
    const stripped = target
      .replace(/^<@!?([^>]+)>$/, '$1')
      .replace(/^@/, '')
      .toLowerCase()
    const candidates = [
      identity.botId,
      identity.configName,
      identity.discordUsername,
      identity.discordGlobalName,
      identity.discordUserId,
    ]
    const matched = candidates.some(
      (c) => !!c && stripped === c.toLowerCase(),
    )
    if (!matched) return null
  }

  // Parse the YAML body.
  const yamlBody = lines.slice(2).join('\n')
  let parsed: unknown
  try {
    parsed = YAML.parse(yamlBody)
  } catch (error) {
    logger.warn({ error, yamlBody }, 'Failed to parse .sleep YAML body')
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
 * Is a parsed sleep still in effect, given the observed message count and `now`?
 *
 * Semantics:
 *   - Before `started_at`: not active (sleep hasn't begun).
 *   - duration_seconds set + elapsed >= duration_seconds: expired.
 *   - messages set + observedCount >= messages: expired.
 *   - Otherwise: active.
 *
 * When both gates are set, the sleep ends at whichever trips first.
 */
export function isSleepActive(
  sleep: ParsedSleep,
  observedCount: number,
  now: number,
): boolean {
  if (now < sleep.startedAt) return false
  if (sleep.durationSeconds !== undefined) {
    const elapsedSeconds = (now - sleep.startedAt) / 1000
    if (elapsedSeconds >= sleep.durationSeconds) return false
  }
  if (sleep.messages !== undefined) {
    if (observedCount >= sleep.messages) return false
  }
  return true
}

/**
 * Per-bot sleep state. Keyed by `(channelId, pinId)` so multiple concurrent
 * sleep pins on the same channel each track their own count.
 *
 * The pin message itself is the source of truth — `started_at`, gates, reason.
 * This class only keeps the (non-persisted) "how many non-dot messages have I
 * observed since the pin appeared" counter, needed for the message-count gate.
 *
 * Bot restart: counters reset to 0. The time gate still resolves correctly
 * because `started_at` lives in the pin. The count gate may extend slightly
 * past intended — accepted as a v1 trade-off.
 */
export class SleepState {
  private counters = new Map<string, Map<string, number>>()

  constructor(
    private connector: SleepConnectorLike,
    private getBotIdentity: () => BotIdentity,
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
   * Pin IDs of sleeps applicable to this bot in this channel. The caller
   * iterates this list and calls `observeMessage` per pin on each non-dot
   * event. Cheap: one sync read + N small YAML parses (N ≈ number of pinned
   * sleeps, usually 0 or 1).
   */
  sleepPinsForBot(channelId: string): string[] {
    const pins = this.connector.getCachedPinnedSleeps(channelId) ?? []
    const identity = this.getBotIdentity()
    const out: string[] = []
    for (const pin of pins) {
      if (parseSleepMessage(pin.content, identity)) {
        out.push(pin.id)
      }
    }
    return out
  }

  /**
   * Is this channel currently sleeping for this bot? True if ANY active sleep
   * pin applies.
   */
  isSleeping(channelId: string, now: number): boolean {
    const pins = this.connector.getCachedPinnedSleeps(channelId) ?? []
    const identity = this.getBotIdentity()
    for (const pin of pins) {
      const parsed = parseSleepMessage(pin.content, identity)
      if (!parsed) continue
      if (isSleepActive(parsed, this.getCount(channelId, pin.id), now)) return true
    }
    return false
  }
}
