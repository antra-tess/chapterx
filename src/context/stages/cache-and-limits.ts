/**
 * Context limits enforcement and cache marker management
 */

import type { DiscordMessage, ParticipantMessage, BotConfig } from '../../types.js'
import {
  shouldRoll,
  calculateCharacters,
  truncateToCharacterLimit,
  truncateToMessageLimit,
  determineCacheMarker,
  findFallbackCacheMarker,
} from '../rolling.js'
import { logger } from '../../utils/logger.js'

/**
 * Apply limits on assembled context (after images and tools added).
 * This is the ONLY place limits are enforced — accounts for total payload size.
 *
 * Uses membrane's rolling logic pattern via rolling.ts helpers.
 */
export function applyLimits(
  messages: ParticipantMessage[],
  messagesSinceRoll: number,
  config: BotConfig
): { messages: ParticipantMessage[], didTruncate: boolean, messagesRemoved?: number } {
  // Calculate total characters (excludes images - they have separate limits)
  const totalChars = calculateCharacters(messages)

  // Use membrane's rolling decision logic
  const rollDecision = shouldRoll(messagesSinceRoll, totalChars, config)

  const normalLimit = config.recency_window_characters || 100000
  const messageLimit = config.recency_window_messages || Infinity

  // Hard limit exceeded - force truncation to normal limit
  if (rollDecision.hardLimitExceeded) {
    logger.warn({
      totalChars,
      hardMax: config.hard_max_characters || 500000,
      normalLimit,
      messageCount: messages.length
    }, 'HARD LIMIT EXCEEDED - Truncating to normal limit and forcing roll')

    const result = truncateToCharacterLimit(messages, normalLimit)
    return {
      messages: result.messages,
      didTruncate: true,
      messagesRemoved: result.removed
    }
  }

  // Not rolling yet - keep all messages for cache efficiency
  // But still enforce limits when context exceeds them
  if (!rollDecision.shouldRoll) {
    const cachingEnabled = config.prompt_caching !== false;
    if (cachingEnabled && totalChars <= normalLimit) {
      logger.debug({
        messagesSinceRoll,
        threshold: config.rolling_threshold,
        messageCount: messages.length,
        totalChars,
        totalMB: (totalChars / 1024 / 1024).toFixed(2),
        cachingEnabled,
      }, 'Not rolling yet - keeping all messages for cache')
      return { messages, didTruncate: false, messagesRemoved: 0 }
    }
    // Caching disabled and over limit - truncate anyway
    logger.info({
      totalChars,
      limit: normalLimit,
      messageCount: messages.length,
    }, 'Caching disabled - applying character limit without rolling')
  }

  // Time to roll - apply limits
  // Character limit
  if (totalChars > normalLimit) {
    logger.info({
      totalChars,
      limit: normalLimit,
      messageCount: messages.length,
      reason: rollDecision.reason
    }, 'Rolling: Character limit exceeded, truncating final context')

    const result = truncateToCharacterLimit(messages, normalLimit)
    return {
      messages: result.messages,
      didTruncate: true,
      messagesRemoved: result.removed
    }
  }

  // Message count limit
  if (messages.length > messageLimit) {
    logger.info({
      messageCount: messages.length,
      limit: messageLimit,
      keptChars: totalChars,
      reason: rollDecision.reason
    }, 'Rolling: Message count limit exceeded, truncating')

    const result = truncateToMessageLimit(messages, messageLimit)
    return {
      messages: result.messages,
      didTruncate: true,
      messagesRemoved: result.removed
    }
  }

  return { messages, didTruncate: false, messagesRemoved: 0 }
}

/**
 * Determine cache marker position using membrane's pattern.
 * Passes bot message IDs so the marker prefers non-bot messages
 * that won't be merged during activation injection.
 */
export function determineCacheMarkerFromMessages(
  messages: DiscordMessage[],
  lastMarker: string | null,
  didRoll: boolean,
  botDisplayName?: string
): string | null {
  // Extract message IDs and delegate to helper
  const messageIds = messages.map(m => m.id)

  // Build set of bot message IDs so determineCacheMarker can avoid them
  let botMessageIds: Set<string> | undefined
  if (botDisplayName) {
    botMessageIds = new Set<string>()
    for (const m of messages) {
      if (m.author.displayName === botDisplayName) {
        botMessageIds.add(m.id)
      }
    }
  }

  return determineCacheMarker(messageIds, lastMarker, didRoll, 20, botMessageIds)
}

/**
 * Recover an orphaned cache marker.
 *
 * The marker was selected from raw DiscordMessages, but some messages may have been
 * merged or filtered during transformation to ParticipantMessages. If the marker message
 * no longer exists, find a valid fallback.
 *
 * Returns the recovered marker, or null if no valid marker could be found.
 */
export function recoverOrphanedCacheMarker(
  cacheMarker: string,
  participantMessages: ParticipantMessage[],
  botName: string
): string | null {
  // Check if marker exists in participant messages
  const markerExists = participantMessages.some(m => m.messageId === cacheMarker)

  if (markerExists) {
    return cacheMarker
  }

  // Marker message was merged/filtered - find a valid fallback using helper
  const fallbackMarker = findFallbackCacheMarker(participantMessages, botName)

  if (fallbackMarker) {
    logger.warn({
      originalMarker: cacheMarker,
      fallbackMarker,
      totalMessages: participantMessages.length,
    }, 'Cache marker orphaned - using fallback')
    return fallbackMarker
  }

  // Last resort: pick ANY message near the tail as cache boundary.
  // A slightly unstable prefix is far better than 0 caching (full cost every activation).
  const lastResortIdx = Math.max(0, participantMessages.length - 20)
  const lastResortMarker = participantMessages[lastResortIdx]?.messageId ?? null
  if (lastResortMarker) {
    logger.warn({
      originalMarker: cacheMarker,
      lastResortMarker,
      lastResortIdx,
      totalMessages: participantMessages.length,
    }, 'Cache marker orphaned, using last-resort marker to preserve caching')
    return lastResortMarker
  }

  logger.warn({
    originalMarker: cacheMarker,
    totalMessages: participantMessages.length,
  }, 'Cache marker orphaned, no messages available - caching disabled')
  return null
}
