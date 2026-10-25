export interface StreamingChunkRecord {
  text: string
  offsetMs: number
  deltaMs: number
  blockIndex: number
  blockType: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  visible: boolean
  toolCallPart?: 'name' | 'input'
  toolId?: string
}

export interface StreamingBlockRecord {
  event: 'block_start' | 'block_complete'
  index: number
  blockType: string
  offsetMs: number
}

export interface StreamingTimingStats {
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  p99: number
}

export interface StreamingMetricsEntry {
  traceId?: string
  botId: string
  model: string
  /** 'stream' = real streaming, 'synthesized' = membrane complete() fallback when streaming:false */
  streamingMode: 'stream' | 'synthesized'
  startedAt: number
  completedAt: number
  durationMs: number
  ttftMs: number | null
  chunkCount: number
  chunks: StreamingChunkRecord[]
  blocks: StreamingBlockRecord[]
  timing: StreamingTimingStats | null
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
  stopReason?: string
  error?: string
}
