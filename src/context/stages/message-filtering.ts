import type { DiscordMessage, ParticipantMessage } from '../../types.js'

export function mergeConsecutiveBotMessages(
  messages: DiscordMessage[],
  botName: string
): DiscordMessage[] {
  const merged: DiscordMessage[] = []

  for (const msg of messages) {
    const isBotMessage = msg.author.displayName === botName
    const lastMsg = merged[merged.length - 1]

    const contentWithoutReply = msg.content.trim().replace(/^<reply:@[^>]+>\s*/, '')
    const lastContentWithoutReply = lastMsg?.content.trim().replace(/^<reply:@[^>]+>\s*/, '') || ''
    const isDotMessage = contentWithoutReply.startsWith('.')
    const lastIsDotMessage = lastContentWithoutReply.startsWith('.')

    if (
      isBotMessage &&
      lastMsg &&
      lastMsg.author.displayName === botName &&
      !isDotMessage &&
      !lastIsDotMessage
    ) {
      lastMsg.content = `${lastMsg.content} ${msg.content}`
      lastMsg.attachments.push(...msg.attachments)
    } else {
      merged.push({ ...msg })
    }
  }

  return merged
}

export function filterDotMessages(messages: DiscordMessage[], steerVisible: boolean = true, ignoreDotted: boolean = true): DiscordMessage[] {
  if (!ignoreDotted) return messages
  return messages.filter((msg) => {
    // Discord returns the emoji name without variation selectors (U+FE0F),
    // so match both forms: 👁‍🗨 (bare) and 👁️‍🗨️ (with VS16)
    if (msg.reactions?.some(r => r.emoji === '👁‍🗨' || r.emoji === '👁️‍🗨️' || r.emoji === 'eye_in_speech_bubble')) {
      return true
    }

    const stripped = msg.content.trim()
      .replace(/^<reply:@[^>]+>\s*/, '')
      .replace(/^(<@[^>]+>\s*|@[\w.-]+\s*)+/, '')
    if (/^\.(?!\.)/.test(stripped) && !(steerVisible && /^\.steer\b/.test(stripped))) {
      return false
    }
    if (msg.reactions?.some(r => r.emoji === '🫥' || r.emoji === 'dotted_line_face')) {
      return false
    }
    return true
  })
}

export function mergeConsecutiveParticipantMessages(
  messages: ParticipantMessage[]
): ParticipantMessage[] {
  const merged: ParticipantMessage[] = []

  for (const msg of messages) {
    const lastMsg = merged[merged.length - 1]

    if (lastMsg && lastMsg.participant === msg.participant && msg.isBot) {
      const lastTextBlockIndex = lastMsg.content.map(c => c.type).lastIndexOf('text')
      const lastTextBlock = lastTextBlockIndex >= 0 ? lastMsg.content[lastTextBlockIndex] : null
      const firstContentBlock = msg.content[0]

      if (lastTextBlock && lastTextBlock.type === 'text' && firstContentBlock?.type === 'text') {
        lastTextBlock.text = `${lastTextBlock.text} ${firstContentBlock.text}`
        lastMsg.content.push(...msg.content.slice(1))
      } else {
        lastMsg.content.push(...msg.content)
      }

      if (msg.cacheBreakpoint) {
        lastMsg.cacheBreakpoint = msg.cacheBreakpoint
      }
    } else {
      merged.push({ ...msg, content: [...msg.content] })
    }
  }

  return merged
}
