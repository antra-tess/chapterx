import type { DiscordAttachment } from '../../types.js'

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

export function attachmentKind(contentType: string | undefined): 'audio' | 'video' | 'image' | 'file' {
  const top = contentType?.split('/')[0]?.toLowerCase()
  return top === 'audio' || top === 'video' || top === 'image' ? top : 'file'
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

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
