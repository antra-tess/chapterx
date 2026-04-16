/**
 * Message filtering and merging transforms
 *
 * Pure functions that operate on message arrays:
 * - mergeConsecutiveBotMessages: combine sequential bot messages at Discord level
 * - filterDotMessages: remove dot commands and reaction-hidden messages
 * - mergeConsecutiveParticipantMessages: combine sequential same-participant messages at LLM level
 */

import type { DiscordMessage, ParticipantMessage } from '../../types.js'

/**
 * Merge consecutive messages from the same bot into a single message.
 * Dot messages (commands like .config) are never merged — they need to stay
 * separate so filterDotMessages can remove them later.
 */
export function mergeConsecutiveBotMessages(
  messages: DiscordMessage[],
  botName: string
): DiscordMessage[] {
  const merged: DiscordMessage[] = []

  for (const msg of messages) {
    const isBotMessage = msg.author.displayName === botName
    const lastMsg = merged[merged.length - 1]

    // Don't merge messages starting with "." (tool outputs, preambles)
    // These need to stay separate so they can be filtered later
    // Strip reply prefix before checking (replies look like "<reply:@user> .test")
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
      // Merge with previous message (space separator)
      lastMsg.content = `${lastMsg.content} ${msg.content}`
      // Keep attachments
      lastMsg.attachments.push(...msg.attachments)
    } else {
      merged.push({ ...msg })
    }
  }

  return merged
}

/**
 * Filter dot commands and reaction-hidden messages from context.
 *
 * Dot commands: period followed by a letter (.config, .history, .m, etc.)
 * Does NOT match ellipsis (... or ..) which users type normally.
 * .steer is preserved when steerVisible is true.
 *
 * Also filters messages with the 🫥 (dotted_line_face) reaction.
 */
export function filterDotMessages(messages: DiscordMessage[], steerVisible: boolean = true): DiscordMessage[] {
  return messages.filter((msg) => {
    // Filter dot commands (after stripping reply prefix)
    const contentWithoutReply = msg.content.trim().replace(/^<reply:@[^>]+>\s*/, '')
    if (/^\.[a-zA-Z]/.test(contentWithoutReply) && !(steerVisible && /^\.steer\b/.test(contentWithoutReply))) {
      return false
    }
    // Filter messages with dotted_line_face reaction (🫥)
    if (msg.reactions?.some(r => r.emoji === '🫥' || r.emoji === 'dotted_line_face')) {
      return false
    }
    return true
  })
}

/**
 * Merge consecutive ParticipantMessages from the same participant.
 * Handles "m continue" scenarios where bot has multiple sequential messages
 * that should appear as one turn in the LLM context.
 */
export function mergeConsecutiveParticipantMessages(
  messages: ParticipantMessage[]
): ParticipantMessage[] {
  const merged: ParticipantMessage[] = []

  for (const msg of messages) {
    const lastMsg = merged[merged.length - 1]

    // Check if we should merge with previous message
    if (lastMsg && lastMsg.participant === msg.participant) {
      // Merge content arrays
      // For text blocks, we join with space; for other types, just append
      const lastTextBlockIndex = lastMsg.content.map(c => c.type).lastIndexOf('text')
      const lastTextBlock = lastTextBlockIndex >= 0 ? lastMsg.content[lastTextBlockIndex] : null
      const firstContentBlock = msg.content[0]

      if (lastTextBlock && lastTextBlock.type === 'text' && firstContentBlock?.type === 'text') {
        // Join text with space
        lastTextBlock.text = `${lastTextBlock.text} ${firstContentBlock.text}`
        // Append remaining content blocks
        lastMsg.content.push(...msg.content.slice(1))
      } else {
        // Just append all content blocks
        lastMsg.content.push(...msg.content)
      }

      // Keep the cache breakpoint if either message had it
      if (msg.cacheBreakpoint) {
        lastMsg.cacheBreakpoint = msg.cacheBreakpoint
      }
    } else {
      // Different participant - start new message
      merged.push({ ...msg, content: [...msg.content] })
    }
  }

  return merged
}
