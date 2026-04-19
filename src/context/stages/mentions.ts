/**
 * Mention and reply tag rewriting for LLM context
 */

import type { ContentBlock } from '../../types.js'

/**
 * Rewrite <@username> and <reply:@username> mentions to use display names
 * without angle brackets, so the LLM sees a natural format it will mirror.
 */
export function rewriteMentionsForDisplayNames(
  content: ContentBlock[],
  usernameToDisplayName: Map<string, string>,
  botName: string
): void {
  for (const block of content) {
    if (block.type === 'text') {
      // Rewrite other users' mentions: <@username> → @DisplayName
      for (const [username, displayName] of usernameToDisplayName) {
        const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        block.text = block.text
          .replace(new RegExp(`<@${escaped}>`, 'g'), `@${displayName}`)
          .replace(new RegExp(`<reply:@${escaped}>`, 'g'), `(replying to @${displayName})`)
      }
      // Also strip brackets from bot mentions: <@BotName> → @BotName
      const escapedBotName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      block.text = block.text
        .replace(new RegExp(`<@${escapedBotName}>`, 'g'), `@${botName}`)
        .replace(new RegExp(`<reply:@${escapedBotName}>`, 'g'), `(replying to @${botName})`)
    }
  }
}

/**
 * Strip reply tags from content blocks.
 * Handles both formats: <reply:@name> (default) and (replying to @name) (display names mode).
 */
export function stripReplyTags(content: ContentBlock[]): void {
  for (const block of content) {
    if (block.type === 'text') {
      block.text = block.text
        .replace(/^<reply:@[^>]+>\s*/, '')
        .replace(/^\(replying to @[^)]+\)\s*/, '')
    }
  }
}
