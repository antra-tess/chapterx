import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolSystem } from './system.js'
import type { ToolCall, ToolResult } from '../types.js'

describe('ToolSystem cache message coverage', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists liveness anchors separately from reconstructed Discord messages', async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-tool-cache-'))
    temporaryDirectories.push(cacheDirectory)
    const toolSystem = new ToolSystem(cacheDirectory)
    const call: ToolCall = {
      id: 'call-1',
      name: 'notes_save',
      input: { text: 'remember this' },
      messageId: 'trigger',
      timestamp: new Date('2026-09-01T12:00:00Z'),
      originalCompletionText: 'I will save that note.',
    }
    const result: ToolResult = {
      callId: call.id,
      output: 'saved',
      timestamp: new Date('2026-09-01T12:00:01Z'),
    }

    await toolSystem.persistToolUse('bot', 'channel', call, result)
    await toolSystem.updateBotMessageIds(
      'bot',
      'channel',
      [call.id],
      ['preamble', 'final-answer'],
      ['preamble']
    )

    const [cached] = await toolSystem.loadCacheWithResults(
      'bot',
      'channel',
      new Set(['preamble', 'final-answer'])
    )

    expect(cached?.call.botMessageIds).toEqual(['preamble', 'final-answer'])
    expect(cached?.call.coveredMessageIds).toEqual(['preamble'])
  })

  it('restores persisted tool errors', async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-tool-cache-'))
    temporaryDirectories.push(cacheDirectory)
    const toolSystem = new ToolSystem(cacheDirectory)
    const call: ToolCall = {
      id: 'call-error',
      name: 'fetch',
      input: {},
      messageId: 'trigger',
      timestamp: new Date('2026-09-01T12:00:00Z'),
      originalCompletionText: 'Fetching.',
      botMessageIds: ['response'],
    }
    const result: ToolResult = {
      callId: call.id,
      output: null,
      error: 'connection failed',
      timestamp: new Date('2026-09-01T12:00:01Z'),
    }

    await toolSystem.persistToolUse('bot', 'channel', call, result)
    const [cached] = await toolSystem.loadCacheWithResults(
      'bot',
      'channel',
      new Set(['response'])
    )

    expect(cached?.result.error).toBe('connection failed')
  })
})
