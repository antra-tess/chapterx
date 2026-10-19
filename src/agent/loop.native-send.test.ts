import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentLoop } from './loop.js'
import { EventQueue } from './event-queue.js'
import { logger } from '../utils/logger.js'
import { scanMarkdown } from '../utils/discord-markdown.js'
import { ToolSystem } from '../tools/system.js'

/**
 * With `scanCarry`, each send ends in the markdown carry its text leaves open
 * from the carry it starts in, as the connector's split gives it; otherwise in
 * none.
 */
function makeLoop(toolOutput: { value: unknown } = { value: 'tool result' }, options: { scanCarry?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'agent-native-send-test-'))
  let nextMessageId = 1
  const sendSegmentChunks = vi.fn(async (_channelId: string, content: string, _replyTo?: string, carry?: any[]) => ({
    chunks: [{ id: `sent-${nextMessageId++}` }],
    endCarry: options.scanCarry ? scanMarkdown(content, carry ?? []) : [],
  }))
  const connector = {
    sendSegmentChunks,
    getBotUsername: () => 'TestBot',
  }
  const toolSystem = {
    executeTool: vi.fn(async () => ({ output: toolOutput.value })),
    persistToolUse: vi.fn(async () => {}),
    stripToolXml: (text: string) => ToolSystem.prototype.stripToolXml.call(undefined, text),
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

  const run = (stream: (request: unknown, callbacks: any) => Promise<any>, discordMessages?: any[], config: Record<string, unknown> = {}) => {
    ;(loop as any).membraneProvider = { stream }
    return (loop as any).executeWithNativeTools(
      { stop_sequences: [] },
      {
        name: 'TestBot',
        continuation_model: 'test-model',
        max_tool_depth: 4,
        debug_thinking: false,
        preserve_thinking_blocks: false,
        ...config,
      },
      'channel-1',
      'trigger-1',
      undefined,
      discordMessages,
    )
  }
  const sent = () => sendSegmentChunks.mock.calls.map((call) => call[1])
  const persisted = () => toolSystem.persistToolUse.mock.calls.map((call: any[]) => ({
    text: call[2].originalCompletionText,
    covers: call[2].coveredMessageIds,
  }))

  return {
    loop,
    run,
    sent,
    persisted,
    toolSystem,
    cleanup: () => rmSync(cacheDir, { recursive: true, force: true }),
  }
}

const done = (text: string) => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 10 },
  model: 'test-model',
})

