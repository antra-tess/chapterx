/**
 * formatMessages and the attachments a request doesn't carry: each one gets a
 * line, so the model is told it was sent.
 *
 * Image preparation is stood in for, so a test decides what an image's bytes
 * come to and whether resampling works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CachedDocument, CachedImage, DiscordAttachment, DiscordMessage, ParticipantMessage } from '../../types.js'

const imageProcessing = vi.hoisted(() => ({
  prepareImage: vi.fn(),
  resampleImage: vi.fn(),
}))
vi.mock('../image-processing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-processing.js')>()),
  prepareImage: imageProcessing.prepareImage,
  resampleImage: imageProcessing.resampleImage,
}))

const { formatMessages, limitImages } = await import('./format-messages.js')
const { MAX_IMAGE_BASE64_BYTES } = await import('../image-processing.js')
const { mergeConsecutiveBotMessages } = await import('./message-filtering.js')

beforeEach(() => {
  imageProcessing.prepareImage.mockReset()
  imageProcessing.prepareImage.mockImplementation(async (data: Buffer, mediaType: string) => ({ data, mediaType, width: 8, height: 8 }))
  imageProcessing.resampleImage.mockReset()
  imageProcessing.resampleImage.mockRejectedValue(new Error('cannot resample'))
})

let n = 0
function message(author: string, content: string, attachments: DiscordAttachment[] = [], overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  const id = `m${++n}`
  return {
    id,
    channelId: 'ch-1',
    guildId: 'guild-1',
    author: { id: `u-${author}`, username: author, displayName: author, bot: false },
    content,
    timestamp: new Date('2026-10-19T12:00:00Z'),
    attachments,
    reactions: [],
    mentions: [],
    ...overrides,
  }
}

function file(filename: string, contentType: string | undefined, size: number, overrides: Partial<DiscordAttachment> = {}): DiscordAttachment {
  return { id: `a-${filename}`, url: `https://cdn.example/${++n}/${filename}`, filename, contentType, size, ...overrides }
}

function cachedImage(attachment: DiscordAttachment, bytes = 64): CachedImage {
  return { url: attachment.url, data: Buffer.alloc(bytes, 1), mediaType: 'image/png', hash: 'h', width: 8, height: 8 } as CachedImage
}

/** Each message as [participant, its blocks], a text block as its text and
 *  any other block as <type>. */
function shown(messages: ParticipantMessage[]): Array<[string, string[]]> {
  return messages.map((m) => [m.participant, m.content.map((c) => (c.type === 'text' ? (c as { text: string }).text : `<${c.type}>`))])
}

const config = (overrides: Record<string, unknown> = {}) => ({ name: 'Bot', ...overrides }) as never
const format = (messages: DiscordMessage[], images: CachedImage[] = [], documents: CachedDocument[] = [], overrides: Record<string, unknown> = {}) =>
  formatMessages(messages, images, documents, config(overrides), 'Bot')

