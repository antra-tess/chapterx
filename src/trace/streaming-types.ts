/**
 * Streaming Metrics Types
 *
 * Types for per-token streaming metrics logging.
 * Each LLM stream() call produces one StreamingMetricsEntry,
 * written as a single JSONL line to ./logs/streaming/{botId}/{date}.jsonl
 */

// ============================================================================
// Chunk & Block Records
// ============================================================================

/** A single recorded chunk from the stream */
export interface StreamingChunkRecord {
  /** Chunk text content (lossless — full token text) */
  text: string
  /** Milliseconds since LLM call start */
  offsetMs: number
  /** Delta from previous chunk in ms (0 for first chunk) */
  deltaMs: number
  /** Block metadata */
  blockIndex: number
  blockType: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  visible: boolean
  /** Tool call metadata (only present for tool_call blocks) */
  toolCallPart?: 'name' | 'input'
  toolId?: string
}

/** A recorded block boundary event */
export interface StreamingBlockRecord {
  event: 'block_start' | 'block_complete'
  index: number
  blockType: string
  /** Milliseconds since LLM call start */
  offsetMs: number
}

// ============================================================================
// Timing Statistics
// ============================================================================

/** Inter-chunk timing percentiles (ms) */
export interface StreamingTimingStats {
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  p99: number
}

// ============================================================================
// Metrics Entry (one per LLM stream call)
// ============================================================================

/** Complete metrics for one LLM stream call — one JSONL line */
export interface StreamingMetricsEntry {
  /** Activation trace ID (links to trace system) */
  traceId?: string
  /** Bot identifier */
  botId: string
  /** Model used */
  model: string
  /** 'stream' = real streaming, 'synthesized' = membrane complete() fallback when streaming:false */
  streamingMode: 'stream' | 'synthesized'
  /** Call start timestamp (epoch ms) */
  startedAt: number
  /** Call end timestamp (epoch ms) */
  completedAt: number
  /** Total duration in ms */
  durationMs: number
  /** Time to first chunk in ms (null if no chunks received) */
  ttftMs: number | null
  /** Total number of chunks received */
  chunkCount: number
  /** Per-chunk timing records (lossless — full text included) */
  chunks: StreamingChunkRecord[]
  /** Block lifecycle events */
  blocks: StreamingBlockRecord[]
  /** Inter-chunk timing percentiles, null if fewer than 2 chunks */
  timing: StreamingTimingStats | null
  /** Token usage from membrane */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
  /** LLM stop reason */
  stopReason?: string
  /** Error message if the call failed */
  error?: string
}
