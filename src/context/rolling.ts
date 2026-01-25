/**
 * Rolling Context Helpers
 * 
 * Bridges ChapterX's context management with membrane's rolling logic.
 * ChapterX handles Discord-specific transforms; membrane provides the rolling decisions.
 */

import {
  shouldRoll as membranesShouldRoll,
  type ContextState,
  type ContextConfig,
} from 'membrane';
import type { BotConfig, ParticipantMessage } from '../types.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// State Conversion
// ============================================================================

/**
 * Convert ChapterX's per-channel state to membrane's ContextState format.
 * This allows using membrane's shouldRoll() with ChapterX's state tracking.
 */
export function toMembraneState(
  messagesSinceRoll: number,
  lastCacheMarker: string | null,
  cachedStartMessageId: string | null
): ContextState {
  return {
    cacheMarkers: lastCacheMarker 
      ? [{ messageId: lastCacheMarker, messageIndex: -1, tokenEstimate: 0 }]
      : [],
    windowMessageIds: [], // Not tracked in ChapterX's ChannelState
    messagesSinceRoll,
    tokensSinceRoll: 0, // ChapterX uses message count, not tokens
    inGracePeriod: false, // ChapterX doesn't use grace periods
    cachedStartMessageId: cachedStartMessageId ?? undefined,
  };
}

/**
 * Convert ChapterX's BotConfig to membrane's ContextConfig format.
 */
export function toMembraneConfig(config: BotConfig): ContextConfig {
  return {
    rolling: {
      threshold: config.rolling_threshold,
      buffer: 20, // ChapterX uses fixed buffer of 20
      unit: 'messages',
    },
    limits: {
      maxCharacters: config.hard_max_characters || 500000,
      maxMessages: config.recency_window_messages,
    },
    cache: {
      enabled: config.prompt_caching !== false,
      points: 1,
      preferUserMessages: true,
    },
  };
}

// ============================================================================
// Rolling Decision
// ============================================================================

export interface ChapterXRollDecision {
  shouldRoll: boolean;
  reason?: 'threshold' | 'grace_exceeded' | 'hard_limit';
  hardLimitExceeded: boolean;
}

/**
 * Determine if context should roll using membrane's logic.
 * 
 * @param messagesSinceRoll - Messages since last roll (from ChannelState)
 * @param totalCharacters - Total characters in current context
 * @param config - Bot configuration
 * @returns Roll decision with reason
 */
export function shouldRoll(
  messagesSinceRoll: number,
  totalCharacters: number,
  config: BotConfig
): ChapterXRollDecision {
  const membraneState = toMembraneState(messagesSinceRoll, null, null);
  const membraneConfig = toMembraneConfig(config);
  
  // Check hard limit first (ChapterX-specific: always enforced)
  const hardMaxCharacters = config.hard_max_characters || 500000;
  if (totalCharacters > hardMaxCharacters) {
    logger.warn({
      totalCharacters,
      hardMax: hardMaxCharacters,
    }, 'Hard character limit exceeded');
    
    return {
      shouldRoll: true,
      reason: 'hard_limit',
      hardLimitExceeded: true,
    };
  }
  
  // Use membrane's shouldRoll for threshold check
  const decision = membranesShouldRoll(
    membraneState,
    0, // messageCount - not used when unit is 'messages' and we pass state
    0, // totalTokens - not used
    totalCharacters,
    membraneConfig
  );
  
  return {
    shouldRoll: decision.shouldRoll,
    reason: decision.reason,
    hardLimitExceeded: false,
  };
}

// ============================================================================
// Truncation
// ============================================================================

/**
 * Calculate total characters in ParticipantMessage array.
 * Matches ChapterX's existing character counting (excludes images).
 */
export function calculateCharacters(messages: ParticipantMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        totalChars += (block as any).text.length;
      } else if (block.type === 'tool_result') {
        const toolBlock = block as any;
        const content = typeof toolBlock.content === 'string' 
          ? toolBlock.content 
          : JSON.stringify(toolBlock.content);
        totalChars += content.length;
      }
      // Images not counted - handled separately
    }
  }
  return totalChars;
}

/**
 * Truncate messages to fit within character limit.
 * Keeps most recent messages (truncates from beginning).
 * 
 * @param messages - Messages to truncate
 * @param charLimit - Maximum characters to keep
 * @returns Truncated messages and count of removed messages
 */
