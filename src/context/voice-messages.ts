/**
 * The voice message a bot with `include_voice_messages` hears: the newest one
 * among the messages it sees, when its model can hear it and its type and size
 * let it be sent (docs/CONTEXT_ARCHITECTURE.md, Step 4).
 */

import type { BotConfig, CachedVoiceMessage, DiscordAttachment, DiscordMessage } from '../types.js'
import { GeminiAdapter } from '@animalabs/membrane'
import { adapterForModel, resolveFormatterForModel } from '../llm/membrane/factory.js'
import { logger } from '../utils/logger.js'

/**
 * The types a voice message is sent in: those Gemini's audio docs list
 * (https://ai.google.dev/gemini-api/docs/audio), less the headerless l16, alaw
 * and mulaw, whose rate is a parameter that isn't sent. Discord requires only
 * that a voice message's type begins with `audio/`.
 */
export const VOICE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/mpeg',
  'audio/m4a',
  'audio/opus',
  'audio/webm',
])

/**
 * The largest voice message sent, as Discord reports its size: 2 MB as
 * formatSize counts them (1024² bytes). Gemini takes at most 20 MB in a request
 * with inline media, images included.
 */
export const VOICE_MESSAGE_MAX_BYTES = 2 * 1024 * 1024

/** Whether a body starts with markup ('<' after any whitespace or byte-order
 *  mark), as the error page an expired CDN URL can answer with does (the
 *  connector's image download notes it). No type in the set begins so. */
export function startsWithMarkup(data: Buffer): boolean {
  return /^(?:\s|\u00ef\u00bb\u00bf)*</.test(data.subarray(0, 64).toString('latin1'))
}

/** A content type without its parameters, lowercased; undefined when there's
 *  none. `audio/ogg; codecs=opus` is `audio/ogg`. */
export function baseContentType(contentType: string | null | undefined): string | undefined {
  const base = contentType?.split(';')[0]?.trim().toLowerCase()
  return base ? base : undefined
}

/** The newest voice message's attachment among `messages`, oldest first;
 *  undefined when there's none. A merged message's later attachments are its
 *  newer ones. */
export function newestVoiceMessage(messages: readonly DiscordMessage[]): DiscordAttachment | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const attachments = messages[i]!.attachments
    for (let j = attachments.length - 1; j >= 0; j--) {
      if (attachments[j]!.voiceMessage === true) return attachments[j]
    }
  }
  return undefined
}

/** The models and modes already warned about, so each is warned about once. */
const warnedUnheard = new Set<string>()

/** Why a request for this model and mode won't carry a voice message's audio,
 *  or undefined when it will; docs/CONTEXT_ARCHITECTURE.md gives each case. */
export function voiceMessagesUnheardReason(model: string, mode?: string): string | undefined {
  const formatter = resolveFormatterForModel(model, mode)
  if (formatter !== 'native') return `membrane's ${formatter} formatter can't send audio`
  if (!model.startsWith('gemini-') && !model.startsWith('gemini_')) {
    return "voice messages go only to Gemini models (gemini-* or gemini_*) on Gemini's own adapter"
  }
  // No adapter: none built here (tests), or no route, where the request fails anyway
  const adapter = adapterForModel(model)
  if (adapter !== undefined && !(adapter instanceof GeminiAdapter)) {
    return `this model is routed to membrane's ${adapter.constructor.name} ("${adapter.name}"), not its GeminiAdapter`
  }
  return undefined
}

/** Whether this bot's requests carry the newest voice message's audio. With
 *  the setting on and a model and mode that can't, the first build warns. */
export function hearsVoiceMessages(config: Pick<BotConfig, 'include_voice_messages' | 'continuation_model' | 'mode'>): boolean {
  if (!config.include_voice_messages) return false
  const reason = voiceMessagesUnheardReason(config.continuation_model, config.mode)
  if (reason === undefined) return true
  const key = `${config.continuation_model}\u0000${config.mode ?? ''}`
  if (!warnedUnheard.has(key)) {
    warnedUnheard.add(key)
    logger.warn({ model: config.continuation_model, mode: config.mode }, `Voice messages not sent: ${reason}. Set include_voice_messages: false to stop this warning.`)
  }
  return false
}

/** The newest voice message's audio among `messages`, the messages the model
 *  sees; undefined when there's none, when its type or size rules it out, or
 *  when its download fails or gives an empty or markup body. No older one is
 *  tried in its place. */
export async function fetchNewestVoiceMessage(messages: readonly DiscordMessage[]): Promise<CachedVoiceMessage | undefined> {
  const attachment = newestVoiceMessage(messages)
  if (!attachment) return undefined
  const mediaType = baseContentType(attachment.contentType)
  if (mediaType === undefined || !VOICE_MESSAGE_TYPES.has(mediaType)) {
    logger.info({ url: attachment.url, contentType: attachment.contentType }, 'Newest voice message not sent: its type is not one of VOICE_MESSAGE_TYPES')
    return undefined
  }
  if (attachment.size > VOICE_MESSAGE_MAX_BYTES) {
    logger.info({ url: attachment.url, size: attachment.size }, 'Newest voice message not sent: it is over 2 MB')
    return undefined
  }
  try {
    const response = await fetch(attachment.url)
    if (!response.ok) {
      logger.warn({ status: response.status, url: attachment.url }, 'Failed to fetch voice message')
      return undefined
    }
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || startsWithMarkup(data)) {
      logger.warn({ url: attachment.url, bytes: data.length }, 'Downloaded voice message is empty or a markup page, not audio')
      return undefined
    }
    return { url: attachment.url, data, mediaType }
  } catch (error) {
    logger.warn({ error, url: attachment.url }, 'Failed to download voice message')
    return undefined
  }
}
