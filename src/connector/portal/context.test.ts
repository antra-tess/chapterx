import { describe, it, expect, vi } from 'vitest'
import type { PortalMessage } from '@animalabs/portal-protocol'
import { portalMessageToDiscordMessage, buildPortalContext, type ContextDeps } from './context.js'

function pm(over: Partial<PortalMessage> = {}): PortalMessage {
  return {
    id: 'rm_chan_100',
    nativeId: '100',
    channelId: 'chan',
    guildId: 'guild',
    author: { kind: 'user', userId: 'u1', username: 'alice', displayName: 'Alice', bot: false },
    content: 'hi',
    cleanContent: 'hi',
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...over,
  }
}
const noMap = new Map<string, PortalMessage>()

describe('portalMessageToDiscordMessage — strip portal- role prefix', () => {
  it('strips the portal- prefix from a resolved role mention', () => {
    const d = portalMessageToDiscordMessage(pm({ cleanContent: '@portal-glm52 hey' }), noMap)
    expect(d.content).toBe('@glm52 hey')
  })

  it('strips every portal- mention and preserves the rest', () => {
    const d = portalMessageToDiscordMessage(
      pm({ cleanContent: 'ping @portal-nemotron-3-ultra and @portal-Fugu, cc @alice' }),
      noMap,
    )
    expect(d.content).toBe('ping @nemotron-3-ultra and @Fugu, cc @alice')
  })

  it('leaves ordinary (non-portal) mentions untouched', () => {
    const d = portalMessageToDiscordMessage(pm({ cleanContent: 'hey @alice and @bob' }), noMap)
    expect(d.content).toBe('hey @alice and @bob')
  })

  it('is a no-op on raw <@&id> content (no cleanContent)', () => {
    const d = portalMessageToDiscordMessage(pm({ cleanContent: '', content: '<@&123> hi' }), noMap)
    expect(d.content).toBe('<@&123> hi')
  })
})

/** buildPortalContext's dependencies over one channel's messages, served by
 *  snowflake as fetch_history does. */
function depsOver(all: PortalMessage[], known: Record<string, string> = {}) {
  const fetchBatch = vi.fn(async (_ch: string, opts: { before?: string; limit: number }) =>
    all
      .filter((m) => opts.before === undefined || BigInt(m.nativeId) < BigInt(opts.before))
      .sort((a, b) => (BigInt(b.nativeId) > BigInt(a.nativeId) ? 1 : -1))
      .slice(0, opts.limit),
  )
  const fetchSingle = vi.fn(async (_ch: string, snowflake: string) => all.find((m) => m.nativeId === snowflake) ?? null)
  const deps: ContextDeps = {
    botPersonaId: 'persona-p',
    fetchBatch,
    fetchSingle,
    resolveChannelBySnowflake: async () => null,
    authorRoles: async () => null,
    channelMeta: () => ({ guildId: 'guild', isThread: false }),
    snowflakeOf: (id) => (/^\d+$/.test(id) ? id : known[id]),
    attachments: {} as ContextDeps['attachments'],
  }
  return { deps, fetchBatch, fetchSingle }
}

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => pm({ id: `rm_chan_${from + i}`, nativeId: String(from + i) }))

describe('buildPortalContext and message ids', () => {
  it('starts from a target given as a Discord snowflake, as the API passes one', async () => {
    const { deps, fetchSingle } = depsOver(numbered(1, 20))
    const ctx = await buildPortalContext({ channelId: 'chan', depth: 5, targetMessageId: '10' }, deps)

    expect(fetchSingle).toHaveBeenCalledWith('chan', '10')
    expect(ctx.messages.map((m) => m.nativeId)).toEqual(['6', '7', '8', '9', '10'])
  })

  it('extends back to an anchor whose snowflake it knows, and trims to it', async () => {
    const { deps } = depsOver(numbered(1, 30), { rm_chan_15: '15' })
    const ctx = await buildPortalContext({ channelId: 'chan', depth: 10, firstMessageId: 'rm_chan_15' }, deps)

    expect(ctx.messages[0]!.id).toBe('rm_chan_15')
    expect(ctx.inheritanceInfo?.cacheAnchorTrimmed).toBe(true)
  })

  it('leaves an anchor it can\'t date alone, rather than parse the relay id', async () => {
    // rm_chan_15 is outside the window and wasn't seen by this process.
    const { deps, fetchBatch } = depsOver(numbered(1, 30))
    const ctx = await buildPortalContext({ channelId: 'chan', depth: 10, firstMessageId: 'rm_chan_15' }, deps)

    expect(fetchBatch).toHaveBeenCalledTimes(1)
    expect(ctx.messages[0]!.nativeId).toBe('21')
    expect(ctx.inheritanceInfo?.cacheAnchorTrimmed).toBeUndefined()
  })

  it('gives each converted message its snowflake beside the relay id', async () => {
    const d = portalMessageToDiscordMessage(pm({ id: 'rm_chan_42', nativeId: '42' }), noMap)
    expect(d.id).toBe('rm_chan_42')
    expect(d.nativeId).toBe('42')
  })
})

