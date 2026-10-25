import type { DiscordMessage, ParticipantMessage, BotConfig } from '../../types.js'
import {
  CACHE_MARKER_BUFFER,
  shouldRoll,
  calculateCharacters,
  truncateToCharacterLimit,
  truncateToMessageLimit,
  determineCacheMarker,
  findFallbackCacheMarker,
} from '../rolling.js'
import { logger } from '../../utils/logger.js'

export function applyLimits(
  messages: ParticipantMessage[],
  messagesSinceRoll: number,
  config: BotConfig
): { messages: ParticipantMessage[], didTruncate: boolean, messagesRemoved?: number } {
  const totalChars = calculateCharacters(messages)

  const rollDecision = shouldRoll(messagesSinceRoll, totalChars, config)

  const normalLimit = config.recency_window_characters || 100000
  const messageLimit = config.recency_window_messages || Infinity

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
    logger.info({
      totalChars,
      limit: normalLimit,
      messageCount: messages.length,
    }, 'Caching disabled - applying character limit without rolling')
  }

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

export function determineCacheMarkerFromMessages(
  messages: DiscordMessage[],
  lastMarker: string | null,
  didRoll: boolean,
  botDisplayName?: string
): string | null {
  const messageIds = messages.map(m => m.id)

  let botMessageIds: Set<string> | undefined
  if (botDisplayName) {
    botMessageIds = new Set<string>()
    for (const m of messages) {
      if (m.author.displayName === botDisplayName) {
        botMessageIds.add(m.id)
      }
    }
  }

  return determineCacheMarker(messageIds, lastMarker, didRoll, CACHE_MARKER_BUFFER, botMessageIds)
}

export function recoverOrphanedCacheMarker(
  cacheMarker: string,
  participantMessages: ParticipantMessage[],
  botName: string
): string | null {
  const markerExists = participantMessages.some(m => m.messageId === cacheMarker)

  if (markerExists) {
    return cacheMarker
  }

  const fallbackMarker = findFallbackCacheMarker(participantMessages, botName)

  if (fallbackMarker) {
    logger.warn({
      originalMarker: cacheMarker,
      fallbackMarker,
      totalMessages: participantMessages.length,
    }, 'Cache marker orphaned - using fallback')
    return fallbackMarker
  }

  const lastResortIdx = Math.max(0, participantMessages.length - CACHE_MARKER_BUFFER)
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