describe('formatMessages: an attachment the request does not carry', () => {
  it('keeps a voice message, as a line with its length', async () => {
    const voice = message('bob', '', [file('voice-message.ogg', 'audio/ogg', 28290, { duration: 34.4, voiceMessage: true })])
    const out = await format([message('alice', 'what did everyone think?'), voice, message('carol', 'bot, what did bob say?')])
    expect(shown(out)).toEqual([
      ['alice', ['what did everyone think?']],
      ['bob', ['[voice message, 0:34, not included]']],
      ['carol', ['bot, what did bob say?']],
    ])
  })

  it('keeps a voice message that is a reply, its reply tag first', async () => {
    const voice = message('bob', '<reply:@alice> ', [file('voice-message.ogg', 'audio/ogg', 28290, { duration: 3, voiceMessage: true })])
    const out = await format([voice], [], [], { include_reply_tags: true })
    expect(shown(out)).toEqual([['bob', ['<reply:@alice> ', '[voice message, 0:03, not included]']]])
  })

  it('names an audio file, a video and any other file after the message text', async () => {
    const out = await format([
      message('dave', 'two songs and the logs', [
        file('song.mp3', 'audio/mpeg', 4.2 * 1024 * 1024, { duration: 192 }),
        file('clip.mp4', 'video/mp4', 900),
        file('logs.zip', 'application/zip', 2400000),
      ]),
    ])
    expect(shown(out)).toEqual([['dave', [
      'two songs and the logs',
      '[attachment "song.mp3", audio, 3:12, 4.2 MB, not included]',
      '[attachment "clip.mp4", video, 900 B, not included]',
      '[attachment "logs.zip", file, 2.3 MB, not included]',
    ]]])
  })

  it('names an image when images are off, and keeps a message that had only that image', async () => {
    const img = file('cat.png', 'image/png', 120000)
    const out = await format([message('bob', '', [img])], [cachedImage(img)], [], { include_images: false })
    expect(shown(out)).toEqual([['bob', ['[attachment "cat.png", image, 117 KB, not included]']]])
  })

  it('labels each attachment of merged bot messages by its own voice mark', async () => {
    const bot = (content: string, attachments: DiscordAttachment[]) =>
      message('Bot', content, attachments, { author: { id: 'u-bot', username: 'Bot', displayName: 'Bot', bot: true } })
    const merged = mergeConsecutiveBotMessages([
      bot('first', [file('logs.zip', 'application/zip', 2400000)]),
      bot('', [file('voice-message.ogg', 'audio/ogg', 28290, { duration: 12, voiceMessage: true })]),
      bot('third', [file('song.mp3', 'audio/mpeg', 1000)]),
    ], 'Bot')
    expect(merged).toHaveLength(1)
    const out = await format(merged)
    expect(shown(out)[0]![1].slice(1)).toEqual([
      '[attachment "logs.zip", file, 2.3 MB, not included]',
      '[voice message, 0:12, not included]',
      '[attachment "song.mp3", audio, 1000 B, not included]',
    ])
  })

  it('shows a name as Discord gave it, though it looks like a mention the rewrites change', async () => {
    const carol = { id: 'u-carol', username: 'carol', displayName: 'Carol C', bot: false }
    const out = await format(
      [
        message('carol', 'hi', [], { author: carol }),
        message('bob', 'for <@carol>', [file('notes <@carol>.zip', 'application/zip', 2048)]),
      ],
      [], [],
      { use_display_names_humans: true },
    )
    expect(shown(out)[1]![1]).toEqual(['for @Carol C', '[attachment "notes <@carol>.zip", file, 2 KB, not included]'])
  })

  it('names an image with no cached copy', async () => {
    const out = await format([message('bob', '', [file('cat.png', 'image/png', 120000)])], [], [], { include_images: true })
    expect(shown(out)).toEqual([['bob', ['[attachment "cat.png", image, 117 KB, not included]']]])
  })

  it('names a cached image that selection left out, and carries the one it chose', async () => {
    const older = file('older.png', 'image/png', 64)
    const newer = file('newer.png', 'image/png', 64)
    const out = await format(
      [message('bob', 'one', [older]), message('carol', 'two', [newer])],
      [cachedImage(older), cachedImage(newer)],
      [],
      { include_images: true, max_images: 1 },
    )
    expect(shown(out)).toEqual([
      ['bob', ['one', '[attachment "older.png", image, 64 B, not included]']],
      ['carol', ['two', '<image>']],
    ])
  })

  it('names an uncached image beside a carried one in the same message', async () => {
    const cached = file('cached.png', 'image/png', 64)
    const missing = file('missing.png', 'image/png', 64)
    const out = await format([message('bob', 'two pictures', [cached, missing])], [cachedImage(cached)], [], { include_images: true })
    expect(shown(out)).toEqual([['bob', ['two pictures', '<image>', '[attachment "missing.png", image, 64 B, not included]']]])
  })

  it('gives a carried image no line', async () => {
    const img = file('cat.png', 'image/png', 64)
    const out = await format([message('bob', 'look', [img])], [cachedImage(img)], [], { include_images: true })
    expect(shown(out)).toEqual([['bob', ['look', '<image>']]])
  })

  it('names an image that resampling could not bring under the limit', async () => {
    const img = file('huge.png', 'image/png', MAX_IMAGE_BASE64_BYTES)
    const out = await format([message('bob', 'big one', [img])], [cachedImage(img, MAX_IMAGE_BASE64_BYTES)], [], { include_images: true })
    expect(imageProcessing.resampleImage).toHaveBeenCalled()
    expect(shown(out)).toEqual([['bob', ['big one', '[attachment "huge.png", image, 5.0 MB, not included]']]])
  })

  it('names an image that resampling left over the limit', async () => {
    imageProcessing.resampleImage.mockImplementation(async () => ({ data: Buffer.alloc(MAX_IMAGE_BASE64_BYTES + 1, 1), mediaType: 'image/jpeg', width: 8, height: 8 }))
    const img = file('huge.png', 'image/png', MAX_IMAGE_BASE64_BYTES)
    const out = await format([message('bob', 'big one', [img])], [cachedImage(img, MAX_IMAGE_BASE64_BYTES)], [], { include_images: true })
    expect(shown(out)).toEqual([['bob', ['big one', '[attachment "huge.png", image, 5.0 MB, not included]']]])
  })

  it('gives a carried text file no line, and names one whose text was not fetched', async () => {
    const notes = file('notes.txt', 'text/plain', 30)
    const lost = file('lost.txt', 'text/plain', 30)
    const doc: CachedDocument = { messageId: 'set below', url: notes.url, filename: 'notes.txt', contentType: 'text/plain', size: 30, text: 'line one' }
    const msg = message('erin', 'see notes', [notes, lost])
    doc.messageId = msg.id
    const out = await format([msg], [], [doc], { include_text_attachments: false })
    expect(shown(out)).toEqual([['erin', ['see notes', '📎 notes.txt\nline one', '[attachment "lost.txt", file, 30 B, not included]']]])
  })

  it('puts the lines after the attachment blocks of a text file', async () => {
    const notes = file('notes.txt', 'text/plain', 30)
    const clip = file('clip.mp4', 'video/mp4', 900)
    const msg = message('erin', 'see notes', [notes, clip])
    const doc: CachedDocument = { messageId: msg.id, url: notes.url, filename: 'notes.txt', contentType: 'text/plain', size: 30, text: 'line one' }
    const out = await format([msg], [], [doc])
    expect(shown(out)).toEqual([['erin', [
      'see notes',
      '📎 notes.txt\nline one',
      '<attachment filename="notes.txt">\nline one\n</attachment>',
      '[attachment "clip.mp4", video, 900 B, not included]',
    ]]])
  })
})

