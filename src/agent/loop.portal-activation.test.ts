/**
 * The agent loop's activation check (AgentLoop.shouldActivate) for events the
 * portal adapter builds.
 *
 * WHAT THESE PROTECT: on the portal backend a webhook persona can't receive a
 * native reply-ping, so the adapter puts the persona in `mentions` for every
 * message the relay addresses to it. These tests pin that such a reply wakes the
 * bot through the loop's ordinary mention path (with its reply-chain limit), that
 * an `m` command sent as a reply is recognised even when this process didn't send
 * the message it replies to, and that ambient traffic doesn't wake it.
 *
 * The loop is built with Object.create so only the fields shouldActivate reads
 * are set; nothing here starts a connector or loads config from disk.
 *
 * Run with: npm test -- loop.portal-activation
 */

import { describe, it, expect, vi } from 'vitest'
import type { PortalEvent, PortalMessage } from '@animalabs/portal-protocol'
import { AgentLoop } from './loop.js'
import { queueEventFromPortal, type AdapterCtx } from '../connector/portal/adapters.js'

const PERSONA = 'persona-p'

function pm(over: Partial<PortalMessage> = {}): PortalMessage {
  return {
    id: 'rm_chan_200',
    nativeId: '200',
    channelId: 'chan',
    guildId: 'guild',
    author: { kind: 'user', userId: 'u1', username: 'alice', displayName: 'Alice', bot: false },
    content: 'hello there',
    cleanContent: 'hello there',
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt: '2026-10-17T00:00:00.000Z',
    ...over,
  }
}

const ctx: AdapterCtx = { botPersonaId: PERSONA, authorOf: () => undefined, guildOf: () => 'guild' }

function event(message: PortalMessage, addressedToMe: boolean, reasons: string[]) {
  const e = { type: 'message_create', message, addressedToMe, reasons } as PortalEvent
  return queueEventFromPortal(e, ctx)!
}

function makeLoop(depth = 0) {
  const connector = {
    getCachedPinnedConfigs: () => null,
    getBotReplyChainDepth: vi.fn(async () => depth),
    addReaction: vi.fn(async () => undefined),
  }
  const loop = Object.create(AgentLoop.prototype)
  Object.assign(loop, {
    botId: 'glm52',
    botUserId: PERSONA,
    botMessageIds: new Set<string>(), // a fresh process: it sent nothing yet
    connector,
    configSystem: {
      loadConfig: () => ({ max_bot_reply_chain_depth: 2, bot_reply_chain_depth_emote: '🔗', reply_on_random: 0 }),
    },
    sleepState: { sleepPinsForBot: () => [], isSleeping: () => false, observeMessage: () => undefined },
  })
  const shouldActivate = (events: unknown[]) => (loop as any).shouldActivate(events, 'chan', 'guild') as Promise<boolean>
  return { connector, shouldActivate }
}

describe('shouldActivate for portal events', () => {
  it('a reply the relay addresses to the persona wakes the bot through the mention path', async () => {
    const l = makeLoop(0)
    const ev = event(pm({ replyToId: 'rm_chan_150' }), true, ['reply'])

    expect(await l.shouldActivate([ev])).toBe(true)
    expect(l.connector.getBotReplyChainDepth).toHaveBeenCalledTimes(1)
  })

  it('the mention path\'s reply-chain limit applies to such a reply', async () => {
    const l = makeLoop(2)
    const ev = event(pm({ replyToId: 'rm_chan_150' }), true, ['reply'])

    expect(await l.shouldActivate([ev])).toBe(false)
    expect(l.connector.addReaction).toHaveBeenCalledWith('chan', 'rm_chan_200', '🔗')
  })

  it('an m command sent as a reply to the persona is ours, even after a restart', async () => {
    const l = makeLoop(0)
    const ev = event(pm({ replyToId: 'rm_chan_150', content: 'm continue', cleanContent: 'm continue' }), true, ['reply'])

    expect(await l.shouldActivate([ev])).toBe(true)
    expect((ev.data as any)._isMCommand).toBe(true)
  })

  it('ambient traffic doesn\'t wake the bot', async () => {
    const l = makeLoop(0)
    const ev = event(pm(), false, ['subscription'])

    expect(await l.shouldActivate([ev])).toBe(false)
  })
})
