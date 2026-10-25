import type {
  StreamingChunkRecord,
  StreamingBlockRecord,
  StreamingMetricsEntry,
  StreamingTimingStats,
} from './streaming-types.js'

interface ChunkMeta {
  blockIndex: number
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  visible: boolean
  toolCallPart?: 'name' | 'input'
  toolId?: string
}

interface BlockEvent {
  event: 'block_start' | 'block_complete'
  index: number
  block: { type: string; content?: string }
}

export class StreamingMetricsCollector {
  private readonly startedAt: number
  private firstChunkAt: number | null = null
  private lastChunkAt: number
  private readonly chunks: StreamingChunkRecord[] = []
  private readonly blocks: StreamingBlockRecord[] = []

  constructor(
    private readonly botId: string,
    private readonly model: string,
    private readonly streamingMode: 'stream' | 'synthesized',
    private readonly traceId?: string,
  ) {
    this.startedAt = Date.now()
    this.lastChunkAt = this.startedAt
  }

  recordChunk(text: string, meta?: ChunkMeta): void {
    const now = Date.now()
    const offsetMs = now - this.startedAt
    const deltaMs = now - this.lastChunkAt

    if (this.firstChunkAt === null) {
      this.firstChunkAt = now
    }

    this.chunks.push({
      text,
      offsetMs,
      deltaMs,
      blockIndex: meta?.blockIndex ?? 0,
      blockType: meta?.type ?? 'text',
      visible: meta?.visible ?? true,
      ...(meta?.toolCallPart ? { toolCallPart: meta.toolCallPart } : {}),
      ...(meta?.toolId ? { toolId: meta.toolId } : {}),
    })

    this.lastChunkAt = now
  }

  recordBlock(event?: BlockEvent): void {
    if (!event) return

    const offsetMs = Date.now() - this.startedAt

    this.blocks.push({
      event: event.event,
      index: event.index,
      blockType: event.block?.type ?? 'unknown',
      offsetMs,
    })
  }

  finalize(options: {
    usage?: {
      inputTokens: number
      outputTokens: number
      cacheCreationTokens?: number
      cacheReadTokens?: number
    }
    stopReason?: string
    error?: string
  }): StreamingMetricsEntry {
    const completedAt = Date.now()
    const durationMs = completedAt - this.startedAt
    const ttftMs = this.firstChunkAt !== null
      ? this.firstChunkAt - this.startedAt
      : null

    return {
      traceId: this.traceId,
      botId: this.botId,
      model: this.model,
      streamingMode: this.streamingMode,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      ttftMs,
      chunkCount: this.chunks.length,
      chunks: this.chunks,
      blocks: this.blocks,
      timing: this.computeTimingStats(),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.error ? { error: options.error } : {}),
    }
  }

  private computeTimingStats(): StreamingTimingStats | null {
    if (this.chunks.length < 2) return null

    const deltas = this.chunks.slice(1).map(c => c.deltaMs)
    if (deltas.length === 0) return null

    const sorted = [...deltas].sort((a, b) => a - b)
    const sum = sorted.reduce((acc, v) => acc + v, 0)

    return {
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      mean: Math.round((sum / sorted.length) * 100) / 100,
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const index = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!
}
