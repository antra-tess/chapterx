import { describe, it, expect } from 'vitest'
import type { PortalMessage, PortalEvent } from '@animalabs/portal-protocol'
import { inboundFromPortal, queueEventFromPortal, authorOfMessage, containerOf, type AdapterCtx } from './adapters.js'

const BOT = 'persona_bot'

function pm(over: Partial<PortalMessage> = {}): PortalMessage {
  return {
    id: 'rm_chan_100',
    nativeId: '100',
    channelId: 'chan',
    guildId: 'guild',
    author: { kind: 'user', userId: 'u1', username: 'alice', displayName: 'Alice', bot: false },
    content: 'hello',
    cleanContent: 'hello',
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...over,
  }
}

const ctx: AdapterCtx = {
  botPersonaId: BOT,
  authorOf: (id) => (id === 'rm_chan_100' ? 'u1' : undefined),
  guildOf: () => 'guild',
}

describe('authorOfMessage', () => {
  it('maps persona/user/system kinds', () => {
    expect(authorOfMessage(pm({ author: { kind: 'persona', personaId: 'p9', displayName: 'Mythos', avatarUrl: '' } }))).toEqual({
      id: 'p9',
      username: 'Mythos',
      bot: true,
      globalName: 'Mythos',
    })
    expect(authorOfMessage(pm()).id).toBe('u1')
    expect(authorOfMessage(pm()).bot).toBe(false)
    expect(authorOfMessage(pm({ author: { kind: 'system' } }))).toEqual({ id: 'system', username: 'system', bot: true })
  })
})

describe('containerOf', () => {
  it('prefers threadId', () => {
    expect(containerOf({ channelId: 'c', threadId: 't' })).toBe('t')
    expect(containerOf({ channelId: 'c' })).toBe('c')
  })
})

describe('inboundFromPortal', () => {
  it('builds a discord.js-ish object', () => {
    const m = inboundFromPortal(pm(), BOT)
    expect(m.id).toBe('rm_chan_100')
    expect(m.channelId).toBe('chan')
    expect(m.author.id).toBe('u1')
    expect(m.system).toBe(false)
    expect(m.reference).toBeUndefined()
  })

  it('mentions.has() is true for a persona role-mention (→ bot mentioned)', () => {
    const m = inboundFromPortal(pm({ mentions: { personas: [BOT], roles: [], users: [], everyone: false } }), BOT)
    expect(m.mentions.has(BOT)).toBe(true)
    expect(m.mentions.has('someone-else')).toBe(false)
  })

  it('mentions.has() is true for a direct user mention', () => {
    const m = inboundFromPortal(pm({ mentions: { personas: [], roles: [], users: ['u42'], everyone: false } }), BOT)
    expect(m.mentions.has('u42')).toBe(true)
  })

  it('reply maps replyToId → reference.messageId', () => {
    const m = inboundFromPortal(pm({ replyToId: 'rm_chan_50' }), BOT)
    expect(m.reference?.messageId).toBe('rm_chan_50')
  })

  it('threaded message uses threadId as channelId', () => {
    const m = inboundFromPortal(pm({ threadId: 'thread1' }), BOT)
    expect(m.channelId).toBe('thread1')
  })

  it('reactions.cache.some sees the eye emoji by name', () => {
    const m = inboundFromPortal(pm({ reactions: [{ emoji: '👁‍🗨', count: 1, kind: 'native', by: [] }] }), BOT)
    const hit = m.reactions!.cache.some((r: any) => r.emoji?.name === '👁‍🗨')
    expect(hit).toBe(true)
  })

  it('system author sets system flag', () => {
    const m = inboundFromPortal(pm({ author: { kind: 'system' } }), BOT)
    expect(m.system).toBe(true)
  })

  it('event.data is mutable (loop sets _isMCommand)', () => {
    const m = inboundFromPortal(pm(), BOT) as any
    m._isMCommand = true
    expect(m._isMCommand).toBe(true)
  })
})

describe('queueEventFromPortal', () => {
  it('message_create → message event', () => {
    const e: PortalEvent = { type: 'message_create', message: pm(), addressedToMe: false, reasons: [] }
    const ev = queueEventFromPortal(e, ctx)!
    expect(ev.type).toBe('message')
    expect(ev.channelId).toBe('chan')
    expect(ev.guildId).toBe('guild')
    expect(ev.data.id).toBe('rm_chan_100')
    expect(ev.timestamp instanceof Date).toBe(true)
  })

  it('message_update → edit event with {old:undefined,new}', () => {
    const e: PortalEvent = { type: 'message_update', message: pm({ content: 'edited' }), addressedToMe: false, reasons: [] }
    const ev = queueEventFromPortal(e, ctx)!
    expect(ev.type).toBe('edit')
    expect(ev.data.old).toBeUndefined()
    expect(ev.data.new.content).toBe('edited')
  })

  it('message_delete → delete event, resolves author from ctx', () => {
    const e: PortalEvent = { type: 'message_delete', channelId: 'chan', messageId: 'rm_chan_100' }
    const ev = queueEventFromPortal(e, ctx)!
    expect(ev.type).toBe('delete')
    expect(ev.data.id).toBe('rm_chan_100')
    expect(ev.data.author.id).toBe('u1')
  })

  it('message_delete → author "unknown" when unresolved', () => {
    const e: PortalEvent = { type: 'message_delete', channelId: 'chan', messageId: 'rm_chan_999' }
    const ev = queueEventFromPortal(e, ctx)!
    expect(ev.data.author.id).toBe('unknown')
  })

  it('reaction_add → reaction event with reactor + author', () => {
    const e: PortalEvent = {
      type: 'reaction_add',
      channelId: 'chan',
      messageId: 'rm_chan_100',
      reaction: { emoji: '✅', count: 1, kind: 'native', by: [{ kind: 'user', id: 'u7', name: 'bob' }] },
    }
    const ev = queueEventFromPortal(e, ctx)!
    expect(ev.type).toBe('reaction')
    expect(ev.data.messageId).toBe('rm_chan_100')
    expect(ev.data.emoji).toBe('✅')
    expect(ev.data.userId).toBe('u7')
    expect(ev.data.messageAuthorId).toBe('u1')
  })

  it('reaction_add with no known reactor → null (unattributable)', () => {
    const e: PortalEvent = {
      type: 'reaction_add',
      channelId: 'chan',
      messageId: 'rm_chan_100',
      reaction: { emoji: '✅', count: 1, kind: 'native', by: [] },
    }
    expect(queueEventFromPortal(e, ctx)).toBeNull()
  })

  it('reaction_remove / typing / structural events → null', () => {
    expect(queueEventFromPortal({ type: 'reaction_remove', channelId: 'c', messageId: 'm', emoji: 'x', actor: { kind: 'user', id: 'u', name: 'n' } }, ctx)).toBeNull()
    expect(queueEventFromPortal({ type: 'typing', channelId: 'c', author: { kind: 'system' } }, ctx)).toBeNull()
    expect(queueEventFromPortal({ type: 'pins_update', channelId: 'c' }, ctx)).toBeNull()
  })

  it('thread message_create uses threadId as event channelId', () => {
    const e: PortalEvent = { type: 'message_create', message: pm({ threadId: 'thr' }), addressedToMe: false, reasons: [] }
    const ev = queueEventFromPortal(e, ctx)!
    expect(ev.channelId).toBe('thr')
  })
})
