/**
 * Tests for fetching the members of a context's authors, so labels that use
 * display names can carry server nicknames.
 *
 * Run with: npx vitest run member-names
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { Message } from 'discord.js'
import { AuthorMembers, displayNameClasses } from './member-names.js'
import { logger } from '../utils/logger.js'

const GUILD_ID = '800000000000000001'

type Outcome = 'found' | 'not-member' | 'unknown-user' | 'error' | 'hang' | 'late' | 'late-error'

/**
 * As in discord.js 14, a fetched member is added to the guild's member cache,
 * and a message's `member` resolves its author there.
 */
function guild(outcomes: Record<string, Outcome> = {}) {
  const calls: string[] = []
  const cache = new Map<string, { id: string; nickname: string }>()
  return {
    calls,
    cache,
    id: GUILD_ID,
    members: {
      resolve: (user: { id: string }) => cache.get(user.id) ?? null,
      fetch: async (userId: string) => {
        calls.push(userId)
        const outcome = outcomes[userId] ?? 'found'
        if (outcome === 'hang') return new Promise(() => {})
        // A round trip; a late one settles after a context's 3-second wait.
        const late = outcome === 'late' || outcome === 'late-error'
        await new Promise((resolve) => setTimeout(resolve, late ? 5_000 : 1))
        if (outcome === 'not-member') throw Object.assign(new Error('Unknown Member'), { code: 10007 })
        if (outcome === 'unknown-user') throw Object.assign(new Error('Unknown User'), { code: 10013 })
        if (outcome === 'error' || outcome === 'late-error') throw new Error('socket hang up')
        const member = { id: userId, nickname: `Nick ${userId}` }
        cache.set(userId, member)
        return member
      },
    },
  }
}

type FakeGuild = ReturnType<typeof guild>

function msg(authorId: string, g: FakeGuild | null, opts: { bot?: boolean; webhook?: boolean } = {}): Message {
  const author = { id: authorId, bot: opts.bot ?? false }
  return {
    guild: g,
    webhookId: opts.webhook ? '600000000000000001' : null,
    author,
    get member() {
      return g ? g.members.resolve(author) : null
    },
  } as unknown as Message
}

