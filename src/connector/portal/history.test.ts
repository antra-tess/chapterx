import { describe, it, expect } from 'vitest'
import type { PortalMessage } from '@animalabs/portal-protocol'
import { fetchPortalHistory, snowflakeFromId, type PortalFetchDeps, type PortalChannelRef } from './history.js'

/** Build a PortalMessage with snowflake `nativeId` and relay id `rm_<chan>_<sf>`. */
function msg(chan: string, sf: string, content = 'hi', over: Partial<PortalMessage> = {}): PortalMessage {
  return {
    id: `rm_${chan}_${sf}`,
    nativeId: sf,
    channelId: chan,
    guildId: 'g',
    author: { kind: 'user', userId: 'u', username: 'alice', displayName: 'Alice', bot: false },
    content,
    cleanContent: content,
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...over,
  }
}

/** In-memory deps: channels → messages (any order; sorted internally). */
function makeDeps(
  channels: Record<string, PortalMessage[]>,
  opts: { natives?: Record<string, string>; botPersonaId?: string } = {},
): PortalFetchDeps {
  const sf = (m: PortalMessage) => BigInt(m.nativeId)
  return {
    botPersonaId: opts.botPersonaId ?? 'bot',
    async fetchBatch(channelId, { before, limit }) {
      const all = [...(channels[channelId] ?? [])].sort((a, b) => (sf(a) > sf(b) ? -1 : 1)) // newest-first
      const filtered = before ? all.filter((m) => sf(m) < BigInt(before)) : all
      return filtered.slice(0, limit)
    },
    async fetchSingle(channelId, snowflake) {
      return (channels[channelId] ?? []).find((m) => m.nativeId === snowflake) ?? null
    },
    async resolveChannelBySnowflake(snowflake): Promise<PortalChannelRef | null> {
      const natives = opts.natives ?? {}
      const chan = Object.keys(natives).find((c) => natives[c] === snowflake)
      return chan ? { id: chan, isTextBased: true } : null
    },
    async authorRoles() {
      return null
    },
  }
}

const ids = (r: { messages: PortalMessage[] }) => r.messages.map((m) => m.nativeId)

describe('snowflakeFromId', () => {
  it('extracts snowflake from a relay id and passes through raw snowflakes', () => {
    expect(snowflakeFromId('rm_chan_12345')).toBe('12345')
    expect(snowflakeFromId('98765')).toBe('98765')
    expect(snowflakeFromId('rm_thread99_777')).toBe('777')
  })
})

