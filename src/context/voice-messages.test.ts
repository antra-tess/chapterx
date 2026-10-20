/**
 * The voice message a bot with include_voice_messages hears: which one is
 * taken from the messages it sees, when it's sent, and what its download
 * gives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DiscordAttachment, DiscordMessage } from '../types.js'
import { logger } from '../utils/logger.js'
import { VOICE_MESSAGE_TYPES, baseContentType, fetchNewestVoiceMessage, newestVoiceMessage, startsWithMarkup } from './voice-messages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let n = 0
function voice(contentType: string | undefined = 'audio/ogg', size = 28290): DiscordAttachment {
  const id = String(++n)
  return { id, url: `https://cdn.example/${id}/voice-message.ogg`, filename: 'voice-message.ogg', contentType, size, duration: 7, voiceMessage: true }
}

function file(contentType = 'audio/ogg'): DiscordAttachment {
  const id = String(++n)
  return { id, url: `https://cdn.example/${id}/song.ogg`, filename: 'song.ogg', contentType, size: 28290 }
}

function message(attachments: DiscordAttachment[]): DiscordMessage {
  return {
    id: String(++n),
    channelId: 'channel',
    guildId: 'guild',
    author: { id: 'u1', username: 'bob', displayName: 'Bob', bot: false },
    content: '',
    timestamp: new Date(0),
    attachments,
    reactions: [],
  } as DiscordMessage
}

/** Bytes that aren't valid UTF-8, so reading them as text would change them. */
const AUDIO = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0xfe, 0x80, 0xc3])

/** A fetch that answers each URL with AUDIO, recording what it was asked. */
function stubFetch() {
  const fetched: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url)
    return new Response(AUDIO)
  }))
  return fetched
}

describe('baseContentType', () => {
  it('drops parameters, with or without a space before them, and lowercases', () => {
    expect(baseContentType('Audio/OGG; codecs=opus')).toBe('audio/ogg')
    expect(baseContentType('audio/ogg ; codecs=opus')).toBe('audio/ogg')
  })

  it('gives undefined for no type', () => {
    expect(baseContentType(null)).toBeUndefined()
    expect(baseContentType(undefined)).toBeUndefined()
    expect(baseContentType('')).toBeUndefined()
  })
})

describe('VOICE_MESSAGE_TYPES', () => {
  it("is Gemini's documented audio types less the headerless three", () => {
    expect([...VOICE_MESSAGE_TYPES].sort()).toEqual([
      'audio/aac', 'audio/aiff', 'audio/flac', 'audio/m4a', 'audio/mp3',
      'audio/mpeg', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm',
    ])
  })
})

describe('startsWithMarkup', () => {
  it("takes a body whose first byte, after whitespace or a byte-order mark, is '<'", () => {
    expect(startsWithMarkup(Buffer.from('<!DOCTYPE html><html></html>'))).toBe(true)
    expect(startsWithMarkup(Buffer.from('<!-- gone --><html></html>'))).toBe(true)
    expect(startsWithMarkup(Buffer.from('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'))).toBe(true)
    expect(startsWithMarkup(Buffer.from('\r\n  <head>'))).toBe(true)
    expect(startsWithMarkup(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<html>')]))).toBe(true)
  })
})

describe('newestVoiceMessage', () => {
  it('takes the newest voice message', () => {
    const newer = voice()
    expect(newestVoiceMessage([message([voice()]), message([newer])])).toBe(newer)
  })

  it("takes a merged message's last voice message as its newest", () => {
    const newer = voice()
    expect(newestVoiceMessage([message([voice(), newer])])).toBe(newer)
  })

  it('passes over audio files that are not voice messages', () => {
    const older = voice()
    expect(newestVoiceMessage([message([older]), message([file()])])).toBe(older)
  })

  it('finds none without a voice message', () => {
    expect(newestVoiceMessage([message([file()]), message([])])).toBeUndefined()
  })
})

describe('fetchNewestVoiceMessage', () => {
  it('downloads the newest voice message, and gives its bytes, URL and type', async () => {
    const fetched = stubFetch()
    const attachment = voice('audio/ogg')
    expect(await fetchNewestVoiceMessage([message([attachment])])).toEqual({ url: attachment.url, data: AUDIO, mediaType: 'audio/ogg' })
    expect(fetched).toEqual([attachment.url])
  })

  it('sends the type without its parameters', async () => {
    stubFetch()
    expect((await fetchNewestVoiceMessage([message([voice('audio/ogg; codecs=opus')])]))?.mediaType).toBe('audio/ogg')
  })

  it('sends one of 2 MB (2 × 1024² bytes), and none over it, with the reason logged', async () => {
    const fetched = stubFetch()
    const info = vi.spyOn(logger, 'info')
    expect(await fetchNewestVoiceMessage([message([voice('audio/ogg', 2_097_152)])])).toBeDefined()
    expect(await fetchNewestVoiceMessage([message([voice('audio/ogg', 2_097_153)])])).toBeUndefined()
    expect(fetched).toHaveLength(1)
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ size: 2_097_153 }), expect.stringContaining('over 2 MB'))
  })

  it('sends none of a type outside the set, or with no type, with the reason logged', async () => {
    const fetched = stubFetch()
    const info = vi.spyOn(logger, 'info')
    expect(await fetchNewestVoiceMessage([message([voice('audio/x-ms-wma')])])).toBeUndefined()
    expect(await fetchNewestVoiceMessage([message([{ ...voice(), contentType: undefined }])])).toBeUndefined()
    expect(fetched).toEqual([])
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'audio/x-ms-wma' }), expect.stringContaining('its type'))
  })

  it('tries no older voice message when the newest is too big, of another type, or fails to download', async () => {
    const fetched = stubFetch()
    expect(await fetchNewestVoiceMessage([message([voice()]), message([voice('audio/ogg', 3_000_000)])])).toBeUndefined()
    expect(await fetchNewestVoiceMessage([message([voice()]), message([voice('audio/x-ms-wma')])])).toBeUndefined()
    expect(fetched).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    expect(await fetchNewestVoiceMessage([message([voice()]), message([voice()])])).toBeUndefined()
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('downloads nothing without a voice message', async () => {
    const fetched = stubFetch()
    expect(await fetchNewestVoiceMessage([message([file()])])).toBeUndefined()
    expect(fetched).toEqual([])
  })

  it('gives undefined, with a warning, when Discord answers with an error', async () => {
    const warn = vi.spyOn(logger, 'warn')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    expect(await fetchNewestVoiceMessage([message([voice()])])).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }), 'Failed to fetch voice message')
  })

  it('gives undefined, with a warning, when Discord answers with an error page or nothing', async () => {
    const warn = vi.spyOn(logger, 'warn')
    for (const body of ['<!DOCTYPE html><html>This content is no longer available.</html>', '\n <html><body>gone</body></html>', '<?xml version="1.0"?><Error/>', '']) {
      const attachment = voice()
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
      expect(await fetchNewestVoiceMessage([message([attachment])])).toBeUndefined()
      expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ bytes: body.length }), 'Downloaded voice message is empty or a markup page, not audio')
    }
  })

  it('gives undefined, with a warning, when the request fails', async () => {
    const warn = vi.spyOn(logger, 'warn')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset') }))
    expect(await fetchNewestVoiceMessage([message([voice()])])).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'Failed to download voice message')
  })

  it("gives undefined, with a warning, when reading the response's body fails", async () => {
    const warn = vi.spyOn(logger, 'warn')
    const response = new Response(AUDIO)
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('body stream ended'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    expect(await fetchNewestVoiceMessage([message([voice()])])).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'Failed to download voice message')
  })
})
