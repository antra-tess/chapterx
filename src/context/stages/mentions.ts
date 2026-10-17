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
 * Apply a mention format template to all <@name> and <reply:@name> patterns.
 *
 * The template uses {name} as placeholder: '@{name}', '{name}', '[{name}]', etc.
 * When usernameToDisplayName is provided, names are resolved to display names first.
 *
 * This replaces rewriteMentionsForDisplayNames when mention_format is configured —
 * it handles both name resolution and format application in one pass.
 */
export function applyMentionFormat(
  content: ContentBlock[],
  format: string,
  usernameToDisplayName?: Map<string, string>,
  botName?: string
): void {
  for (const block of content) {
    if (block.type === 'text') {
      // Format inline mentions: <@name> → format template
      block.text = block.text.replace(/<@([^>]+)>/g, (_match, name: string) => {
        const resolved = resolveName(name, usernameToDisplayName, botName)
        return format.replace('{name}', resolved)
      })

      // Format reply tags: <reply:@name> → (replying to <formatted>)
      block.text = block.text.replace(/<reply:@([^>]+)>/g, (_match, name: string) => {
        const resolved = resolveName(name, usernameToDisplayName, botName)
        const formatted = format.replace('{name}', resolved)
        return `(replying to ${formatted})`
      })
    }
  }
}

/**
 * Resolve a username to its display name if available.
 * Bot name is always kept as-is (it's already config.name).
 */
function resolveName(
  name: string,
  usernameToDisplayName?: Map<string, string>,
  botName?: string
): string {
  // Bot name is already normalized to config.name — keep as-is
  if (botName && name === botName) return name
  // Resolve to display name if available
  return usernameToDisplayName?.get(name) || name
}

/**
 * Strip reply tags from content blocks.
 * Handles both formats: <reply:@name> (default) and (replying to ...) (after formatting).
 */
export function stripReplyTags(content: ContentBlock[]): void {
  for (const block of content) {
    if (block.type === 'text') {
      block.text = block.text
        .replace(/^<reply:@[^>]+>\s*/, '')
        .replace(/^\(replying to [^)]+\)\s*/, '')
    }
  }
}