describe('portalMessageToDiscordMessage reply prefix', () => {
  const alice = pm({ id: 'rm_chan_1', nativeId: '1' })
  const map = new Map([[alice.id, alice]])

  it('prefixes a human\'s reply with the name of the author it answers', () => {
    const reply = pm({ id: 'rm_chan_2', nativeId: '2', cleanContent: 'agreed', replyToId: 'rm_chan_1', author: { kind: 'user', userId: 'u2', username: 'bob', displayName: 'Bob', bot: false } })
    expect(portalMessageToDiscordMessage(reply, map).content).toBe('<reply:@alice> agreed')
  })

  it('names "someone" when the message it answers isn\'t in the context', () => {
    const reply = pm({ id: 'rm_chan_2', nativeId: '2', cleanContent: 'agreed', replyToId: 'rm_chan_99' })
    expect(portalMessageToDiscordMessage(reply, map).content).toBe('<reply:@someone> agreed')
  })

  it('leaves a bot\'s reply unprefixed', () => {
    const reply = pm({ id: 'rm_chan_2', nativeId: '2', cleanContent: 'ok', replyToId: 'rm_chan_1', author: { kind: 'persona', personaId: 'p', displayName: 'p', avatarUrl: '' } })
    expect(portalMessageToDiscordMessage(reply, map).content).toBe('ok')
  })
})

describe('buildPortalContext in a thread', () => {
  it('extends from the parent channel when the window\'s oldest message is the starter or older', async () => {
    // Thread 'thr' was started from parent message 50; the anchor is parent message 10.
    const parent = numbered(1, 50).map((m) => ({ ...m, id: `rm_par_${m.nativeId}`, channelId: 'par' }))
    const thread = [pm({ id: 'rm_thr_60', nativeId: '60', channelId: 'par', threadId: 'thr' })]
    const byChannel: Record<string, PortalMessage[]> = { par: parent, thr: thread }
    const fetchBatch = vi.fn(async (ch: string, opts: { before?: string; limit: number }) =>
      (byChannel[ch] ?? [])
        .filter((m) => opts.before === undefined || BigInt(m.nativeId) < BigInt(opts.before))
        .sort((a, b) => (BigInt(b.nativeId) > BigInt(a.nativeId) ? 1 : -1))
        .slice(0, opts.limit),
    )
    const deps: ContextDeps = {
      botPersonaId: 'persona-p',
      fetchBatch,
      fetchSingle: async (ch, sf) => (byChannel[ch] ?? []).find((m) => m.nativeId === sf) ?? null,
      resolveChannelBySnowflake: async () => null,
      authorRoles: async () => null,
      channelMeta: (ch) => (ch === 'thr' ? { guildId: 'g', isThread: true, parentId: 'par', native: '50' } : { guildId: 'g', isThread: false }),
      snowflakeOf: (id) => ({ rm_par_10: '10' } as Record<string, string>)[id],
      attachments: {} as ContextDeps['attachments'],
    }
    const ctx = await buildPortalContext({ channelId: 'thr', depth: 6, firstMessageId: 'rm_par_10' }, deps)

    expect(fetchBatch.mock.calls.some(([ch, o]) => ch === 'par' && o.before === '46')).toBe(true)
    expect(ctx.messages[0]!.id).toBe('rm_par_10')
  })
})
