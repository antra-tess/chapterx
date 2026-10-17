/**
 * The message export route on the portal backend, from the URL to the ids it
 * returns.
 *
 * WHAT THIS PROTECTS: the API takes Discord message ids from Discord URLs and
 * returns message ids that callers build Discord links from. On the portal
 * backend a fetched message's own id is the relay's, so the route must trim to
 * `first` by snowflake and return snowflakes. This drives the real
 * PortalConnector over a fake portal client.
 *
 * Run with: npm test -- portal-export
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ApiServer } from './server.js'
import { PortalConnector } from '../connector/portal/portal-connector.js'
import { EventQueue } from '../agent/event-queue.js'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'

/** A portal message in the channel, with snowflake `n`, replying to `replyTo`. */
function msg(n: number, replyTo?: number) {
  return {
    id: `rm_${CHANNEL}_${n}`,
    nativeId: String(n),
    channelId: CHANNEL,
    guildId: GUILD,
    author: { kind: 'user', userId: 'u1', username: 'alice', displayName: 'Alice', bot: false },
    content: `message ${n}`,
    cleanContent: `message ${n}`,
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    replyToId: replyTo === undefined ? undefined : `rm_${CHANNEL}_${replyTo}`,
    createdAt: new Date(Date.UTC(2026, 9, 17, 0, 0, n % 60)).toISOString(),
  }
}

let server: ApiServer | undefined
let tmpCache: string | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
  if (tmpCache) rmSync(tmpCache, { recursive: true, force: true })
  tmpCache = undefined
})

async function startOverHistory(all: ReturnType<typeof msg>[]) {
  tmpCache = mkdtempSync(join(tmpdir(), 'portal-export-test-'))
  const connector = new PortalConnector(new EventQueue(), {
    url: 'ws://relay.invalid',
    token: 'token',
    personaId: 'persona-p',
    cacheDir: tmpCache,
  })
  ;(connector as any).client = {
    fetchHistory: vi.fn(async ({ before, limit }: { before?: string; limit: number }) => ({
      messages: all
        .filter((m) => before === undefined || BigInt(m.nativeId) < BigInt(before))
        .sort((a, b) => (BigInt(b.nativeId) > BigInt(a.nativeId) ? 1 : -1))
        .slice(0, limit),
    })),
    cache: { getChannel: () => undefined, allChannels: () => [], allGuilds: () => [], persona: { displayName: 'p' } },
  }
  server = new ApiServer({ port: 0, bearerToken: 'secret' }, connector)
  await server.start()
  const port = (server as any).server.address().port as number
  return (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/messages/export`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
}

const url = (n: number) => `https://discord.com/channels/${GUILD}/${CHANNEL}/${n}`

describe('POST /api/messages/export on the portal backend', () => {
  it('trims to `first` and returns Discord snowflakes, reply targets included', async () => {
    // 104 replies inside the range, 105 to a message fetched but trimmed off,
    // and 103 to one the connector never saw.
    const replies: Record<number, number> = { 104: 103, 105: 101, 103: 7 }
    const post = await startOverHistory([100, 101, 102, 103, 104, 105, 106].map((n) => msg(n, replies[n])))

    const res = await post({ last: url(105), first: url(102) })
    const body = await res.json()
    const byId = (id: string) => body.messages.find((m: { id: string }) => m.id === id)

    expect(res.status).toBe(200)
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['102', '103', '104', '105'])
    expect(body.metadata.firstMessageId).toBe('102')
    expect(body.metadata.lastMessageId).toBe('105')
    expect(byId('104').referencedMessageId).toBe('103')
    expect(byId('105').referencedMessageId).toBe('101')
    expect(byId('103').referencedMessageId).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('rm_')
  })
})
