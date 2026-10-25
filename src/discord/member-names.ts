/**
 * Discord sends a message author's member data with live message events only,
 * not with history fetched over REST, and this bot doesn't request the members
 * intent. Without it, a later nickname change reaches the cache when an event
 * carrying their membership arrives: a message, an edit or a reaction of theirs.
 */

import type { Guild, Message } from 'discord.js'
import { logger } from '../utils/logger.js'

/** Discord's codes for a user who isn't (or is no longer) a member. */
const UNKNOWN_MEMBER = 10007
const UNKNOWN_USER = 10013

export interface DisplayNameClasses {
  bots: boolean
  humans: boolean
}

export function displayNameClasses(config: {
  use_display_names?: boolean
  use_display_names_bots?: boolean
  use_display_names_humans?: boolean
}): DisplayNameClasses {
  return {
    bots: config.use_display_names_bots ?? config.use_display_names ?? true,
    humans: config.use_display_names_humans ?? config.use_display_names ?? false,
  }
}

export interface AuthorMembersTiming {
  waitMs: number
  notMemberRetryMs: number
  failureRetryMs: number
  now: () => number
}

const DEFAULT_TIMING: AuthorMembersTiming = {
  waitMs: 3_000,
  notMemberRetryMs: 30 * 60_000,
  failureRetryMs: 60_000,
  now: () => performance.now(),
}

interface PendingFetch {
  done: Promise<void>
  waitUntil: number
}

export class AuthorMembers {
  private readonly timing: AuthorMembersTiming
  private readonly retryAt = new Map<string, number>()
  private readonly pending = new Map<string, PendingFetch>()

  constructor(timing: Partial<AuthorMembersTiming> = {}) {
    this.timing = { ...DEFAULT_TIMING, ...timing }
  }

  /**
   * Fetching a member by id is one REST call, which needs no privileged intent,
   * and discord.js caches what it finds, which is where the label reads it.
   */
  async cacheFor(messages: Message[], classes: DisplayNameClasses): Promise<void> {
    const now = this.timing.now()
    for (const [key, at] of this.retryAt) {
      if (at <= now) this.retryAt.delete(key)
    }

    const fetches = new Map<string, PendingFetch>()
    for (const msg of messages) {
      // An incoming webhook's author is the webhook, not a guild member, and a DM has no guild.
      if (!msg.guild || msg.webhookId || !msg.author) continue
      if (!(msg.author.bot ? classes.bots : classes.humans)) continue
      if (msg.member) continue
      const key = `${msg.guild.id}:${msg.author.id}`
      if (this.retryAt.has(key)) continue
      fetches.set(key, this.pending.get(key) ?? this.fetch(key, msg.guild, msg.author.id, now))
    }
    if (fetches.size === 0) return

    // One past its time is waited for only the millisecond Node gives its
    // shortest timer.
    const timers: ReturnType<typeof setTimeout>[] = []
    await Promise.all([...fetches.values()].map((f) => Promise.race([
      f.done,
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, f.waitUntil - now))
      }),
    ])))
    for (const timer of timers) clearTimeout(timer)
  }

  private fetch(key: string, guild: Guild, userId: string, now: number): PendingFetch {
    const done = guild.members.fetch(userId).then(
      () => undefined,
      (error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code
        const notMember = code === UNKNOWN_MEMBER || code === UNKNOWN_USER
        const retryAfter = notMember ? this.timing.notMemberRetryMs : this.timing.failureRetryMs
        this.retryAt.set(key, this.timing.now() + retryAfter)
        const context = { err: error, guildId: guild.id, userId }
        if (notMember) {
          logger.debug(context, 'An author is not a member; their label goes without a nickname')
        } else {
          logger.warn(context, 'Could not fetch an author\'s member; their label goes without a nickname')
        }
      },
    ).finally(() => {
      this.pending.delete(key)
    })
    const pending = { done, waitUntil: now + this.timing.waitMs }
    this.pending.set(key, pending)
    return pending
  }
}
