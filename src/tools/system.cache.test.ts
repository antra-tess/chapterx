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

  it('keeps a native call\'s own coverage when its activation\'s messages are attached', async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-tool-cache-'))
    temporaryDirectories.push(cacheDirectory)
    const toolSystem = new ToolSystem(cacheDirectory)
    const call: ToolCall = {
      id: 'call-native',
      name: 'lookup',
      input: {},
      messageId: 'trigger',
      timestamp: new Date('2026-09-01T12:00:00Z'),
      originalCompletionText: 'Checking.',
      coveredMessageIds: ['round-1'],
    }
    const result: ToolResult = { callId: call.id, output: 'found', timestamp: new Date('2026-09-01T12:00:01Z') }

    await toolSystem.persistToolUse('bot', 'channel', call, result)
    await toolSystem.updateBotMessageIds('bot', 'channel', [call.id], ['round-1', 'final'], [])
    const [cached] = await toolSystem.loadCacheWithResults('bot', 'channel', new Set(['round-1', 'final']))

    expect(cached?.call.botMessageIds).toEqual(['round-1', 'final'])
    expect(cached?.call.coveredMessageIds).toEqual(['round-1'])
  })

  it('reloads an entry whose tool returned nothing, and the entries after it', async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-tool-cache-'))
    temporaryDirectories.push(cacheDirectory)
    const toolSystem = new ToolSystem(cacheDirectory)
    const call = (id: string): ToolCall => ({
      id,
      name: 'quiet',
      input: {},
      messageId: 'trigger',
      timestamp: new Date('2026-09-01T12:00:00Z'),
      originalCompletionText: '',
      botMessageIds: ['response'],
    })

    await toolSystem.persistToolUse('bot', 'channel', call('nothing'), {
      callId: 'nothing',
      output: undefined,
      timestamp: new Date('2026-09-01T12:00:01Z'),
    })
    await toolSystem.persistToolUse('bot', 'channel', call('after'), {
      callId: 'after',
      output: 'ok',
      timestamp: new Date('2026-09-01T12:00:02Z'),
    })
    const cached = await toolSystem.loadCacheWithResults('bot', 'channel', new Set(['response']))

    expect(cached.map((entry) => entry.call.id)).toEqual(['nothing', 'after'])
  })

  // Persists one round of a native activation: its prose covers its own message.
  async function persistRound(toolSystem: ToolSystem, trigger: string, round: number, messages: string[]) {
    const call: ToolCall = {
      id: `${trigger}-call-${round}`,
      name: 'lookup',
      input: {},
      messageId: trigger,
      timestamp: new Date('2026-09-01T12:00:00Z'),
      originalCompletionText: `Round ${round}.`,
      coveredMessageIds: [`${trigger}-round-${round}`],
    }
    await toolSystem.persistToolUse('bot', 'channel', call, {
      callId: call.id,
      output: `result ${round}`,
      timestamp: new Date('2026-09-01T12:00:01Z'),
    })
    await toolSystem.updateBotMessageIds('bot', 'channel', [call.id], messages, [])
  }

  it('keeps an activation the five-result window cuts through whole, its earlier rounds without results', async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-tool-cache-'))
    temporaryDirectories.push(cacheDirectory)
    const toolSystem = new ToolSystem(cacheDirectory)
    const messages = [1, 2, 3, 4, 5, 6, 7].map((round) => `trigger-round-${round}`).concat('final')
    for (let round = 1; round <= 7; round++) await persistRound(toolSystem, 'trigger', round, messages)

    const cached = await toolSystem.loadCacheWithResults('bot', 'channel', new Set(messages))

    expect(cached.map((entry) => [entry.call.id, entry.resultOmitted ?? false, entry.result?.output])).toEqual([
      ['trigger-call-1', true, undefined],
      ['trigger-call-2', true, undefined],
      ['trigger-call-3', false, 'result 3'],
      ['trigger-call-4', false, 'result 4'],
      ['trigger-call-5', false, 'result 5'],
      ['trigger-call-6', false, 'result 6'],
      ['trigger-call-7', false, 'result 7'],
    ])
  })

  it('leaves out an earlier activation the five-result window doesn\'t reach', async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-tool-cache-'))
    temporaryDirectories.push(cacheDirectory)
    const toolSystem = new ToolSystem(cacheDirectory)
    const earlier = ['earlier-round-1', 'earlier-round-2']
    const later = [1, 2, 3, 4, 5].map((round) => `later-round-${round}`)
    for (let round = 1; round <= 2; round++) await persistRound(toolSystem, 'earlier', round, earlier)
    for (let round = 1; round <= 5; round++) await persistRound(toolSystem, 'later', round, later)

    const cached = await toolSystem.loadCacheWithResults('bot', 'channel', new Set([...earlier, ...later]))

    expect(cached.map((entry) => entry.call.id)).toEqual([1, 2, 3, 4, 5].map((round) => `later-call-${round}`))
    expect(cached.every((entry) => !entry.resultOmitted)).toBe(true)
  })
})
