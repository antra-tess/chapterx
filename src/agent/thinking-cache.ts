/**
 * On models like Claude Fable 5 (thinking display:'omitted'), the signature
 * carries the encrypted full reasoning — the API decrypts it server-side when
 * the block is passed back. Blocks must round-trip verbatim, including
 * signature-only blocks whose thinking field is an empty string.
 *
 * The API rejects any turn in which thinking blocks from different responses
 * sit next to each other ("thinking or redacted_thinking blocks in the latest
 * assistant message cannot be modified" — reported for whichever turn has
 * them, latest or not). Blocks from different responses separated by other
 * content (e.g. merged consecutive bot messages: thinking, text, thinking,
 * text) are accepted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ContentBlock, ThinkingContent, RedactedThinkingContent } from '../types.js'
import { logger } from '../utils/logger.js'

export type ThinkingBlock = ThinkingContent | RedactedThinkingContent

export interface ThinkingGroup {
  blocks: ThinkingBlock[]
  singleResponse: boolean
}

export interface ThinkingCacheEntry {
  botMessageIds: string[]
  blocks: ThinkingBlock[]
  singleResponse?: boolean
  model?: string
  timestamp: string
}

function channelDir(cacheDir: string, botId: string, channelId: string): string {
  return join(cacheDir, 'thinking', botId, channelId)
}

function isThinkingBlock(block: { type: string }): block is ThinkingBlock {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/**
 * Membrane returns every step's blocks in order — [thinking, tool_use,
 * tool_result, thinking, text] — so the final response starts after the last
 * tool_use/tool_result block.
 */
export function finalStepThinkingBlocks(content: ReadonlyArray<{ type: string }>): ThinkingBlock[] {
  let start = 0
  content.forEach((block, i) => {
    if (block.type === 'tool_use' || block.type === 'tool_result') start = i + 1
  })
  return content.slice(start).filter(isThinkingBlock)
}

export function persistThinkingBlocks(
  cacheDir: string,
  botId: string,
  channelId: string,
  botMessageIds: string[],
  blocks: ThinkingBlock[],
  model?: string
): void {
  if (blocks.length === 0 || botMessageIds.length === 0) return

  const dirPath = channelDir(cacheDir, botId, channelId)
  const hour = new Date().toISOString().substring(0, 13).replace(/:/g, '-')
  const filePath = join(dirPath, `${hour}.jsonl`)

  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }
    const entry: ThinkingCacheEntry = {
      botMessageIds,
      blocks,
      singleResponse: true,
      ...(model ? { model } : {}),
      timestamp: new Date().toISOString(),
    }
    appendFileSync(filePath, JSON.stringify(entry) + '\n')
    logger.debug(
      { botId, channelId, blocks: blocks.length, anchor: botMessageIds[0] },
      'Persisted thinking blocks'
    )
  } catch (error) {
    logger.error({ error, filePath }, 'Failed to persist thinking blocks')
  }
}

export function loadThinkingBlocks(
  cacheDir: string,
  botId: string,
  channelId: string,
  existingMessageIds?: Set<string>
): Map<string, ThinkingGroup> {
  const result = new Map<string, ThinkingGroup>()
  const dirPath = channelDir(cacheDir, botId, channelId)
  if (!existsSync(dirPath)) return result

  let filtered = 0
  try {
    const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')).sort()
    for (const file of files) {
      const content = readFileSync(join(dirPath, file), 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        let entry: ThinkingCacheEntry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        const anchor = entry.botMessageIds?.[0]
        if (!anchor || !Array.isArray(entry.blocks) || entry.blocks.length === 0) continue
        if (existingMessageIds && !existingMessageIds.has(anchor)) {
          filtered++
          continue
        }
        result.set(anchor, {
          blocks: entry.blocks,
          singleResponse: entry.singleResponse === true || entry.blocks.length === 1,
        })
      }
    }
  } catch (error) {
    logger.warn({ error, dirPath }, 'Failed to load thinking cache')
  }

  if (result.size > 0 || filtered > 0) {
    logger.debug({ botId, channelId, loaded: result.size, filtered }, 'Loaded thinking cache')
  }
  return result
}

export function attachThinkingBlocks(
  messages: Array<{ messageId?: string; isBot?: boolean; content: ContentBlock[] }>,
  thinkingByMessageId: Map<string, ThinkingGroup>
): number {
  if (thinkingByMessageId.size === 0) return 0
  let attached = 0
  for (const msg of messages) {
    if (!msg.messageId || !msg.isBot) continue
    const group = thinkingByMessageId.get(msg.messageId)
    if (!group) continue
    msg.content.unshift(...(group.blocks as ContentBlock[]))
    attached++
  }
  return attached
}

export function sanitizeThinkingRuns(
  messages: Array<{ content: ContentBlock[] }>,
  groups: Iterable<ThinkingGroup>
): number {
  const groupOf = new Map<ContentBlock, ThinkingGroup>()
  for (const group of groups) {
    for (const block of group.blocks) groupOf.set(block as ContentBlock, group)
  }

  let dropped = 0
  for (const msg of messages) {
    if (!msg.content.some(isThinkingBlock)) continue
    const kept: ContentBlock[] = []
    let changed = false
    for (let i = 0; i < msg.content.length;) {
      if (!isThinkingBlock(msg.content[i]!)) {
        kept.push(msg.content[i]!)
        i++
        continue
      }
      let end = i
      while (end < msg.content.length && isThinkingBlock(msg.content[end]!)) end++
      const run = msg.content.slice(i, end)
      const group = groupOf.get(run[0]!)
      const isOneWholeResponse = !!group && group.singleResponse &&
        run.length === group.blocks.length &&
        group.blocks.every((block, k) => run[k] === block)
      if (isOneWholeResponse) {
        kept.push(...run)
      } else {
        dropped += run.length
        changed = true
      }
      i = end
    }
    if (changed) msg.content = kept
  }
  return dropped
}
