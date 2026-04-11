/**
 * Streaming Metrics Writer
 *
 * Persists streaming metrics to disk in JSONL format.
 * One file per bot per day: ./logs/streaming/{botId}/{YYYY-MM-DD}.jsonl
 *
 * Follows the same singleton + error-tolerant pattern as TraceWriter.
 */

import { mkdirSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import type { StreamingMetricsEntry } from './streaming-types.js'
import { logger } from '../utils/logger.js'

// ============================================================================
// Configuration
// ============================================================================

const STREAMING_DIR = process.env.STREAMING_DIR || './logs/streaming'

function ensureDirs(): void {
  if (!existsSync(STREAMING_DIR)) {
    mkdirSync(STREAMING_DIR, { recursive: true })
  }
}

// Track which bot directories we've already created to avoid repeated existsSync
const knownBotDirs = new Set<string>()

// ============================================================================
// Writer
// ============================================================================

export class StreamingMetricsWriter {
  constructor() {
    ensureDirs()
  }

  /**
   * Write a streaming metrics entry to the daily JSONL file.
   * Creates bot directory if needed. Never throws — logs warnings on failure.
   */
  writeMetrics(entry: StreamingMetricsEntry): void {
    try {
      const botDir = join(STREAMING_DIR, entry.botId)

      // Lazy directory creation with in-memory cache
      if (!knownBotDirs.has(botDir)) {
        if (!existsSync(botDir)) {
          mkdirSync(botDir, { recursive: true })
        }
        knownBotDirs.add(botDir)
      }

      // Daily file: {botId}/{YYYY-MM-DD}.jsonl
      const date = new Date(entry.startedAt).toISOString().split('T')[0]
      const filepath = join(botDir, `${date}.jsonl`)

      const line = JSON.stringify(entry) + '\n'
      appendFileSync(filepath, line)

      logger.debug(
        { botId: entry.botId, traceId: entry.traceId, chunkCount: entry.chunkCount, filepath },
        'Wrote streaming metrics'
      )
    } catch (err) {
      // Streaming metrics are telemetry — never propagate write failures
      logger.warn(
        { err, botId: entry.botId, traceId: entry.traceId },
        'Failed to write streaming metrics'
      )
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let writerInstance: StreamingMetricsWriter | null = null

export function getStreamingMetricsWriter(): StreamingMetricsWriter {
  if (!writerInstance) {
    writerInstance = new StreamingMetricsWriter()
  }
  return writerInstance
}