export function truncateToCharacterLimit(
  messages: ParticipantMessage[],
  charLimit: number
): { messages: ParticipantMessage[]; removed: number } {
  let keptChars = 0;
  let cutoffIndex = messages.length;
  
  // Count from end backwards
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    let msgSize = 0;
    
    for (const block of msg.content) {
      if (block.type === 'text') {
        msgSize += (block as any).text.length;
      } else if (block.type === 'tool_result') {
        const toolBlock = block as any;
        const content = typeof toolBlock.content === 'string' 
          ? toolBlock.content 
          : JSON.stringify(toolBlock.content);
        msgSize += content.length;
      }
    }
    
    if (keptChars + msgSize > charLimit) {
      cutoffIndex = i + 1;
      break;
    }
    
    keptChars += msgSize;
  }
  
  const truncated = messages.slice(cutoffIndex);
  
  if (cutoffIndex > 0) {
    logger.info({
      removed: cutoffIndex,
      kept: truncated.length,
      keptChars,
      charLimit,
    }, 'Truncated context to character limit');
  }
  
  return { messages: truncated, removed: cutoffIndex };
}

/**
 * Truncate messages to fit within message count limit.
 * Keeps most recent messages (truncates from beginning).
 */
export function truncateToMessageLimit(
  messages: ParticipantMessage[],
  messageLimit: number
): { messages: ParticipantMessage[]; removed: number } {
  if (messages.length <= messageLimit) {
    return { messages, removed: 0 };
  }
  
  const removed = messages.length - messageLimit;
  return {
    messages: messages.slice(removed),
    removed,
  };
}

// ============================================================================
// Cache Marker Placement
// ============================================================================

/**
 * Determine cache marker position.
 * 
 * Logic:
 * - If not rolling and existing marker is valid, keep it (cache stability)
 * - Otherwise, place marker at (length - buffer) from end
 * 
 * @param messageIds - Array of message IDs in current context
 * @param lastMarker - Previous cache marker (if any)
 * @param didRoll - Whether a roll occurred this call
 * @param buffer - Number of messages to leave uncached (default: 20)
 * @returns Message ID for cache marker, or null if not enough messages
 */
export function determineCacheMarker(
  messageIds: string[],
  lastMarker: string | null,
  didRoll: boolean,
  buffer: number = 20
): string | null {
  if (messageIds.length === 0) {
    return null;
  }
  
  // If we didn't roll, keep existing marker if still valid
  if (!didRoll && lastMarker) {
    if (messageIds.includes(lastMarker)) {
      logger.debug({ lastMarker, messagesLength: messageIds.length }, 'Keeping existing cache marker');
      return lastMarker;
    }
  }
  
  // Place new marker at (length - buffer)
  const index = Math.max(0, messageIds.length - buffer);
  const markerId = messageIds[index];
  
  if (!markerId) {
    return null;
  }
  
  logger.debug({
    index,
    messagesLength: messageIds.length,
    buffer,
    markerId,
    didRoll,
  }, 'Setting new cache marker');
  
  return markerId;
}

/**
 * Find a fallback cache marker when the original was orphaned (merged/filtered).
 * Prefers non-bot messages for stability (bot messages can get merged).
 * 
 * @param messages - Current participant messages
 * @param botName - Bot's participant name (to identify bot messages)
 * @param buffer - Search buffer from end
 * @returns Fallback message ID, or null if none found
 */
export function findFallbackCacheMarker(
  messages: ParticipantMessage[],
  botName: string,
  buffer: number = 20
): string | null {
  const searchStart = Math.max(0, messages.length - 1 - buffer);
  const searchEnd = Math.max(0, searchStart - 20); // Look back 20 more
  
  let fallbackId: string | null = null;
  
  // Search backwards, prefer user messages
  for (let i = searchStart; i >= searchEnd && i >= 0; i--) {
    const msg = messages[i];
    if (!msg?.messageId) continue;
    
    const isBotMsg = msg.participant === botName;
    
    if (!isBotMsg) {
      // Found a user message - use it (stable, won't be merged)
      return msg.messageId;
    } else if (!fallbackId) {
      // First bot message found - use as backup
      fallbackId = msg.messageId;
    }
  }
  
  return fallbackId;
}

