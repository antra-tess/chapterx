/** A real DiscordConnector: its Client makes no network call until .login(). */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MessageFlagsBitField, MessageType, type Message } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

const CH = '100000000000000001'
const GUILD_ID = '800000000000000001'
const BOT = '900000000000000001'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function harness(authors: string[], notMembers: string[] = [], webhooks: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'connector-member-names-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const connector = new DiscordConnector(new EventQueue(), { token: 'fake', cacheDir: dir, maxBackoffMs: 1000 })

  const calls: string[] = []
  const memberCache = new Map<string, unknown>()
  const guild = {
    id: GUILD_ID,
    members: {
      cache: memberCache,
      resolve: (user: { id: string }) => memberCache.get(user.id) ?? null,
      fetch: async (userId: string) => {
        calls.push(userId)
        await new Promise((resolve) => setTimeout(resolve, 5))
        if (notMembers.includes(userId)) throw Object.assign(new Error('Unknown Member'), { code: 10007 })
        const member = { id: userId, nickname: `Nick ${userId}`, roles: { cache: new Map() } }
        memberCache.set(userId, member)
        return member
      },
    },
    roles: { cache: new Map() },
    channels: { cache: new Map() },
  }
  const channel = { id: CH, guildId: GUILD_ID, guild, name: 'general', isTextBased: () => true, isThread: () => false }

  const messages = authors.map((authorId, i) => {
    // A webhook's message comes from the webhook, which Discord marks as a bot.
    const webhookId = webhooks[authorId] ?? null
    const author = { id: authorId, username: `user${authorId}`, globalName: `Global ${authorId}`, bot: webhookId !== null }
    return {
      id: String(200000000000000000n + BigInt(i)),
      channelId: CH,
      guildId: GUILD_ID,
      guild,
      content: `hello from ${authorId}`,
      type: MessageType.Default,
      author,
      get member() {
        return guild.members.resolve(author)
      },
      mentions: { users: new Map(), roles: new Map() },
      client: { users: { cache: new Map() } },
      attachments: new Map(),
      flags: new MessageFlagsBitField(0),
      reactions: { cache: new Map() },
      reference: null,
      webhookId,
      createdAt: new Date(0),
    } as unknown as Message
  })

  const client = (connector as any).client
  client.channels.fetch = async () => channel
  ;(connector as any).buildFetchDeps = () => ({
    // Newest first, as Discord answers.
    fetchBatch: async (_ch: unknown, opts: { before?: string }) => (opts.before ? [] : [...messages].reverse()),
    fetchSingle: async () => null,
    resolveChannel: async () => null,
    botUserId: BOT,
  })

  const fetchContext = (displayNames?: { bots: boolean; humans: boolean }) =>
    connector.fetchContext({ channelId: CH, depth: 50, pinnedConfigs: [], maxImages: 0, displayNames })
  const labels = async (displayNames?: { bots: boolean; humans: boolean }) =>
    (await fetchContext(displayNames)).messages.map((m) => m.author.displayName)

  return { calls, labels, fetchContext }
}

describe('DiscordConnector.fetchContext member names', () => {
  it('fetches missing members before converting, so labels carry server nicknames', async () => {
    const h = harness(['1', '2'])
    expect(await h.labels({ bots: false, humans: true })).toEqual(['Nick 1', 'Nick 2'])
    expect(h.calls.sort()).toEqual(['1', '2'])
  })

  it('fetches nothing without displayNames, as the raw exports call it', async () => {
    const h = harness(['1'])
    expect(await h.labels()).toEqual(['Global 1'])
    expect(h.calls).toEqual([])
  })

  it('shows a member an activation fetched to a context that fetches none, as a raw export is', async () => {
    const h = harness(['1'])
    expect(await h.labels({ bots: false, humans: true })).toEqual(['Nick 1'])
    expect(await h.labels()).toEqual(['Nick 1'])
    expect(h.calls).toEqual(['1'])
  })

  it('remembers across contexts who is not a member', async () => {
    const h = harness(['1', '3'], ['3'])
    expect(await h.labels({ bots: false, humans: true })).toEqual(['Nick 1', 'Global 3'])
    expect(await h.labels({ bots: false, humans: true })).toEqual(['Nick 1', 'Global 3'])
    expect(h.calls.sort()).toEqual(['1', '3'])
  })

  it("carries a webhook message's webhookId, and fetches no member for it", async () => {
    const h = harness(['1', '4'], [], { '4': '700000000000000004' })
    const { messages } = await h.fetchContext({ bots: true, humans: true })
    expect(messages.map((m) => m.webhookId)).toEqual([undefined, '700000000000000004'])
    expect(h.calls).toEqual(['1'])
  })
})
