/**
 * TTS Integration Module
 *
 * Exports for connecting ChapterX to TTS relay servers.
 */

export { TTSRelayClient } from './relay-client.js';
export type {
  RelayClientConfig,
  ChunkPayload,
  BlockStartPayload,
  BlockCompletePayload,
  InterruptionEvent,
  BlockType,
  InterruptionReason,
} from './relay-client.js';
