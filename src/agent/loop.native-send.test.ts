import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentLoop } from './loop.js'
import { EventQueue } from './event-queue.js'

function makeLoop() {
  const cacheDir = mkdtempSync(join(tmpdir(), 'agent-native-send-test-'))
  let nextMessageId = 1
  const sendSegmentChunks = vi.fn(async (_channelId, content) => ({
    chunks: [{ id: `sent-${nextMessageId++}` }],
    endCarry: [],
  }))
  const connector = {
    sendSegmentChunks,
    getBotUsername: () => 'TestBot',
  }
  const toolSystem = {
    executeTool: vi.fn(async () => ({ output: 'tool result' })),
    persistToolUse: vi.fn(async () => {}),
    stripToolXml: (text: string) => text,
  }
  const loop = new AgentLoop(
    'test-bot',
    new EventQueue(),
    connector as any,
    {} as any,
    {} as any,
    {} as any,
    toolSystem as any,
    cacheDir,
  )

  return {
    loop,
    sendSegmentChunks,
    cleanup: () => rmSync(cacheDir, { recursive: true, force: true }),
  }
}

describe('AgentLoop native-tool sending', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => cleanup?.())

  it('does not resend prose already flushed before native tool calls', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup

    ;(harness.loop as any).membraneProvider = {
      stream: async (_request: unknown, callbacks: any) => {
        await callbacks.onPreToolContent('First preamble. ')
        await callbacks.onToolCalls(
          [{ id: 'tool-1', name: 'lookup', input: { q: 'one' } }],
          { depth: 0, preamble: 'First preamble. ', accumulated: 'First preamble. ' },
        )
        await callbacks.onPreToolContent('Second preamble. ')
        await callbacks.onToolCalls(
          [{ id: 'tool-2', name: 'lookup', input: { q: 'two' } }],
          { depth: 1, preamble: 'Second preamble. ', accumulated: 'First preamble. Second preamble. ' },
        )

        // Membrane returns every text block from the complete native tool loop,
        // including both preambles delivered through onPreToolContent.
        return {
          content: [
            { type: 'text', text: 'First preamble. ' },
            { type: 'text', text: 'Second preamble. ' },
            { type: 'text', text: 'Final answer.' },
          ],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'test-model',
        }
      },
    }

    const result = await (harness.loop as any).executeWithNativeTools(
      { stop_sequences: [] },
      {
        name: 'TestBot',
        continuation_model: 'test-model',
        max_tool_depth: 4,
        debug_thinking: false,
        preserve_thinking_blocks: false,
      },
      'channel-1',
      'trigger-1',
    )

    expect(harness.sendSegmentChunks.mock.calls.map((call) => call[1])).toEqual([
      'First preamble.',
      'Second preamble.',
      'Final answer.',
    ])
    expect(result.completion.content).toEqual([
      { type: 'text', text: 'First preamble. Second preamble. Final answer.' },
    ])
    expect(result.preambleMessageIds).toEqual(['sent-1', 'sent-2'])
    expect(result.sentMessageIds).toEqual(['sent-1', 'sent-2', 'sent-3'])
    expect((harness.loop as any).toolSystem.persistToolUse.mock.calls.map((call: any[]) => call[2].originalCompletionText)).toEqual([
      'First preamble. ',
      'Second preamble. ',
    ])
  })
})