describe('fetchPortalHistory', () => {
  it('returns chronological order (oldest first)', async () => {
    const deps = makeDeps({ c: [msg('c', '100'), msg('c', '200'), msg('c', '300')] })
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], false, deps)
    expect(ids(r)).toEqual(['100', '200', '300'])
    expect(r.didClear).toBe(false)
  })

  it('respects the maxMessages cap (keeps newest)', async () => {
    const deps = makeDeps({ c: ['100', '200', '300', '400'].map((s) => msg('c', s)) })
    const r = await fetchPortalHistory('c', undefined, undefined, 2, [], false, deps)
    expect(ids(r)).toEqual(['300', '400'])
  })

  it('drops relay system messages', async () => {
    const deps = makeDeps({
      c: [msg('c', '100'), msg('c', '200', '', { author: { kind: 'system' } }), msg('c', '300')],
    })
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], false, deps)
    expect(ids(r)).toEqual(['100', '300'])
  })

  it('.history (bare) clears — returns only newer messages', async () => {
    const deps = makeDeps({
      c: [msg('c', '100'), msg('c', '200', '.history'), msg('c', '300'), msg('c', '400')],
    })
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], false, deps)
    expect(ids(r)).toEqual(['300', '400'])
    expect(r.didClear).toBe(true)
  })

  it('.history range pulls a linked range + newer messages (same channel)', async () => {
    // URLs carry the Discord channel SNOWFLAKE (native), resolved back to 'c'.
    const last = 'https://discord.com/channels/1/5000/250'
    const first = 'https://discord.com/channels/1/5000/150'
    const deps = makeDeps(
      {
        c: [
          msg('c', '100'),
          msg('c', '150'),
          msg('c', '200'),
          msg('c', '250'),
          msg('c', '300', `.history\n---\nfirst: ${first}\nlast: ${last}`),
          msg('c', '400'),
        ],
      },
      { natives: { c: '5000' } },
    )
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], false, deps)
    // range [150..250] then messages newer than the .history (400)
    expect(ids(r)).toEqual(['150', '200', '250', '400'])
    expect(r.didClear).toBe(true)
    expect(r.originChannelId).toBe('c')
  })

  it('.history range resolves a cross-channel link by native snowflake', async () => {
    const last = 'https://discord.com/channels/1/9999/250'
    const deps = makeDeps(
      {
        cur: [msg('cur', '300', `.history\n---\nlast: ${last}`), msg('cur', '400')],
        other: [msg('other', '200'), msg('other', '250'), msg('other', '300')],
      },
      { natives: { other: '9999' } },
    )
    const r = await fetchPortalHistory('cur', undefined, undefined, 50, [], false, deps)
    // everything up to & including 250 in `other`, then newer-than-.history in cur (400)
    expect(ids(r)).toEqual(['200', '250', '400'])
    expect(r.originChannelId).toBe('cur')
  })

  it('.history range treats an unresolvable channel as clear', async () => {
    const last = 'https://discord.com/channels/1/9999/250'
    const deps = makeDeps({ cur: [msg('cur', '300', `.history\n---\nlast: ${last}`), msg('cur', '400')] })
    const r = await fetchPortalHistory('cur', undefined, undefined, 50, [], false, deps)
    expect(ids(r)).toEqual(['400'])
    expect(r.didClear).toBe(true)
  })

  it('skips a .history targeted at a different persona', async () => {
    const deps = makeDeps(
      { c: [msg('c', '100'), msg('c', '200', '.history', { mentions: { personas: ['other-bot'], roles: [], users: [], everyone: false } }), msg('c', '300')] },
      { botPersonaId: 'bot' },
    )
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], false, deps)
    // targeting another persona → the .history is ignored, all messages kept
    expect(ids(r)).toEqual(['100', '300'])
    expect(r.didClear).toBe(false)
  })

  it('applies a .history targeted at us (our persona mention)', async () => {
    const deps = makeDeps(
      { c: [msg('c', '100'), msg('c', '200', '.history', { mentions: { personas: ['bot'], roles: [], users: [], everyone: false } }), msg('c', '300')] },
      { botPersonaId: 'bot' },
    )
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], false, deps)
    expect(ids(r)).toEqual(['300'])
    expect(r.didClear).toBe(true)
  })

  it('skips .history when authorizedRoles set but roles unverifiable (P2 deps return null)', async () => {
    const deps = makeDeps({ c: [msg('c', '100'), msg('c', '200', '.history'), msg('c', '300')] })
    const r = await fetchPortalHistory('c', undefined, undefined, 50, ['admin'], false, deps)
    // unauthorized/unverifiable → .history ignored, all kept
    expect(ids(r)).toEqual(['100', '300'])
  })

  it('ignoreHistory bypasses .history processing entirely', async () => {
    const deps = makeDeps({ c: [msg('c', '100'), msg('c', '200', '.history'), msg('c', '300')] })
    const r = await fetchPortalHistory('c', undefined, undefined, 50, [], true, deps)
    expect(ids(r)).toEqual(['100', '200', '300'])
  })

  it('startFrom includes the boundary message and fetches backward', async () => {
    const deps = makeDeps({ c: ['100', '200', '300', '400'].map((s) => msg('c', s)) })
    const r = await fetchPortalHistory('c', '300', undefined, 50, [], false, deps)
    // from 300 backward (inclusive): 100,200,300 — not 400
    expect(ids(r)).toEqual(['100', '200', '300'])
  })
})
