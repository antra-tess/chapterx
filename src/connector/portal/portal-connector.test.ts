/**
 * PortalConnector against a fake portal client: what the agent loop, the API
 * server and sleep get from each IConnector method on the portal backend.
 *
 * The fake stands in for PortalClient's RPCs, so these tests check the
 * connector's own logic (splitting, pin caching, the reply-chain walk, member
 * lookups), not the relay.
 *
 * Run with: npm test -- portal-connector
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PortalConnector } from './portal-connector.js'
import { EventQueue } from '../../agent/event-queue.js'

const CH = 'chan-1'

interface Sent {
  channelId: string
  content?: string
  replyToId?: string
}

function makeHarness() {
  const tmpCache = mkdtempSync(join(tmpdir(), 'portal-connector-test-'))
  const connector = new PortalConnector(new EventQueue(), {
    url: 'ws://relay.invalid',
    token: 'token',
    personaId: 'persona-p',
    cacheDir: tmpCache,
  })
  const sent: Sent[] = []
  let nextId = 1
  const client = {
    sendMessage: vi.fn(async (p: Sent) => {
      sent.push({ channelId: p.channelId, content: p.content, replyToId: p.replyToId })
      return { messageId: `rm_${p.channelId}_${nextId++}` }
    }),
    fetchHistory: vi.fn(async () => ({ messages: [] as unknown[] })),
    call: vi.fn(async () => ({})),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
    close: vi.fn(),
    cache: {
      getChannel: () => undefined,
      allChannels: () => [],
      allGuilds: () => [],
      persona: { displayName: 'p' },
    },
  }
  ;(connector as any).client = client
  return {
    connector,
    client,
    sent,
    cleanup: () => rmSync(tmpCache, { recursive: true, force: true }),
  }
}

const fenceMarkers = (s: string) => (s.match(/```/g) ?? []).length

describe('PortalConnector sending', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.cleanup())

  it('keeps a long code block a code block in every message, as the Discord path does', async () => {
    h = makeHarness()
    const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i} // padding text`).join('\n')
    await h.connector.sendMessage(CH, 'Here is the file:\n\n```ts\n' + code + '\n```\n\nThat is all.')

    expect(h.sent.length).toBeGreaterThan(1)
    for (const m of h.sent) expect(fenceMarkers(m.content!) % 2).toBe(0)
    expect(h.sent[1]!.content!.startsWith('```ts')).toBe(true)
  })

  it('replies to the trigger from the first chunk only', async () => {
    h = makeHarness()
    await h.connector.sendMessage(CH, 'x'.repeat(4000), 'rm_chan-1_99')

    expect(h.sent.length).toBeGreaterThan(1)
    expect(h.sent[0]!.replyToId).toBe('rm_chan-1_99')
    for (const m of h.sent.slice(1)) expect(m.replyToId).toBeUndefined()
  })

  it('rewrites <@name> mentions to @name before splitting', async () => {
    h = makeHarness()
    await h.connector.sendMessage(CH, 'hello <@alice> and <@!bob>, not <@123456>')

    expect(h.sent[0]!.content).toBe('hello @alice and @bob, not <@123456>')
  })

  it('sendSegmentChunks returns each message with its bridges and the carry after the last', async () => {
    h = makeHarness()
    const code = Array.from({ length: 120 }, (_, i) => `line ${i} of the block`).join('\n')
    const { chunks, endCarry } = await h.connector.sendSegmentChunks(CH, '```\n' + code, 'rm_chan-1_7', [])

    expect(chunks.length).toBe(h.sent.length)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.id)).toEqual(h.sent.map((_, i) => `rm_${CH}_${i + 1}`))
    expect(chunks[0]!.bridgeClose).toBeTruthy()
    expect(chunks[1]!.bridgeOpen).toBeTruthy()
    expect(endCarry.length).toBe(1) // the fence is still open after the last message
    expect(h.sent[0]!.replyToId).toBe('rm_chan-1_7')
    expect(h.sent[1]!.replyToId).toBeUndefined()
  })

  it('sendSegmentChunks continues a construct inherited from an earlier send', async () => {
    h = makeHarness()
    const first = await h.connector.sendSegmentChunks(CH, '```\nopen block', undefined, [])
    const second = await h.connector.sendSegmentChunks(CH, 'still code\n```\nafter', undefined, first.endCarry)

    expect(second.chunks[0]!.bridgeOpen).toBeTruthy()
    expect(h.sent[h.sent.length - 1]!.content!.startsWith('```')).toBe(true)
    expect(second.endCarry).toEqual([])
  })
})
