/**
 * A reply's allowed mentions. Each of the connector's reply paths keeps the
 * reply from pinging the author it answers, and lets the people its text
 * mentions be pinged: once a message carries allowed_mentions, Discord pings
 * only what that field allows, so `repliedUser: false` alone silenced every
 * mention in a reply.
 *
 * Run with: npm test -- connector.reply-mentions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MessagePayload } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

const CH = '100000000000000001'
const TRIGGER = '999999999999999999'
const JACK = '111111111111111111'
const REPLY_MENTIONS = { repliedUser: false, parse: ['users'] }

function makeConnector() {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-reply-test-'))
  const connector = new DiscordConnector(new EventQueue(), {
    token: 'fake',
    cacheDir: tmpCache,
    maxBackoffMs: 100,
  })
  let nextId = 1
  const channel = {
    isTextBased: () => true,
    guild: { id: 'guild-1' },
    send: vi.fn(async (_options: Record<string, unknown>) => ({ id: String(nextId++) })),
  }
  ;(connector as any).client = { channels: { fetch: async () => channel } }
  ;(connector as any).resolveMentions = async (c: string) => c
  ;(connector as any).resolveEmojis = (c: string) => c
  return { connector, channel, cleanup: () => rmSync(tmpCache, { recursive: true, force: true }) }
}

/** The allowed_mentions discord.js sends for the options the connector gave channel.send. */
function allowedMentionsSent(options: Record<string, unknown>): unknown {
  const target = {
    client: { options: { allowedMentions: undefined, jsonTransformer: (x: unknown) => x } },
    messages: { resolveId: (r: unknown) => r },
  }
  const { body } = new MessagePayload(target as any, options as any).resolveBody()
  return (body as Record<string, unknown>).allowed_mentions
}

describe("DiscordConnector's replies", () => {
  let h: ReturnType<typeof makeConnector>
  beforeEach(() => { h = makeConnector() })
  afterEach(() => h.cleanup())

  it("let the people a reply's text mentions be pinged, and not the author it answers", async () => {
    await h.connector.sendSegmentChunks(CH, `thanks <@${JACK}>`, TRIGGER, [])
    const options = h.channel.send.mock.calls[0]![0]
    expect(options.allowedMentions).toEqual(REPLY_MENTIONS)
    expect(allowedMentionsSent(options)).toEqual({ parse: ['users'], replied_user: false })
  })

  it('leave a message after the reply to Discord\'s default, as before', async () => {
    const long = `${'word '.repeat(400)}\n\nthen <@${JACK}>`
    await h.connector.sendSegmentChunks(CH, long, TRIGGER, [])
    expect(h.channel.send.mock.calls.length).toBe(2)
    expect(h.channel.send.mock.calls[0]![0].allowedMentions).toEqual(REPLY_MENTIONS)
    expect(allowedMentionsSent(h.channel.send.mock.calls[1]![0])).toBeUndefined()
  })

  it('do the same when the message goes as sendMessage', async () => {
    await h.connector.sendMessage(CH, `thanks <@${JACK}>`, TRIGGER)
    expect(h.channel.send.mock.calls[0]![0].allowedMentions).toEqual(REPLY_MENTIONS)
  })

  it('do the same for a text attachment, an image and a file', async () => {
    await h.connector.sendMessageWithAttachment(CH, `see <@${JACK}>`, { name: 'notes.txt', content: 'x' }, TRIGGER)
    await h.connector.sendImageAttachment(CH, Buffer.from('png').toString('base64'), 'image/png', `for <@${JACK}>`, TRIGGER)
    await h.connector.sendFileAttachment(CH, Buffer.from('x'), 'data.bin', 'application/octet-stream', `for <@${JACK}>`, TRIGGER)
    const sent = h.channel.send.mock.calls.map((call) => call[0].allowedMentions)
    expect(sent).toEqual([REPLY_MENTIONS, REPLY_MENTIONS, REPLY_MENTIONS])
  })

  it("keep users parsed when an attachment goes without its reply, the reply's target gone", async () => {
    h.channel.send.mockRejectedValueOnce(Object.assign(new Error('Unknown Message'), { code: 10008 }))
    await h.connector.sendFileAttachment(CH, Buffer.from('x'), 'data.bin', 'application/octet-stream', `for <@${JACK}>`, TRIGGER)
    expect(h.channel.send.mock.calls.length).toBe(2)
    const fallback = h.channel.send.mock.calls[1]![0]
    expect(fallback.reply).toBeUndefined()
    expect(fallback.allowedMentions).toEqual(REPLY_MENTIONS)
  })
})