describe('limitImages', () => {
  it('puts a line in the place of each image past the limit, oldest first, and keeps the newest', async () => {
    // Selection marks the message at its first image; every cached image in a
    // selected message is pushed, and limitImages brings them to max_images.
    const a = file('a.png', 'image/png', 64)
    const b = file('b.png', 'image/png', 64)
    const c = file('c.png', 'image/png', 64)
    const out = await format(
      [message('bob', 'three', [a, b, c])],
      [cachedImage(a), cachedImage(b), cachedImage(c)],
      [],
      { include_images: true, max_images: 1 },
    )
    expect(shown(out)).toEqual([['bob', [
      'three',
      '[attachment "a.png", image, 64 B, not included]',
      '[attachment "b.png", image, 64 B, not included]',
      '<image>',
    ]]])
    const kept = out[0]!.content[3] as { sourceUrl?: string }
    expect(kept.sourceUrl).toBe(c.url)
  })

  it('limits across messages, putting each older image\'s line in its own message', () => {
    const image = (url: string) => ({ type: 'image', source: { type: 'base64', data: url, media_type: 'image/png' }, sourceUrl: url }) as never
    const messages: ParticipantMessage[] = [
      { participant: 'bob', content: [{ type: 'text', text: 'first' }, image('u1')] },
      { participant: 'carol', content: [image('u2'), { type: 'text', text: 'second' }] },
      { participant: 'dave', content: [image('u3')] },
    ]
    limitImages(messages, 1, (url) => `line for ${url}`)
    expect(shown(messages)).toEqual([
      ['bob', ['first', 'line for u1']],
      ['carol', ['line for u2', 'second']],
      ['dave', ['<image>']],
    ])
  })

  it('takes the line for each image from lineFor, by its source URL', () => {
    const messages: ParticipantMessage[] = [{ participant: 'bob', content: [
      { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' }, sourceUrl: 'u1' } as never,
      { type: 'image', source: { type: 'base64', data: 'y', media_type: 'image/png' }, sourceUrl: 'u2' } as never,
    ] }]
    limitImages(messages, 1, (url) => `line for ${url}`)
    expect(shown(messages)).toEqual([['bob', ['line for u1', '<image>']]])
  })
})
