import { mkdirSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import type { StreamingMetricsEntry } from './streaming-types.js'
import { logger } from '../utils/logger.js'

const STREAMING_DIR = process.env.STREAMING_DIR || './logs/streaming'

function ensureDirs(): void {
  if (!existsSync(STREAMING_DIR)) {
    mkdirSync(STREAMING_DIR, { recursive: true })
  }
}

const knownBotDirs = new Set<string>()

export class StreamingMetricsWriter {
  constructor() {
    ensureDirs()
  }

  writeMetrics(entry: StreamingMetricsEntry): void {
    try {
      const botDir = join(STREAMING_DIR, entry.botId)

      if (!knownBotDirs.has(botDir)) {
        if (!existsSync(botDir)) {
          mkdirSync(botDir, { recursive: true })
        }
        knownBotDirs.add(botDir)
      }

      const date = new Date(entry.startedAt).toISOString().split('T')[0]
      const filepath = join(botDir, `${date}.jsonl`)

      const line = JSON.stringify(entry) + '\n'
      appendFileSync(filepath, line)

      logger.debug(
        { botId: entry.botId, traceId: entry.traceId, chunkCount: entry.chunkCount, filepath },
        'Wrote streaming metrics'
      )
    } catch (err) {
      logger.warn(
        { err, botId: entry.botId, traceId: entry.traceId },
        'Failed to write streaming metrics'
      )
    }
  }
}

let writerInstance: StreamingMetricsWriter | null = null

export function getStreamingMetricsWriter(): StreamingMetricsWriter {
  if (!writerInstance) {
    writerInstance = new StreamingMetricsWriter()
  }
  return writerInstance
}