const humans = { bots: false, humans: true }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AuthorMembers', () => {
  it("fetches each author's missing member once, for the classes labelled by display name", async () => {
    const g = guild()
    await new AuthorMembers().cacheFor([msg('1', g), msg('1', g), msg('2', g), msg('3', g, { bot: true })], humans)
    expect(g.calls.sort()).toEqual(['1', '2'])

    const both = guild()
    await new AuthorMembers().cacheFor([msg('1', both), msg('3', both, { bot: true })], { bots: true, humans: true })
    expect(both.calls.sort()).toEqual(['1', '3'])

    const bots = guild()
    await new AuthorMembers().cacheFor([msg('1', bots), msg('3', bots, { bot: true })], { bots: true, humans: false })
    expect(bots.calls).toEqual(['3'])
  })

  it('puts the fetched member where the label reads it', async () => {
    const g = guild()
    const m = msg('1', g)
    expect(m.member).toBeNull()
    await new AuthorMembers().cacheFor([m], humans)
    expect(m.member?.nickname).toBe('Nick 1')

    // Cached now, so a later context asks for nothing.
    await new AuthorMembers().cacheFor([msg('1', g)], humans)
    expect(g.calls).toEqual(['1'])
  })

  it('asks for nothing when no class is labelled by display name', async () => {
    const g = guild()
    await new AuthorMembers().cacheFor([msg('1', g), msg('3', g, { bot: true })], { bots: false, humans: false })
    expect(g.calls).toEqual([])
  })

  it('leaves out cached members, webhook messages and DMs', async () => {
    const g = guild()
    g.cache.set('1', { id: '1', nickname: 'Cached' })
    await new AuthorMembers().cacheFor([msg('1', g), msg('2', g, { webhook: true }), msg('4', null)], { bots: true, humans: true })
    expect(g.calls).toEqual([])
  })

  it('leaves a non-member alone for 30 minutes, and an author whose fetch failed otherwise for a minute', async () => {
    let now = 1_000
    const members = new AuthorMembers({ now: () => now })
    const g = guild({ '1': 'not-member', '2': 'unknown-user', '3': 'error' })
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const messages = [msg('1', g), msg('2', g), msg('3', g)]

    await members.cacheFor(messages, humans)
    expect(g.calls.sort()).toEqual(['1', '2', '3'])
    // Discord's not-a-member answers are debug lines; any other failure is a warning.
    expect(debug.mock.calls.map(([context]) => (context as { userId: string }).userId).sort()).toEqual(['1', '2'])
    expect(warn).toHaveBeenCalledTimes(1)
    // Under err, which pino serializes with the error's message.
    expect(warn.mock.calls[0]![0]).toMatchObject({ userId: '3', err: expect.objectContaining({ message: 'socket hang up' }) })

    now += 59_999
    await members.cacheFor(messages, humans)
    expect(g.calls).toHaveLength(3)

    now += 1
    await members.cacheFor(messages, humans)
    expect(g.calls.sort()).toEqual(['1', '2', '3', '3'])

    // Just before the non-members' 30 minutes, only the author that keeps
    // failing otherwise is asked again.
    now = 1_000 + 30 * 60_000 - 1
    await members.cacheFor(messages, humans)
    expect(g.calls.sort()).toEqual(['1', '2', '3', '3', '3'])

    now += 1
    await members.cacheFor(messages, humans)
    expect(g.calls.sort()).toEqual(['1', '1', '2', '2', '3', '3', '3'])
  })

  describe('waiting', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })
    const members = () => new AuthorMembers({ now: () => Date.now() })

    it('waits at most 3 seconds for a fetch, and shares one still running with later contexts', async () => {
      const m = members()
      const g = guild({ '1': 'hang' })
      let done = false
      void m.cacheFor([msg('1', g), msg('2', g)], humans).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
      expect(g.calls.sort()).toEqual(['1', '2'])

      let later = false
      void m.cacheFor([msg('1', g)], humans).then(() => {
        later = true
      })
      await vi.advanceTimersByTimeAsync(0)
      // Past its 3 seconds, a context that joins the fetch doesn't wait for it.
      expect(later).toBe(true)
      expect(g.calls.sort()).toEqual(['1', '2'])
    })

    it("makes a context that joins a running fetch wait only for what is left of its 3 seconds", async () => {
      const m = members()
      const g = guild({ '1': 'hang' })
      void m.cacheFor([msg('1', g)], humans)
      await vi.advanceTimersByTimeAsync(1_000)

      let joined = false
      void m.cacheFor([msg('1', g)], humans).then(() => {
        joined = true
      })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(joined).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(joined).toBe(true)
      expect(g.calls).toEqual(['1'])
    })

    it("waits for each author's fetch only until its own 3 seconds are up, not until another's", async () => {
      const m = members()
      const g = guild({ '1': 'hang' })
      void m.cacheFor([msg('1', g)], humans)
      await vi.advanceTimersByTimeAsync(2_900)

      // Joins 1's fetch 100 ms from its end, and starts 2's, which settles at once.
      let done = false
      void m.cacheFor([msg('1', g), msg('2', g)], humans).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
      expect(g.calls).toEqual(['1', '2'])
    })

    it("leaves no timer behind once a context's fetches have settled", async () => {
      const g = guild()
      const done = members().cacheFor([msg('1', g), msg('2', g)], humans)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(vi.getTimerCount()).toBe(0)
    })

    it('caches a member whose fetch settles after the wait, so the next context asks for nothing', async () => {
      const m = members()
      const g = guild({ '1': 'late' })
      const first = m.cacheFor([msg('1', g)], humans)
      await vi.advanceTimersByTimeAsync(3_000)
      await first
      expect(msg('1', g).member).toBeNull()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(msg('1', g).member?.nickname).toBe('Nick 1')
      await m.cacheFor([msg('1', g)], humans)
      expect(g.calls).toEqual(['1'])
    })

    it('remembers a failure that comes after the wait', async () => {
      const m = members()
      const g = guild({ '1': 'late-error' })
      vi.spyOn(logger, 'warn').mockImplementation(() => logger)
      const first = m.cacheFor([msg('1', g)], humans)
      await vi.advanceTimersByTimeAsync(3_000)
      await first
      await vi.advanceTimersByTimeAsync(2_000)

      // A minute from the failure, not from the context that asked.
      await m.cacheFor([msg('1', g)], humans)
      expect(g.calls).toEqual(['1'])
      await vi.advanceTimersByTimeAsync(59_999)
      await m.cacheFor([msg('1', g)], humans)
      expect(g.calls).toEqual(['1'])
      await vi.advanceTimersByTimeAsync(1)
      void m.cacheFor([msg('1', g)], humans)
      expect(g.calls).toEqual(['1', '1'])
    })
  })
})

describe('displayNameClasses', () => {
  it("uses the context builder's defaults: bots by display name, humans by username", () => {
    expect(displayNameClasses({})).toEqual({ bots: true, humans: false })
    expect(displayNameClasses({ use_display_names: true })).toEqual({ bots: true, humans: true })
    expect(displayNameClasses({ use_display_names: false })).toEqual({ bots: false, humans: false })
    expect(displayNameClasses({ use_display_names: false, use_display_names_humans: true })).toEqual({ bots: false, humans: true })
  })

  it('lets use_display_names_bots override use_display_names for bots alone', () => {
    expect(displayNameClasses({ use_display_names_bots: false })).toEqual({ bots: false, humans: false })
    expect(displayNameClasses({ use_display_names: true, use_display_names_bots: false })).toEqual({ bots: false, humans: true })
    expect(displayNameClasses({ use_display_names: false, use_display_names_bots: true })).toEqual({ bots: true, humans: false })
  })
})