describe('AgentLoop native-tool sending', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup?.()
  })

  it('does not resend prose already flushed before native tool calls, and caches each round as posted', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup

    const result = await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('First preamble. ')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: { q: 'one' } }, { id: 'tool-2', name: 'lookup', input: { q: 'two' } }],
        { depth: 0, preamble: 'First preamble. ', accumulated: 'First preamble. ' },
      )
      await callbacks.onPreToolContent('Second preamble. ')
      await callbacks.onToolCalls(
        [{ id: 'tool-3', name: 'lookup', input: { q: 'three' } }],
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
    })

    expect(harness.sent()).toEqual(['First preamble.', 'Second preamble.', 'Final answer.'])
    expect(result.completion.content).toEqual([
      { type: 'text', text: 'First preamble. Second preamble. Final answer.' },
    ])
    expect(result.sentMessageIds).toEqual(['sent-1', 'sent-2', 'sent-3'])
    // Each round's calls cache the prose posted in that round and cover the
    // messages that carried it; the final answer stays uncovered.
    expect(harness.persisted()).toEqual([
      { text: 'First preamble.', covers: ['sent-1'] },
      { text: 'First preamble.', covers: ['sent-1'] },
      { text: 'Second preamble.', covers: ['sent-2'] },
    ])
  })

  it('caches the posted prose, not the round\'s thinking that membrane includes in its preamble', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup

    await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Checking.')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'I should look this up first.Checking.', accumulated: 'I should look this up first.Checking.' },
      )
      return done('Checking.Found it.')
    })

    expect(harness.persisted()).toEqual([{ text: 'Checking.', covers: ['sent-1'] }])
  })

  it('caches only the visible prose a round posted, and nothing of a round with no visible text', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup

    await harness.run(async (_request, callbacks) => {
      // A round whose text is only markup shows nothing on Discord, so it
      // caches nothing; the next round caches only what it showed.
      await callbacks.onPreToolContent('<thinking>Which log first?</thinking>')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: '<thinking>Which log first?</thinking>', accumulated: '<thinking>Which log first?</thinking>' },
      )
      await callbacks.onPreToolContent('<thinking>Now the errors.</thinking>Checking the errors.')
      await callbacks.onToolCalls(
        [{ id: 'tool-2', name: 'lookup', input: {} }],
        { depth: 1, preamble: '<thinking>Now the errors.</thinking>Checking the errors.', accumulated: '' },
      )
      return done('<thinking>Which log first?</thinking><thinking>Now the errors.</thinking>Checking the errors.Found it.')
    })

    expect(harness.persisted()).toEqual([
      { text: '', covers: [] },
      { text: 'Checking the errors.', covers: ['sent-1'] },
    ])
  })

  it('joins a round\'s visible pieces with a space, as the history joins its messages', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup

    await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Hello. <thinking>Which first?</thinking> World.')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'Hello. <thinking>Which first?</thinking> World.', accumulated: '' },
      )
      return done('Hello. <thinking>Which first?</thinking> World.Done.')
    })

    expect(harness.persisted()).toEqual([{ text: 'Hello. World.', covers: ['sent-1', 'sent-2'] }])
  })

  it('joins two posts within one round with a space', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup

    await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Hello.')
      await callbacks.onPreToolContent('World.')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'Hello.World.', accumulated: '' },
      )
      return done('Hello.World.Done.')
    })

    expect(harness.persisted()).toEqual([{ text: 'Hello. World.', covers: ['sent-1', 'sent-2'] }])
  })

  it('caches nothing for a round withheld at a participant name, and truncates what follows it', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const discordMessages = [{ id: 'm-1', author: { username: 'alice', displayName: 'Alice', bot: false }, content: 'hi' }]

    await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Let me look.\nalice: sounds good')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'Let me look.\nalice: sounds good', accumulated: 'Let me look.\nalice: sounds good' },
      )
      return done('Let me look.\nalice: sounds goodFound it.')
    }, discordMessages)

    expect(harness.persisted()).toEqual([{ text: '', covers: [] }])
    expect(harness.sent()).toEqual(['Let me look.'])
  })

  it("pings a mention in a round's prose and in the reply, and caches the round's words as the model wrote them", async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const discordMessages = [{ id: 'm-1', author: { id: '111', username: 'alice', displayName: 'Alice', bot: false }, content: 'hi' }]

    // With people labelled by display name, the model names Alice as @Alice.
    const result = await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Asking @Alice. ')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'Asking @Alice. ', accumulated: 'Asking @Alice. ' },
      )
      return {
        content: [{ type: 'text', text: 'Asking @Alice. ' }, { type: 'text', text: 'Thanks, @Alice.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'test-model',
      }
    }, discordMessages, { use_display_names_humans: true })

    expect(harness.sent()).toEqual(['Asking <@111>.', 'Thanks, <@111>.'])
    // The next context shows the cache as written, so it keeps the model's
    // words, not the id that was sent.
    expect(harness.persisted()).toEqual([{ text: 'Asking @Alice.', covers: ['sent-1'] }])
    // The response the completion returns keeps the model's words too.
    expect(result.completion.content).toEqual([{ type: 'text', text: 'Asking @Alice. Thanks, @Alice.' }])
  })

  it("reads the reply's mentions from the code block its round left open", async () => {
    const harness = makeLoop(undefined, { scanCarry: true })
    cleanup = harness.cleanup
    const discordMessages = [{ id: 'm-1', author: { id: '111', username: 'alice', displayName: 'Alice', bot: false }, content: 'hi' }]
    const round = 'Run this:\n```\nping <@alice>\n'

    const result = await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent(round)
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: round, accumulated: round },
      )
      return {
        content: [{ type: 'text', text: round }, { type: 'text', text: 'more <@alice>\n```\nDone, <@alice>.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'test-model',
      }
    }, discordMessages)

    // The round's post leaves the code block open, so the reply starts in it.
    expect(harness.sent()).toEqual(['Run this:\n```\nping <@alice>', 'more <@alice>\n```\nDone, <@111>.'])
    expect(result.completion.content).toEqual([
      { type: 'text', text: 'Run this:\n```\nping <@alice>\nmore <@alice>\n```\nDone, <@alice>.' },
    ])
  })

  it("reads the reply's mentions as each segment is sent, with its leading indentation gone", async () => {
    const harness = makeLoop(undefined, { scanCarry: true })
    cleanup = harness.cleanup
    const discordMessages = [{ id: 'm-1', author: { id: '111', username: 'alice', displayName: 'Alice', bot: false }, content: 'hi' }]

    // The thinking block keeps the indentation past the trim that strips tool XML;
    // the segment's own trim takes it off.
    await harness.run(async () => done('<thinking>plan</thinking>\n    ```\ncode\n``` x\n@Alice'), discordMessages, { use_display_names_humans: true })

    // Sent without its indentation, the block opens a line and nothing ends it, so @Alice is in it.
    expect(harness.sent()).toEqual(['```\ncode\n``` x\n@Alice'])
  })

  it('finds the posted prose behind a whitespace-only round that membrane never flushed', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const warn = vi.spyOn(logger, 'warn')

    await harness.run(async (_request, callbacks) => {
      // Membrane calls onPreToolContent only for a round whose text isn't blank.
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: '\n\n', accumulated: '\n\n' },
      )
      await callbacks.onPreToolContent('Checking the logs.')
      await callbacks.onToolCalls(
        [{ id: 'tool-2', name: 'lookup', input: {} }],
        { depth: 1, preamble: 'Checking the logs.', accumulated: '\n\nChecking the logs.' },
      )
      return {
        content: [
          { type: 'text', text: '\n\n' },
          { type: 'text', text: 'Checking the logs.' },
          { type: 'text', text: ' Found it.' },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'test-model',
      }
    })

    expect(harness.sent()).toEqual(['Checking the logs.', 'Found it.'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('sends the whole response, with a warning, when it does not start with the posted prose', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const warn = vi.spyOn(logger, 'warn')

    await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Checking the logs.')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'Checking the logs.', accumulated: 'Checking the logs.' },
      )
      return done('Found it.')
    })

    expect(harness.sent()).toEqual(['Checking the logs.', 'Found it.'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('sends nothing and warns of nothing for an aborted turn\'s empty response', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const warn = vi.spyOn(logger, 'warn')

    await harness.run(async (_request, callbacks) => {
      await callbacks.onPreToolContent('Checking the logs.')
      await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'lookup', input: {} }],
        { depth: 0, preamble: 'Checking the logs.', accumulated: 'Checking the logs.' },
      )
      return { content: [], stopReason: 'aborted', usage: { inputTokens: 0, outputTokens: 0 }, model: 'test-model' }
    })

    expect(harness.sent()).toEqual(['Checking the logs.'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('gives the model "(no output)" for a tool that returns nothing', async () => {
    const harness = makeLoop({ value: undefined })
    cleanup = harness.cleanup
    let results: any[] = []

    await harness.run(async (_request, callbacks) => {
      results = await callbacks.onToolCalls(
        [{ id: 'tool-1', name: 'quiet', input: {} }],
        { depth: 0, preamble: '', accumulated: '' },
      )
      return done('Done.')
    })

    expect(results).toEqual([{ toolUseId: 'tool-1', content: '(no output)', isError: false }])
  })

  it('removes the messages a cached exchange reconstructs from the next context, unless preserve_thinking_context keeps them', () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const loop = harness.loop
    const messages = [{ id: 'trigger' }, { id: 'preamble' }, { id: 'final' }] as any[]
    const toolCache = [{
      call: {
        id: 'tool-1',
        name: 'lookup',
        input: {},
        messageId: 'trigger',
        timestamp: new Date(),
        originalCompletionText: 'Checking.',
        botMessageIds: ['preamble', 'final'],
        coveredMessageIds: ['preamble'],
      },
      result: { output: 'found' },
    }]

    const filter = (config: any) => (loop as any).messagesNotCoveredByToolCache(messages, toolCache, config)

    expect(filter({ preserve_thinking_context: false }).map((m: any) => m.id)).toEqual(['trigger', 'final'])
    expect(filter({ preserve_thinking_context: true }).map((m: any) => m.id)).toEqual(['trigger', 'preamble', 'final'])
  })
})

