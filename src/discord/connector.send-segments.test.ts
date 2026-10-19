/**
 * Tests for DiscordConnector.sendSegmentChunks — the markdown-aware segment
 * sender used by AgentLoop. The key property: mention/emoji resolution happens
 * BEFORE the (single) markdown split, so resolution can never push a chunk past
 * the limit and trigger an unrecorded second split. Bridge metadata is returned
 * per sent message so the caller can strip it during context reconstruction.
 *
 * We instantiate a real DiscordConnector (its Client is an EventEmitter, no
 * network until .login()) and stub channel.fetch / resolve* via `as any`.
 *
 * Run with: npm test -- connector.send-segments
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

const CH = '100000000000000001'

function makeConnector() {
  const tmpCache = mkdtempSync(join(tmpdir(), 'connector-seg-test-'))
  const connector = new DiscordConnector(new EventQueue(), {
    token: 'fake',
    cacheDir: tmpCache,
    maxBackoffMs: 100,
  })

  const sent: string[] = []
  let nextId = 1
  const channel = {
    isTextBased: () => true,
    guild: { id: 'guild-1' },
    send: vi.fn(async ({ content }: { content: string }) => {
      sent.push(content)
      return { id: String(nextId++) }
    }),
  }
  ;(connector as any).client = { channels: { fetch: async () => channel } }
  // No-op mention resolution by default; tests override resolveEmojis as needed.
  ;(connector as any).resolveMentions = async (c: string) => c
  ;(connector as any).resolveEmojis = (c: string) => c

  return { connector, sent, channel, cleanup: () => rmSync(tmpCache, { recursive: true, force: true }) }
}

describe('DiscordConnector.sendSegmentChunks', () => {
  let h: ReturnType<typeof makeConnector>
  beforeEach(() => { h = makeConnector() })
  afterEach(() => h.cleanup())

  it('returns one record per message, no bridges when it fits', async () => {
    const { connector, sent } = h
    const { chunks, endCarry } = await connector.sendSegmentChunks(CH, 'just text', undefined, [])
    expect(sent).toEqual(['just text'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.bridgeOpen).toBeUndefined()
    expect(chunks[0]!.bridgeClose).toBeUndefined()
    expect(endCarry).toEqual([])
  })

  it('reopens an inherited fence and records bridgeOpen', async () => {
    const { connector } = h
    const { chunks } = await connector.sendSegmentChunks(
      CH, 'print(2)\n```\ndone', undefined,
      [{ kind: 'fence', opener: '```python', closer: '```' }],
    )
    expect(chunks[0]!.bridgeOpen).toBe('```python\n')
    // The actual sent text begins with the reopened fence.
    expect(h.sent[0]!.startsWith('```python\n')).toBe(true)
  })

  it('reports an unclosed fence as endCarry (continues to the next send)', async () => {
    const { connector } = h
    const { endCarry } = await connector.sendSegmentChunks(CH, 'intro\n```js\nx=1', undefined, [])
    expect(endCarry.map((m) => m.kind)).toEqual(['fence'])
  })

  it('splits AFTER emoji resolution: expansion past 1800 still bridges the fence', async () => {
    const { connector, sent } = h
    // Emoji shortcode expands to a long custom-emoji tag, pushing a sub-1800
    // pre-resolution body over the 1800 split threshold mid-fence.
    ;(connector as any).resolveEmojis = (c: string) =>
      c.replace(/:big:/g, '<:big:123456789012345678901234567890>')
    const body = 'x'.repeat(1790)
    const content = '```bash\n' + body + ' :big: tail\n```'

    const { chunks } = await connector.sendSegmentChunks(CH, content, undefined, [])

    // Resolution happened before the split → it actually crossed 1800 → 2 msgs.
    expect(chunks.length).toBeGreaterThan(1)
    // Every sent message is a self-contained, fence-balanced render.
    for (const text of sent) {
      expect(text.length).toBeLessThanOrEqual(1800)
      expect((text.match(/```/g) || []).length % 2).toBe(0)
    }
    // The boundary is bridged AND recorded (so context reconstruction can strip).
    expect(chunks[0]!.bridgeClose).toBeTruthy()
    expect(chunks[1]!.bridgeOpen).toBeTruthy()
    // The shortcode was resolved before splitting (not sent verbatim).
    expect(sent.join('')).not.toContain(' :big: ')
    expect(sent.join('')).toContain('<:big:123456789012345678901234567890>')
  })

  it('replies only on the first message of the segment', async () => {
    const { connector, channel } = h
    const big = '```bash\n' + 'y'.repeat(1900) + '\n```'
    const { chunks } = await connector.sendSegmentChunks(CH, big, 'reply-target-id', [])
    expect(chunks.length).toBeGreaterThan(1)
    const calls = channel.send.mock.calls.map((c: any[]) => c[0])
    expect(calls[0]!.reply).toEqual({ messageReference: 'reply-target-id' })
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.reply).toBeUndefined()
  })

  it('retries a failed later chunk without resending earlier chunks', async () => {
    const { connector, channel, sent } = h
    let call = 0
    channel.send.mockImplementation(async ({ content }: { content: string }) => {
      call++
      if (call === 2) throw new Error('transient send failure')
      sent.push(content)
      return { id: `id-${call}` }
    })

    const big = '```bash\n' + 'z'.repeat(1900) + '\n```'
    const { chunks } = await connector.sendSegmentChunks(CH, big, undefined, [])

    expect(chunks.length).toBeGreaterThan(1)
    expect(channel.send).toHaveBeenCalledTimes(chunks.length + 1)
    expect(sent).toHaveLength(chunks.length)
    expect(sent[0]).not.toBe(sent[1])
  })
})

describe('DiscordConnector.sendSegmentChunks with its mention lookup', () => {
  let h: ReturnType<typeof makeConnector>
  beforeEach(() => {
    h = makeConnector()
    // The connector's own lookup, on a server whose member search finds one Jack.
    delete (h.connector as any).resolveMentions
    const jack = { user: { id: '123', username: 'jack_h4ndle', bot: false }, displayName: 'Jack', joinedAt: new Date(0) }
    ;(h.channel as any).guild = { id: 'guild-1', members: { fetch: async () => new Collection([['123', jack]]) } }
  })
  afterEach(() => h.cleanup())

  it('leaves a <@username> in code as written, and resolves the same one outside it', async () => {
    await h.connector.sendSegmentChunks(CH, 'try `<@jack_h4ndle>` or ask <@jack_h4ndle>', undefined, [])
    expect(h.sent).toEqual(['try `<@jack_h4ndle>` or ask <@123>'])
  })

  it('reads a segment that begins inside a carried code block as code up to its closer', async () => {
    const fence = [{ kind: 'fence' as const, opener: '```', closer: '```' }]
    await h.connector.sendSegmentChunks(CH, '<@jack_h4ndle>\n```\nthen <@jack_h4ndle>', undefined, fence)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatch(/^```\n<@jack_h4ndle>\n```\nthen <@123>$/)
  })

  it("doesn't let a '<@' left open in code take the mention after it out with it", async () => {
    await h.connector.sendSegmentChunks(CH, 'type `<@` then ask <@jack_h4ndle>', undefined, [])
    expect(h.sent).toEqual(['type `<@` then ask <@123>'])
  })

  it("reads the mention inside a '<@' written just before it", async () => {
    await h.connector.sendSegmentChunks(CH, 'ask <@<@jack_h4ndle>', undefined, [])
    expect(h.sent).toEqual(['ask <@<@123>'])
  })
})
