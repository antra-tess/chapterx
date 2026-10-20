/**
 * The line that stands in a message for an attachment its request doesn't
 * carry, so the model is told something was sent rather than finding the
 * message missing or the attachment unmentioned.
 */

import type { DiscordAttachment } from '../../types.js'

/**
 * A Discord voice message's attachment, given its length when Discord reports
 * one:
 *   [voice message, 0:34, not included]
 * Any other attachment, with its name, kind, length when Discord reports one,
 * and size:
 *   [attachment "song.mp3", audio, 3:12, 4.2 MB, not included]
 */
export function uncarriedAttachmentLine(attachment: DiscordAttachment): string {
  const duration = formatDuration(attachment.duration)
  if (attachment.voiceMessage === true) {
    return `[voice message, ${duration ? `${duration}, ` : ''}not included]`
  }
  const parts = [
    `attachment ${JSON.stringify(attachment.filename)}`,
    attachmentKind(attachment.contentType),
    duration,
    formatSize(attachment.size),
  ].filter((part): part is string => Boolean(part))
  return `[${parts.join(', ')}, not included]`
}

/** audio, video or image by the content type's top level; file otherwise,
 *  including when Discord gave no content type. */
export function attachmentKind(contentType: string | undefined): 'audio' | 'video' | 'image' | 'file' {
  const top = contentType?.split('/')[0]?.toLowerCase()
  return top === 'audio' || top === 'video' || top === 'image' ? top : 'file'
}

/** Seconds as m:ss, or h:mm:ss from an hour, rounded to the second; undefined
 *  for a length that's missing, negative or not finite. */
export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Bytes as B or KB, rounded, or MB and GB to one decimal, at 1024 per step,
 *  in the smallest unit whose rounded figure is under 1024; undefined for a
 *  size that's negative or not finite. */
export function formatSize(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes < 0) return undefined
  const b = Math.round(bytes)
  if (b < 1024) return `${b} B`
  const kb = Math.round(bytes / 1024)
  if (kb < 1024) return `${kb} KB`
  const mb = (bytes / 1024 ** 2).toFixed(1)
  if (Number(mb) < 1024) return `${mb} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
