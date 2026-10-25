import {
  shouldRoll as membranesShouldRoll,
  applyCacheMarkers as membraneApplyCacheMarkers,
  type ContextState,
  type ContextConfig,
  type CacheMarker,
} from '@animalabs/membrane';
import type { BotConfig, ParticipantMessage } from '../types.js';
import { logger } from '../utils/logger.js';

export const CACHE_MARKER_BUFFER = 20;

export function toMembraneState(
  messagesSinceRoll: number,
  lastCacheMarker: string | null,
  cachedStartMessageId: string | null
): ContextState {
  return {
    cacheMarkers: lastCacheMarker 
      ? [{ messageId: lastCacheMarker, messageIndex: -1, tokenEstimate: 0 }]
      : [],
    windowMessageIds: [],
    messagesSinceRoll,
    tokensSinceRoll: 0,
    inGracePeriod: false,
    cachedStartMessageId: cachedStartMessageId ?? undefined,
  };
}

export function toMembraneConfig(config: BotConfig): ContextConfig {
  return {
    rolling: {
      threshold: config.rolling_threshold,
      buffer: CACHE_MARKER_BUFFER,
      unit: 'messages',
    },
    limits: {
      maxCharacters: config.hard_max_characters || 500000,
      // No maxMessages: membrane checks it against the messageCount that
      // shouldRoll() below hands it, which counts activations since the last roll,
      // not messages.
    },
    cache: {
      enabled: config.prompt_caching !== false,
      points: 1,
      preferUserMessages: true,
    },
  };
}

export interface ChapterXRollDecision {
  shouldRoll: boolean;
  reason?: 'threshold' | 'grace_exceeded' | 'hard_limit';
  hardLimitExceeded: boolean;
}

export function shouldRoll(
  messagesSinceRoll: number,
  totalCharacters: number,
  config: BotConfig
): ChapterXRollDecision {
  const membraneState = toMembraneState(messagesSinceRoll, null, null);
  const membraneConfig = toMembraneConfig(config);
  
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
  
  // Membrane 0.5.80 and earlier compare the threshold with
  // state.messagesSinceRoll, and 0.5.81 and later with messageCount. ^0.5.47
  // installs either, so the count goes in both places, which gives the same
  // decision on each.
  const decision = membranesShouldRoll(
    membraneState,
    messagesSinceRoll,
    0,
    totalCharacters,
    membraneConfig
  );
  
  return {
    shouldRoll: decision.shouldRoll,
    reason: decision.reason,
    hardLimitExceeded: false,
  };
}

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
    }
  }
  return totalChars;
}

export function truncateToCharacterLimit(
  messages: ParticipantMessage[],
  charLimit: number
): { messages: ParticipantMessage[]; removed: number } {
  let keptChars = 0;
  let cutoffIndex = messages.length;
  
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

export function determineCacheMarker(
  messageIds: string[],
  lastMarker: string | null,
  didRoll: boolean,
  buffer: number = CACHE_MARKER_BUFFER,
  botMessageIds?: Set<string>
): string | null {
  if (messageIds.length === 0) {
    return null;
  }

  if (!didRoll && lastMarker) {
    if (messageIds.includes(lastMarker)) {
      logger.debug({ lastMarker, messagesLength: messageIds.length }, 'Keeping existing cache marker');
      return lastMarker;
    }
  }

  const targetIndex = Math.max(0, messageIds.length - buffer);

  if (botMessageIds && botMessageIds.size > 0) {
    for (let offset = 0; offset < buffer; offset++) {
      const fwdIdx = targetIndex + offset;
      if (fwdIdx < messageIds.length && !botMessageIds.has(messageIds[fwdIdx]!)) {
        logger.debug({
          targetIndex,
          selectedIndex: fwdIdx,
          messagesLength: messageIds.length,
          buffer,
          markerId: messageIds[fwdIdx],
          didRoll,
          direction: 'forward',
        }, 'Setting new cache marker (non-bot preference)');
        return messageIds[fwdIdx]!;
      }
      const bwdIdx = targetIndex - offset;
      if (bwdIdx >= 0 && !botMessageIds.has(messageIds[bwdIdx]!)) {
        logger.debug({
          targetIndex,
          selectedIndex: bwdIdx,
          messagesLength: messageIds.length,
          buffer,
          markerId: messageIds[bwdIdx],
          didRoll,
          direction: 'backward',
        }, 'Setting new cache marker (non-bot preference)');
        return messageIds[bwdIdx]!;
      }
    }
  }

  const markerId = messageIds[targetIndex];

  if (!markerId) {
    return null;
  }

  logger.debug({
    index: targetIndex,
    messagesLength: messageIds.length,
    buffer,
    markerId,
    didRoll,
  }, 'Setting new cache marker');

  return markerId;
}

export function findFallbackCacheMarker(
  messages: ParticipantMessage[],
  botName: string,
  buffer: number = CACHE_MARKER_BUFFER
): string | null {
  const fallbackLookback = 20;
  const searchStart = Math.max(0, messages.length - 1 - buffer);
  const searchEnd = Math.max(0, searchStart - fallbackLookback);
  
  let fallbackId: string | null = null;
  
  for (let i = searchStart; i >= searchEnd && i >= 0; i--) {
    const msg = messages[i];
    if (!msg?.messageId) continue;
    
    const isBotMsg = msg.participant === botName;
    
    if (!isBotMsg) {
      return msg.messageId;
    } else if (!fallbackId) {
      fallbackId = msg.messageId;
    }
  }
  
  return fallbackId;
}

export function applyChapterXCacheMarker(
  messages: ParticipantMessage[],
  markerMessageId: string | null
): ParticipantMessage[] {
  if (!markerMessageId) return messages;
  
  const markerIndex = messages.findIndex(m => m.messageId === markerMessageId);
  if (markerIndex === -1) {
    logger.warn({ markerMessageId }, 'Cache marker message not found in messages array');
    return messages;
  }
  
  const cacheMarkers: CacheMarker[] = [{
    messageId: markerMessageId,
    messageIndex: markerIndex,
    tokenEstimate: 0,
  }];
  
  // Membrane sets metadata.cacheControl, but its formatter checks
  // cacheBreakpoint, so membrane's markers are converted to what the formatter
  // expects.
  const messagesWithMetadata = membraneApplyCacheMarkers(messages as any, cacheMarkers);
  
  return messagesWithMetadata.map((msg: any) => {
    if (msg.metadata?.cacheControl) {
      const { metadata, ...rest } = msg;
      const { cacheControl: _cc, ...restMetadata } = metadata;
      return {
        ...rest,
        cacheBreakpoint: true,
        ...(Object.keys(restMetadata).length > 0 ? { metadata: restMetadata } : {}),
      } as ParticipantMessage;
    }
    return msg as ParticipantMessage;
  });
}