describe('AgentLoop inline-tool sending', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup?.()
  })

  it("pings a mention in the text it sends, and returns the response in the model's words", async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const discordMessages = [{ id: 'm-1', author: { id: '111', username: 'alice', displayName: 'Alice', bot: false }, content: 'hi' }]

    const result = await (harness.loop as any).finalizeInlineExecution({
      accumulatedOutput: 'Thanks, @Alice.',
      pendingToolPersistence: [],
      allToolCallIds: [],
      allSentMessageIds: [],
      messageContexts: {},
      lastContextEndPos: 0,
      channelId: 'channel-1',
      triggeringMessageId: 'trigger-1',
      config: { name: 'TestBot', use_display_names_humans: true },
      llmRequest: { stop_sequences: [] },
      discordMessages,
      markdownCarry: [],
    })

    expect(harness.sent()).toEqual(['Thanks, <@111>.'])
    expect(result.completion.content).toEqual([{ type: 'text', text: 'Thanks, @Alice.' }])
  })

  it('strips the reply tag before it reads mentions, so a mention the reply starts with is read as it is sent', async () => {
    const harness = makeLoop()
    cleanup = harness.cleanup
    const discordMessages = [{ id: 'm-1', author: { id: '111', username: 'alice', displayName: 'Alice', bot: false }, content: 'hi' }]

    await (harness.loop as any).finalizeInlineExecution({
      accumulatedOutput: '<reply:@sam>@Alice thanks',
      pendingToolPersistence: [],
      allToolCallIds: [],
      allSentMessageIds: [],
      messageContexts: {},
      lastContextEndPos: 0,
      channelId: 'channel-1',
      triggeringMessageId: 'trigger-1',
      config: { name: 'TestBot', use_display_names_humans: true },
      llmRequest: { stop_sequences: [] },
      discordMessages,
      markdownCarry: [],
    })

    expect(harness.sent()).toEqual(['<@111> thanks'])
  })
})
