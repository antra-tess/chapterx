/**
 * What every message the bot sends, and every edit of its own messages, may
 * ping: the people its text mentions, and never a role, @everyone or @here.
 * The connector's client gives that as discord.js's `allowedMentions` default,
 * which each send and edit whose options give none takes.
 *
 * These tests keep the connector's real client and discord.js's own channel,
 * message and webhook objects. They replace how the client finds the channel
 * and the channel's messages, and the client's REST calls, which record the
 * body discord.js built and would have sent.
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

function makeConnector(opts: { thread?: boolean } = {}) {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-allowed-mentions-test-'))
  const connector = new DiscordConnector(new EventQueue(), { token: 'fake', cacheDir: tmpCache, maxBackoffMs: 100 })
  const client = (connector as any).client
  Object.defineProperty(client, 'user', { value: { id: BOT, displayAvatarURL: () => 'x' }, configurable: true })

  // Each REST call discord.js makes, with the body it built.
  const sent: Array<{ how: string; body: Record<string, unknown> }> = []
  let nextId = 1
  const messageData = (authorId: string, content = '') => ({
    id: String(500000000000000000 + nextId++), channel_id: CH, type: 0, content, timestamp: new Date().toISOString(),
    author: { id: authorId, username: 'someone', discriminator: '0000', avatar: null, bot: true },
    attachments: [], embeds: [], mentions: [], mention_roles: [], pinned: false, tts: false, mention_everyone: false,
  })
  client.rest.post = async (route: string, request: { body: Record<string, unknown> }) => {
    const how = route.includes('/webhooks/') ? 'webhook' : 'send'
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
  channel.fetchWebhooks = async () => [new Webhook(client, { id: HOOK, token: 'tok', name: 'Chapter3-Tools', type: 1, channel_id: CH })]
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

  it("do the same for every message after a reply's first", async () => {
    const long = [1, 2, 3].map((n) => `${n} ${'word '.repeat(300)}`).join('\n\n') + `\n\n${TEXT}`
    await h.connector.sendSegmentChunks(CH, long, TRIGGER, [])
    expect(h.sent.length).toBeGreaterThanOrEqual(3)
    expect(h.sent[0]!.body.allowed_mentions).toEqual({ ...USERS_ONLY, replied_user: false })
    for (const later of h.sent.slice(1)) expect(later.body.allowed_mentions).toEqual(USERS_ONLY)
  })

  it('do the same for a text attachment, an image and a file sent as no reply', async () => {
    await h.connector.sendMessageWithAttachment(CH, TEXT, { name: 'notes.txt', content: 'x' })
    await h.connector.sendImageAttachment(CH, Buffer.from('png').toString('base64'), 'image/png', TEXT)
    await h.connector.sendFileAttachment(CH, Buffer.from('x'), 'data.bin', 'application/octet-stream', TEXT)
    expect(h.sent.map((s) => s.body.allowed_mentions)).toEqual([USERS_ONLY, USERS_ONLY, USERS_ONLY])
  })

  it("do the same for a tool's webhook message, and for its fallback in a thread", async () => {
    await h.connector.sendWebhook(CH, TEXT, 'tool')
    expect(h.sent.map((s) => [s.how, s.body.allowed_mentions])).toEqual([['webhook', USERS_ONLY]])
    const t = makeConnector({ thread: true })
    try {
      await t.connector.sendWebhook(CH, TEXT, 'tool')
      expect(t.sent.map((s) => [s.how, s.body.allowed_mentions])).toEqual([['send', USERS_ONLY]])
    } finally {
      t.cleanup()
    }
  })

  it('do the same for an edit of its own message, by id or by its text', async () => {
    await h.connector.editMessage(CH, h.own.id, TEXT)
    expect(await h.connector.findAndEditBotMessage(CH, 'draft', TEXT)).toBe(true)
    expect(h.sent.map((s) => [s.how, s.body.allowed_mentions])).toEqual([['edit', USERS_ONLY], ['edit', USERS_ONLY]])
  })
})
