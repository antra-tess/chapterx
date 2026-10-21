/**
 * What every message the bot sends, and every edit of its own messages, may
 * ping: the people its text mentions, and never a role, @everyone or @here.
 * The connector's client gives that as discord.js's `allowedMentions` default,
 * which a send, or an edit of the bot's own message, takes when its options
 * give none. (discord.js sends none for an edit of someone else's message,
 * which the connector never makes.)
 *
 * These tests keep the connector's real client and discord.js's own channel,
 * message and webhook objects. They replace how the client finds the channel,
 * and the channel's messages, webhooks and kind (a DM channel standing in for
 * a server's, with fetchWebhooks, createWebhook and isThread faked on it),
 * and the client's REST calls, which record the body discord.js built and
 * would have sent.
 *
 * Run with: npm test -- connector.allowed-mentions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChannelType, Collection, Webhook } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

const CH = '100000000000000001'
const BOT = '200000000000000002'
const HOOK = '300000000000000003'
const TRIGGER = '999999999999999999'
const TEXT = 'hello @everyone and @here, <@&222222222222222222> and <@111111111111111111>'
const USERS_ONLY = { parse: ['users'] }

function makeConnector(opts: { thread?: boolean; webhooks?: 'found' | 'none' | 'fetch-fails' | 'create-fails' | 'send-fails' } = {}) {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-allowed-mentions-test-'))
  const connector = new DiscordConnector(new EventQueue(), { token: 'fake', cacheDir: tmpCache, maxBackoffMs: 100 })
  const client = (connector as any).client
  Object.defineProperty(client, 'user', { value: { id: BOT, displayAvatarURL: () => 'x' }, configurable: true })

  // Each REST call discord.js makes, with the body it built.
  const sent: Array<{ how: string; body: Record<string, unknown> }> = []
  // Snowflakes are past Number's exact range, so each id is a BigInt sum:
  // discord.js caches a sent message by its id, and ids that collided would
  // leave each send returning the first message.
  let nextId = 1
  const messageData = (authorId: string, content = '') => ({
    id: (500000000000000000n + BigInt(nextId++)).toString(), channel_id: CH, type: 0, content, timestamp: new Date().toISOString(),
    author: { id: authorId, username: 'someone', discriminator: '0000', avatar: null, bot: true },
    attachments: [], embeds: [], mentions: [], mention_roles: [], pinned: false, tts: false, mention_everyone: false,
  })
  client.rest.post = async (route: string, request: { body: Record<string, unknown> }) => {
    const how = route.includes('/webhooks/') ? 'webhook' : 'send'
    if (how === 'webhook' && opts.webhooks === 'send-fails') throw new Error('Unknown Webhook')
    sent.push({ how, body: request.body })
    return messageData(how === 'webhook' ? HOOK : BOT)
  }
  client.rest.patch = async (route: string, request: { body: Record<string, unknown> }) => {
    sent.push({ how: 'edit', body: request.body })
    return { ...messageData(BOT), id: route.split('/').pop() }
  }

  // discord.js's own channel, with how it finds its messages and webhooks
  // replaced, and the bot's own message in it.
  const channel = client.channels._add({ id: CH, type: ChannelType.DM, recipients: [{ id: '111111111111111111', username: 'jack', discriminator: '0000' }] })
  channel.isThread = () => opts.thread === true
  const own = channel.messages._add({ ...messageData(BOT, 'draft'), id: '400000000000000004' })
  channel.messages.fetch = async (arg: unknown) => (typeof arg === 'string' ? own : new Collection([[own.id, own]]))
  const webhook = () => new Webhook(client, { id: HOOK, token: 'tok', name: 'Chapter3-Tools', type: 1, channel_id: CH })
  channel.fetchWebhooks = async () => {
    if (opts.webhooks === 'fetch-fails') throw new Error('Missing Permissions')
    return opts.webhooks === 'none' || opts.webhooks === 'create-fails' ? [] : [webhook()]
  }
  channel.createWebhook = async () => {
    if (opts.webhooks === 'create-fails') throw new Error('Maximum number of webhooks reached')
    sent.push({ how: 'create', body: {} })
    return webhook()
  }
  client.channels.fetch = async () => channel

  ;(connector as any).resolveMentions = async (c: string) => c
  ;(connector as any).resolveEmojis = (c: string) => c
  return { connector, own, sent, cleanup: () => { client.destroy(); rmSync(tmpCache, { recursive: true, force: true }) } }
}

describe("the connector's sends and edits", () => {
  let h: ReturnType<typeof makeConnector>
  beforeEach(() => { h = makeConnector() })
  afterEach(() => h.cleanup())

  it('let a message that is no reply ping only the people its text mentions', async () => {
    await h.connector.sendSegmentChunks(CH, TEXT, undefined, [])
    await h.connector.sendMessage(CH, TEXT)
    expect(h.sent.map((s) => [s.how, s.body.allowed_mentions])).toEqual([['send', USERS_ONLY], ['send', USERS_ONLY]])
  })

  it("do the same for every message after a reply's first, through sendSegmentChunks or sendMessage", async () => {
    const long = [1, 2, 3].map((n) => `${n} ${'word '.repeat(300)}`).join('\n\n') + `\n\n${TEXT}`
    for (const send of [
      () => h.connector.sendSegmentChunks(CH, long, TRIGGER, []),
      () => h.connector.sendMessage(CH, long, TRIGGER),
    ]) {
      h.sent.length = 0
      await send()
      expect(h.sent.length).toBeGreaterThanOrEqual(3)
      expect(h.sent[0]!.body.allowed_mentions).toEqual({ ...USERS_ONLY, replied_user: false })
      for (const later of h.sent.slice(1)) {
        expect(later.body.allowed_mentions).toEqual(USERS_ONLY)
        expect(later.body.message_reference).toBeUndefined()
      }
    }
  })

  it('do the same for a text attachment, an image and a file sent as no reply', async () => {
    await h.connector.sendMessageWithAttachment(CH, TEXT, { name: 'notes.txt', content: 'x' })
    await h.connector.sendImageAttachment(CH, Buffer.from('png').toString('base64'), 'image/png', TEXT)
    await h.connector.sendFileAttachment(CH, Buffer.from('x'), 'data.bin', 'application/octet-stream', TEXT)
    expect(h.sent.map((s) => s.body.allowed_mentions)).toEqual([USERS_ONLY, USERS_ONLY, USERS_ONLY])
  })

  it("do the same for a tool's webhook message, found or created, and for its plain fallback in a thread or when finding, creating or sending through the webhook fails", async () => {
    await h.connector.sendWebhook(CH, TEXT, 'tool')
    expect(h.sent.map((s) => [s.how, s.body.allowed_mentions])).toEqual([['webhook', USERS_ONLY]])
    const cases: Array<[Parameters<typeof makeConnector>[0], Array<[string, unknown]>]> = [
      [{ webhooks: 'none' }, [['create', undefined], ['webhook', USERS_ONLY]]],
      [{ thread: true }, [['send', USERS_ONLY]]],
      [{ webhooks: 'fetch-fails' }, [['send', USERS_ONLY]]],
      [{ webhooks: 'create-fails' }, [['send', USERS_ONLY]]],
      [{ webhooks: 'send-fails' }, [['send', USERS_ONLY]]],
    ]
    for (const [opts, expected] of cases) {
      const t = makeConnector(opts)
      try {
        await t.connector.sendWebhook(CH, TEXT, 'tool')
        expect(t.sent.map((s) => [s.how, s.body.allowed_mentions]), JSON.stringify(opts)).toEqual(expected)
      } finally {
        t.cleanup()
      }
    }
  })

  it('do the same for an edit of its own message, by id or by its text', async () => {
    await h.connector.editMessage(CH, h.own.id, TEXT)
    expect(await h.connector.findAndEditBotMessage(CH, 'draft', TEXT)).toBe(true)
    expect(h.sent.map((s) => [s.how, s.body.allowed_mentions])).toEqual([['edit', USERS_ONLY], ['edit', USERS_ONLY]])
  })
})
