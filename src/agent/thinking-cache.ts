/**
 * Thinking block cache — persists native extended-thinking blocks (with their
 * cryptographic signatures) per bot/channel so they can be re-attached to the
 * bot's past turns during context rebuild.
 *
 * Mirrors the tool cache pattern (src/tools/system.ts): hourly JSONL files
 * under <cacheDir>/thinking/<botId>/<channelId>/, entries keyed by the bot's
 * sent Discord message IDs, filtered against live messages on load.
 *
 * Why: on models like Claude Fable 5 (thinking display:'omitted'), the
 * signature carries the encrypted full reasoning — the API decrypts it
 * server-side when the block is passed back, restoring reasoning continuity.
 * Blocks must round-trip verbatim, including signature-only blocks whose
 * thinking field is an empty string.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ContentBlock, ThinkingContent, RedactedThinkingContent } from '../types.js'
import { logger } from '../utils/logger.js'

export type ThinkingBlock = ThinkingContent | RedactedThinkingContent

export interface ThinkingCacheEntry {
  /** The bot's sent Discord message IDs for the activation that produced these blocks */
  botMessageIds: string[]
  /** Thinking blocks exactly as received from the API (verbatim round-trip) */
  blocks: ThinkingBlock[]
  /** Model that produced the blocks — blocks are model-bound and must be
   *  stripped when the bot's model changes (per Anthropic docs) */
  model?: string
  timestamp: string
}

function channelDir(cacheDir: string, botId: string, channelId: string): string {
  return join(cacheDir, 'thinking', botId, channelId)
}

/**
 * Persist thinking blocks for an activation. No-op when there are no blocks
 * or no sent messages to anchor them to (phantom activations).
 */
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

/**
 * Load thinking blocks for a channel, keyed by the FIRST sent bot message ID
 * of each activation (the anchor message the blocks get prepended to).
 * Entries whose anchor message no longer exists in context are dropped.
 */
export function loadThinkingBlocks(
  cacheDir: string,
  botId: string,
  channelId: string,
  existingMessageIds?: Set<string>,
  currentModel?: string
): Map<string, ThinkingBlock[]> {
  const result = new Map<string, ThinkingBlock[]>()
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
        // Thinking blocks are bound to the model that produced them — strip
        // them when the bot's model changed (other models ignore the blocks
        // but they still cost input tokens, per Anthropic docs)
        if (currentModel && entry.model && entry.model !== currentModel) {
          filtered++
          continue
        }
        // Last write wins per anchor (re-generations replace earlier blocks)
        result.set(anchor, entry.blocks)
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

/**
 * Prepend cached thinking blocks to the bot's corresponding messages.
 * Must run BEFORE consecutive-message merging so anchors resolve by messageId.
 */
export function attachThinkingBlocks(
  messages: Array<{ messageId?: string; isBot?: boolean; content: ContentBlock[] }>,
  thinkingByMessageId: Map<string, ThinkingBlock[]>
): number {
  if (thinkingByMessageId.size === 0) return 0
  let attached = 0
  for (const msg of messages) {
    if (!msg.messageId || !msg.isBot) continue
    const blocks = thinkingByMessageId.get(msg.messageId)
    if (!blocks) continue
    msg.content.unshift(...(blocks as ContentBlock[]))
    attached++
  }
  return attached
}
