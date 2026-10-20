/**
 * DiscordConnector.convertMessage: a voice message's flag, as a mark on its
 * attachment, and an attachment's length reach Chapter X's message, for the
 * line that stands in for an attachment a request doesn't carry.
 *
 * A real DiscordConnector (its Client makes no network call until .login()),
 * given messages shaped like discord.js's, with its own flag bitfield.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection, MessageFlags, MessageFlagsBitField } from 'discord.js'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function connector(): DiscordConnector {
  const dir = mkdtempSync(join(tmpdir(), 'connector-convert-test-'))
  dirs.push(dir)
  return new DiscordConnector(new EventQueue(), { token: 'fake', cacheDir: dir, maxBackoffMs: 100 })
}

function discordMessage(flags: number, attachment: Record<string, unknown>) {
  return {
    id: 'm1',
    channelId: 'ch-1',
    guildId: 'guild-1',
    content: '',
    mentions: { users: new Collection(), roles: new Collection() },
    client: { users: { cache: new Collection() } },
    guild: null,
    author: { id: 'u-bob', username: 'bob', globalName: null, bot: false },
    member: null,
    reference: null,
    createdAt: new Date('2026-10-19T12:00:00Z'),
    attachments: new Collection([[String(attachment.id), attachment]]),
    reactions: { cache: new Collection() },
    flags: new MessageFlagsBitField(flags),
  }
}

describe('DiscordConnector.convertMessage', () => {
  it('marks a voice message\'s attachment by its flag, among others, and keeps its length', () => {
    const converted = connector().convertMessage(discordMessage(MessageFlags.IsVoiceMessage | MessageFlags.SuppressNotifications, {
      id: 'a1', url: 'https://cdn.example/a1/clip.ogg', name: 'clip.ogg',
      contentType: 'audio/ogg', size: 28290, width: null, height: null, duration: 34.4,
    }) as never)
    expect(converted.attachments).toEqual([{
      id: 'a1', url: 'https://cdn.example/a1/clip.ogg', filename: 'clip.ogg',
      contentType: 'audio/ogg', size: 28290, width: undefined, height: undefined, duration: 34.4, voiceMessage: true,
    }])
  })

  it('leaves an unflagged message\'s audio unmarked, though named like a voice message', () => {
    const converted = connector().convertMessage(discordMessage(MessageFlags.SuppressEmbeds, {
      id: 'a2', url: 'https://cdn.example/a2/voice-message.ogg', name: 'voice-message.ogg',
      contentType: 'audio/ogg', size: 28290, width: null, height: null, duration: 7,
    }) as never)
    expect(converted.attachments).toEqual([{
      id: 'a2', url: 'https://cdn.example/a2/voice-message.ogg', filename: 'voice-message.ogg',
      contentType: 'audio/ogg', size: 28290, width: undefined, height: undefined, duration: 7,
    }])
    expect('voiceMessage' in converted.attachments[0]!).toBe(false)
  })

  it('gives an attachment Discord reports no length for none', () => {
    const converted = connector().convertMessage(discordMessage(0, {
      id: 'a3', url: 'https://cdn.example/a3/cat.png', name: 'cat.png',
      contentType: 'image/png', size: 120000, width: 64, height: 48, duration: null,
    }) as never)
    expect(converted.attachments).toEqual([{
      id: 'a3', url: 'https://cdn.example/a3/cat.png', filename: 'cat.png',
      contentType: 'image/png', size: 120000, width: 64, height: 48,
    }])
    expect('duration' in converted.attachments[0]!).toBe(false)
  })
})
