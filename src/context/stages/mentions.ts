import type { ContentBlock } from '../../types.js'

export function rewriteMentionsForDisplayNames(
  content: ContentBlock[],
  usernameToDisplayName: Map<string, string>,
  botName: string
): void {
  for (const block of content) {
    if (block.type === 'text') {
      for (const [username, displayName] of usernameToDisplayName) {
        const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        block.text = block.text
          .replace(new RegExp(`<@${escaped}>`, 'g'), `@${displayName}`)
          .replace(new RegExp(`<reply:@${escaped}>`, 'g'), `(replying to @${displayName})`)
      }
      const escapedBotName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      block.text = block.text
        .replace(new RegExp(`<@${escapedBotName}>`, 'g'), `@${botName}`)
        .replace(new RegExp(`<reply:@${escapedBotName}>`, 'g'), `(replying to @${botName})`)
    }
  }
}

export function applyMentionFormat(
  content: ContentBlock[],
  format: string,
  usernameToDisplayName?: Map<string, string>,
  botName?: string
): void {
  for (const block of content) {
    if (block.type === 'text') {
      block.text = block.text.replace(/<@([^>]+)>/g, (_match, name: string) => {
        const resolved = resolveName(name, usernameToDisplayName, botName)
        return format.replace('{name}', resolved)
      })

      block.text = block.text.replace(/<reply:@([^>]+)>/g, (_match, name: string) => {
        const resolved = resolveName(name, usernameToDisplayName, botName)
        const formatted = format.replace('{name}', resolved)
        return `(replying to ${formatted})`
      })
    }
  }
}

function resolveName(
  name: string,
  usernameToDisplayName?: Map<string, string>,
  botName?: string
): string {
  if (botName && name === botName) return name
  return usernameToDisplayName?.get(name) || name
}

export function stripReplyTags(content: ContentBlock[]): void {
  for (const block of content) {
    if (block.type === 'text') {
      block.text = block.text
        .replace(/^<reply:@[^>]+>\s*/, '')
        .replace(/^\(replying to [^)]+\)\s*/, '')
    }
  }
}
