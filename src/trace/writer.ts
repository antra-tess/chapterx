/**
 * Trace Writer
 * 
 * Persists traces to disk with proper organization and indexing.
 * Stores full request/response bodies separately from trace summaries.
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { ActivationTrace, TraceIndex } from './types.js'
import { logger } from '../utils/logger.js'

// ============================================================================
// Configuration
// ============================================================================

const TRACE_DIR = process.env.TRACE_DIR || './logs/traces'
const BODIES_DIR = join(TRACE_DIR, 'bodies')
const INDEX_FILE = join(TRACE_DIR, 'index.jsonl')

// Ensure directories exist
function ensureDirs(): void {
  if (!existsSync(TRACE_DIR)) {
    mkdirSync(TRACE_DIR, { recursive: true })
  }
  if (!existsSync(BODIES_DIR)) {
    mkdirSync(BODIES_DIR, { recursive: true })
  }
}

// ============================================================================
// Trace Writer
// ============================================================================

export class TraceWriter {
  constructor() {
    ensureDirs()
  }
  
  /**
   * Write a complete trace to disk
   */
  writeTrace(trace: ActivationTrace, requestBodies?: any[], responseBodies?: any[], channelName?: string): string {
    const timestamp = trace.timestamp.toISOString().replace(/[:.]/g, '-')
    
    // Organize traces by bot name
    const botDir = trace.botId ? join(TRACE_DIR, trace.botId) : TRACE_DIR
    if (trace.botId && !existsSync(botDir)) {
      mkdirSync(botDir, { recursive: true })
    }
    
    const filename = `${trace.channelId}-${trace.traceId}-${timestamp}.json`
    const filepath = join(botDir, filename)
    
    // Write request/response bodies separately (they're huge)
    const bodyRefs: { requests: string[]; responses: string[] } = {
      requests: [],
      responses: [],
    }
    
    if (requestBodies) {
      requestBodies.forEach((body, i) => {
        const bodyFile = `${trace.traceId}-req-${i}.json`
        const bodyPath = join(BODIES_DIR, bodyFile)
        writeFileSync(bodyPath, JSON.stringify(body, null, 2))
        bodyRefs.requests.push(bodyFile)
      })
    }
    
    if (responseBodies) {
      responseBodies.forEach((body, i) => {
        const bodyFile = `${trace.traceId}-res-${i}.json`
        const bodyPath = join(BODIES_DIR, bodyFile)
        writeFileSync(bodyPath, JSON.stringify(body, null, 2))
        bodyRefs.responses.push(bodyFile)
      })
    }
    
    // Update LLM calls with body references
    trace.llmCalls.forEach((call, i) => {
      if (bodyRefs.requests[i]) {
        call.requestBodyRef = bodyRefs.requests[i]
      }
      if (bodyRefs.responses[i]) {
        call.responseBodyRef = bodyRefs.responses[i]
      }
    })
    
    // Write trace
    writeFileSync(filepath, JSON.stringify(trace, null, 2))
    
    // Append to index
    this.appendToIndex(trace, filename, channelName)
    
    logger.debug({ traceId: trace.traceId, filepath }, 'Wrote trace to disk')
    
    return filepath
  }
  
  /**
   * Append trace summary to index for fast lookups
   */
  private appendToIndex(trace: ActivationTrace, filename: string, channelName?: string): void {
    // Extract previews for quick scanning without loading full trace
    const firstTrigger = trace.activation?.triggerEvents?.[0]
    const triggerPreview = firstTrigger?.contentPreview?.slice(0, 100) || undefined
    const responsePreview = trace.outcome?.responseText?.slice(0, 100) || undefined

    const index: TraceIndex & { filename: string } = {
      traceId: trace.traceId,
      timestamp: trace.timestamp,
      channelId: trace.channelId,
      triggeringMessageId: trace.triggeringMessageId,
      botName: trace.botId,
      channelName,
      activationReason: trace.activation?.reason,
      triggerPreview,
      responsePreview,
      success: trace.outcome?.success ?? false,
      durationMs: trace.durationMs ?? 0,
      llmCallCount: trace.llmCalls.length,
      toolExecutionCount: trace.toolExecutions.length,
      totalTokens: trace.llmCalls.reduce(
        (sum, call) => sum + call.tokenUsage.inputTokens + call.tokenUsage.outputTokens,
        0
      ),
      contextMessageIds: trace.contextBuild?.messages.map(m => m.discordMessageId).filter(Boolean) as string[] || [],
      sentMessageIds: trace.outcome?.sentMessageIds || [],
      filename,
    }
    
    const line = JSON.stringify(index) + '\n'
    
    // Append to index file
    appendFileSync(INDEX_FILE, line)
  }
  
  /**
   * Load a trace by ID
   */
  loadTrace(traceId: string): ActivationTrace | null {
    // Find the trace file
    const files = readdirSync(TRACE_DIR).filter(f => f.includes(traceId) && f.endsWith('.json'))
    
    if (files.length === 0) {
      return null
    }
    
    const filepath = join(TRACE_DIR, files[0]!)
    const content = readFileSync(filepath, 'utf-8')
    return JSON.parse(content) as ActivationTrace
  }
  
  /**
   * Load full request body for an LLM call
   */
  loadRequestBody(bodyRef: string): any {
    const filepath = join(BODIES_DIR, bodyRef)
    if (!existsSync(filepath)) {
      return null
    }
    return JSON.parse(readFileSync(filepath, 'utf-8'))
  }
  
  /**
   * Load full response body for an LLM call
   */
  loadResponseBody(bodyRef: string): any {
    const filepath = join(BODIES_DIR, bodyRef)
    if (!existsSync(filepath)) {
      return null
    }
    return JSON.parse(readFileSync(filepath, 'utf-8'))
  }
  
  /**
   * Find traces containing a specific Discord message ID
   */
  findByMessageId(messageId: string): TraceIndex[] {
    const results: TraceIndex[] = []
    
    if (!existsSync(INDEX_FILE)) {
      return results
    }
    
    const lines = readFileSync(INDEX_FILE, 'utf-8').split('\n').filter(Boolean)
    
    for (const line of lines) {
      try {
        const index = JSON.parse(line) as TraceIndex & { filename: string }
        if (
          index.contextMessageIds.includes(messageId) ||
          index.sentMessageIds.includes(messageId) ||
          index.triggeringMessageId === messageId
        ) {
          results.push(index)
        }
      } catch {
        // Skip malformed lines
      }
    }
    
    return results
  }
  
  /**
   * Find recent traces for a channel
   */
  findByChannel(channelId: string, limit = 20): TraceIndex[] {
    const results: TraceIndex[] = []
    
    if (!existsSync(INDEX_FILE)) {
      return results
    }
    
    const lines = readFileSync(INDEX_FILE, 'utf-8').split('\n').filter(Boolean)
    
    // Read from end for recency
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const index = JSON.parse(lines[i]!) as TraceIndex
        if (index.channelId === channelId) {
          results.push(index)
        }
      } catch {
        // Skip malformed lines
      }
    }
    
    return results
  }
  
  /**
   * Find failed traces
   */
  findFailed(limit = 20): TraceIndex[] {
    const results: TraceIndex[] = []
    
    if (!existsSync(INDEX_FILE)) {
      return results
    }
    
    const lines = readFileSync(INDEX_FILE, 'utf-8').split('\n').filter(Boolean)
    
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const index = JSON.parse(lines[i]!) as TraceIndex
        if (!index.success) {
          results.push(index)
        }
      } catch {
        // Skip malformed lines
      }
    }
    
    return results
  }
  
  /**
   * List recent traces
   */
  listRecent(limit = 20): TraceIndex[] {
    const results: TraceIndex[] = []
    
    if (!existsSync(INDEX_FILE)) {
      return results
    }
    
    const lines = readFileSync(INDEX_FILE, 'utf-8').split('\n').filter(Boolean)
    
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        results.push(JSON.parse(lines[i]!) as TraceIndex)
      } catch {
        // Skip malformed lines
      }
    }
    
    return results
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

let writerInstance: TraceWriter | null = null

export function getTraceWriter(): TraceWriter {
  if (!writerInstance) {
    writerInstance = new TraceWriter()
  }
  return writerInstance
}

