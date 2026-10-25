import * as YAML from 'yaml'
import { logger } from '../utils/logger.js'
import type { TrackedPin } from '../discord/connector.js'
import { pinAddressesBot, type BotIdentity } from './pin-target.js'

export type { BotIdentity } from './pin-target.js'

export interface ParsedSleep {
  startedAt: number
  durationSeconds?: number
  messages?: number
  reason?: string
}

export interface SleepConnectorLike {
  getCachedPinnedSleeps(channelId: string): TrackedPin[] | null
  getOwnRoleIds(channelId: string): string[] | null
}

export function parseSleepMessage(
  content: string,
  identity: BotIdentity,
  mentions?: { mentionedPersonaIds?: readonly string[]; mentionedRoleIds?: readonly string[] },
  ownRoleIds?: readonly string[],
): ParsedSleep | null {
  if (!content.startsWith('.sleep')) return null

  const lines = content.split('\n')
  if (lines.length < 3 || lines[1] !== '---') return null

  const rawTarget = lines[0]!.slice('.sleep'.length).trim()

  if (!pinAddressesBot(
    {
      targetText: rawTarget.length > 0 ? rawTarget : undefined,
      mentionedPersonaIds: mentions?.mentionedPersonaIds,
      mentionedRoleIds: mentions?.mentionedRoleIds,
    },
    identity,
    ownRoleIds,
  )) {
    return null
  }

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

  const startedAtRaw = obj.started_at
  if (typeof startedAtRaw !== 'string') return null
  const startedAt = Date.parse(startedAtRaw)
  if (Number.isNaN(startedAt)) return null

  const durationSeconds =
    typeof obj.duration_seconds === 'number' && obj.duration_seconds > 0
      ? obj.duration_seconds
      : undefined

  const messages =
    typeof obj.messages === 'number' && obj.messages > 0 && Number.isFinite(obj.messages)
      ? Math.floor(obj.messages)
      : undefined

  if (durationSeconds === undefined && messages === undefined) return null

  const reason = typeof obj.reason === 'string' ? obj.reason : undefined

  return { startedAt, durationSeconds, messages, reason }
}

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

  sleepPinsForBot(channelId: string): string[] {
    const pins = this.connector.getCachedPinnedSleeps(channelId) ?? []
    const identity = this.getBotIdentity()
    const ownRoleIds = this.connector.getOwnRoleIds(channelId) ?? undefined
    const out: string[] = []
    for (const pin of pins) {
      if (parseSleepMessage(pin.content, identity, pin, ownRoleIds)) {
        out.push(pin.id)
      }
    }
    return out
  }

  isSleeping(channelId: string, now: number): boolean {
    const pins = this.connector.getCachedPinnedSleeps(channelId) ?? []
    const identity = this.getBotIdentity()
    const ownRoleIds = this.connector.getOwnRoleIds(channelId) ?? undefined
    for (const pin of pins) {
      const parsed = parseSleepMessage(pin.content, identity, pin, ownRoleIds)
      if (!parsed) continue
      if (isSleepActive(parsed, this.getCount(channelId, pin.id), now)) return true
    }
    return false
  }
}
