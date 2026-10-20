import { describe, it, expect } from 'vitest'
import { uncarriedAttachmentLine, attachmentKind, formatDuration, formatSize } from './attachment-lines.js'
import type { DiscordAttachment } from '../../types.js'

const attachment = (overrides: Partial<DiscordAttachment> = {}): DiscordAttachment => ({
  id: 'a1',
  url: 'https://cdn.example/a1/song.mp3',
  filename: 'song.mp3',
  contentType: 'audio/mpeg',
  size: 4.2 * 1024 * 1024,
  ...overrides,
})

describe('uncarriedAttachmentLine', () => {
  it('gives a voice message its length and no filename', () => {
    expect(uncarriedAttachmentLine(attachment({ filename: 'voice-message.ogg', contentType: 'audio/ogg', duration: 34.2, voiceMessage: true })))
      .toBe('[voice message, 0:34, not included]')
  })

  it('leaves the length out of a voice message Discord gave none', () => {
    expect(uncarriedAttachmentLine(attachment({ filename: 'voice-message.ogg', contentType: 'audio/ogg', voiceMessage: true })))
      .toBe('[voice message, not included]')
  })

  it('names an audio file that is not a voice message, even one named like one', () => {
    expect(uncarriedAttachmentLine(attachment({ filename: 'voice-message.ogg', contentType: 'audio/ogg', size: 28290, duration: 7 })))
      .toBe('[attachment "voice-message.ogg", audio, 0:07, 28 KB, not included]')
  })

  it('gives any other attachment its name, kind, length and size', () => {
    expect(uncarriedAttachmentLine(attachment({ duration: 192 })))
      .toBe('[attachment "song.mp3", audio, 3:12, 4.2 MB, not included]')
  })

  it('leaves out what Discord gave no value for', () => {
    expect(uncarriedAttachmentLine(attachment({ filename: 'logs.zip', contentType: undefined, size: 2400000 })))
      .toBe('[attachment "logs.zip", file, 2.3 MB, not included]')
  })

  it('quotes a name that holds a quote', () => {
    expect(uncarriedAttachmentLine(attachment({ filename: 'say "hi".mp4', contentType: 'video/mp4', size: 900 })))
      .toBe('[attachment "say \\"hi\\".mp4", video, 900 B, not included]')
  })
})

describe('attachmentKind', () => {
  it('reads the content type\'s top level, whatever its case and parameters', () => {
    expect(attachmentKind('audio/ogg; codecs=opus')).toBe('audio')
    expect(attachmentKind('Video/MP4')).toBe('video')
    expect(attachmentKind('image/png')).toBe('image')
  })

  it('calls anything else, or no content type, a file', () => {
    expect(attachmentKind('application/zip')).toBe('file')
    expect(attachmentKind('text/plain')).toBe('file')
    expect(attachmentKind('')).toBe('file')
    expect(attachmentKind(undefined)).toBe('file')
  })
})

describe('formatDuration', () => {
  it('writes m:ss, rounding to the second', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(0.4)).toBe('0:00')
    expect(formatDuration(59.6)).toBe('1:00')
    expect(formatDuration(725)).toBe('12:05')
  })

  it('writes h:mm:ss from an hour', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('gives nothing for a length that is missing, negative or not finite', () => {
    expect(formatDuration(undefined)).toBeUndefined()
    expect(formatDuration(-1)).toBeUndefined()
    expect(formatDuration(Number.NaN)).toBeUndefined()
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('formatSize', () => {
  it('writes the smallest unit whose rounded figure is under 1024', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1 KB')
    expect(formatSize(28290)).toBe('28 KB')
    expect(formatSize(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatSize(4.2 * 1024 * 1024)).toBe('4.2 MB')
    expect(formatSize(1024 ** 3 - 1)).toBe('1.0 GB')
    expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('gives nothing for a size that is negative or not finite', () => {
    expect(formatSize(-1)).toBeUndefined()
    expect(formatSize(Number.NaN)).toBeUndefined()
  })
})
