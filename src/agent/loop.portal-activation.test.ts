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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PortalEvent, PortalMessage } from '@animalabs/portal-protocol'
import { AgentLoop } from './loop.js'
import { EventQueue } from './event-queue.js'
import { queueEventFromPortal, type AdapterCtx } from '../connector/portal/adapters.js'
import { PortalConnector } from '../connector/portal/portal-connector.js'

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

function fakeConnector(depth = 0) {
  return {
    isPortal: () => true,
    getCachedPinnedConfigs: () => null,
    getBotReplyChainDepth: vi.fn(async () => depth),
    addReaction: vi.fn(async () => undefined),
  }
}

/** shouldActivate on a loop that has only the fields it reads. */
function makeLoop(connector: unknown) {
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
  return (events: unknown[]) => (loop as any).shouldActivate(events, 'chan', 'guild') as Promise<boolean>
}

describe('shouldActivate for portal events', () => {
  it('a reply the relay addresses to the persona wakes the bot through the mention path', async () => {
    const c = fakeConnector(0)
    const ev = event(pm({ replyToId: 'rm_chan_150' }), true, ['reply'])

    expect(await makeLoop(c)([ev])).toBe(true)
    expect(c.getBotReplyChainDepth).toHaveBeenCalledTimes(1)
  })

  it('the mention path\'s reply-chain limit applies to such a reply', async () => {
    const c = fakeConnector(2)
    const ev = event(pm({ replyToId: 'rm_chan_150' }), true, ['reply'])

    expect(await makeLoop(c)([ev])).toBe(false)
    expect(c.addReaction).toHaveBeenCalledWith('chan', 'rm_chan_200', '🔗')
  })

  it('an m command sent as a reply to the persona is ours, even after a restart', async () => {
    const ev = event(pm({ replyToId: 'rm_chan_150', content: 'm continue', cleanContent: 'm continue' }), true, ['reply'])

    expect(await makeLoop(fakeConnector(0))([ev])).toBe(true)
    expect((ev.data as any)._isMCommand).toBe(true)
  })

  it('ambient traffic doesn\'t wake the bot', async () => {
    const ev = event(pm(), false, ['subscription'])

    expect(await makeLoop(fakeConnector(0))([ev])).toBe(false)
  })

  it('with the real portal connector, a human\'s reply under a bot exchange still wakes the bot', async () => {
    // The persona's message answered bot A, which answered a human; a human now
    // replies to the persona. The chain walk starts at the human's reply, so the
    // limit (2 here) doesn't refuse it.
    const tmpCache = mkdtempSync(join(tmpdir(), 'loop-portal-activation-'))
    try {
      const connector = new PortalConnector(new EventQueue(), {
        url: 'ws://relay.invalid', token: 't', personaId: PERSONA, cacheDir: tmpCache,
      })
      const history = [
        pm({ id: 'rm_chan_1', nativeId: '1' }),
        pm({ id: 'rm_chan_2', nativeId: '2', replyToId: 'rm_chan_1', author: { kind: 'user', userId: 'a1', username: 'a', displayName: 'A', bot: true } }),
        pm({ id: 'rm_chan_3', nativeId: '3', replyToId: 'rm_chan_2', author: { kind: 'persona', personaId: PERSONA, displayName: 'p', avatarUrl: '' } }),
      ]
      ;(connector as any).client = {
        fetchHistory: vi.fn(async () => ({ messages: history })),
        react: vi.fn(async () => undefined),
      }
      const ev = event(pm({ id: 'rm_chan_4', nativeId: '4', replyToId: 'rm_chan_3' }), true, ['reply'])

      expect(await makeLoop(connector)([ev])).toBe(true)
    } finally {
      rmSync(tmpCache, { recursive: true, force: true })
    }
  })
})

describe('somaBotKey', () => {
  it('keys a portal persona by its EMS bot name and an account bot by its Discord user id', () => {
    const loop = Object.create(AgentLoop.prototype)
    Object.assign(loop, { botId: 'glm52', botUserId: '123456789012345678', connector: { isPortal: () => true } })
    expect((loop as any).somaBotKey()).toBe('glm52')
    loop.connector = { isPortal: () => false }
    expect((loop as any).somaBotKey()).toBe('123456789012345678')
  })
})

describe('processBatch: an m continue refused on the portal backend', () => {
  it('stays refused when the relay fails the reaction that marks it', async () => {
    // The bot doesn't support continuation and its own message is the last one,
    // so the loop deletes the `m continue` and marks the refusal with a reaction
    // on the latest message. Here the relay fails that fetch.
    const tmpCache = mkdtempSync(join(tmpdir(), 'loop-portal-refusal-'))
    try {
      const connector = new PortalConnector(new EventQueue(), {
        url: 'ws://relay.invalid', token: 't', personaId: PERSONA, cacheDir: tmpCache,
      })
      const personaMessage = pm({
        id: 'rm_chan_150', nativeId: '150',
        author: { kind: 'persona', personaId: PERSONA, displayName: 'p', avatarUrl: '' },
      })
      const client = {
        call: vi.fn(async () => ({ messages: [] })), // list_pins: no pins
        fetchHistory: vi.fn(async (p: { before?: string }) => {
          if (p.before === undefined) throw new Error('relay timeout') // reactToLatestMessage's fetch
          return { messages: [personaMessage] } // getMessageBefore: the persona spoke last
        }),
        deleteMessage: vi.fn(async () => undefined),
        react: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ messageId: 'rm_chan_999' })),
      }
      ;(connector as any).client = client
      const loop = Object.create(AgentLoop.prototype)
      Object.assign(loop, {
        botId: 'glm52',
        botUserId: PERSONA,
        botMessageIds: new Set<string>(),
        connector,
        configSystem: {
          loadConfig: () => ({
            max_bot_reply_chain_depth: 2,
            bot_reply_chain_depth_emote: '🔗',
            reply_on_random: 0,
            supports_continuation: false,
          }),
        },
        sleepState: { sleepPinsForBot: () => [], isSleeping: () => false, observeMessage: () => undefined },
      })
      const ev = event(
        pm({ id: 'rm_chan_200', nativeId: '200', replyToId: 'rm_chan_150', content: 'm continue', cleanContent: 'm continue' }),
        true,
        ['reply'],
      )

      await (loop as any).processBatch([ev])

      expect(client.deleteMessage).toHaveBeenCalledTimes(1) // the refused command, once
      expect(client.sendMessage).not.toHaveBeenCalled() // no continuation was sent
    } finally {
      rmSync(tmpCache, { recursive: true, force: true })
    }
  })
})
