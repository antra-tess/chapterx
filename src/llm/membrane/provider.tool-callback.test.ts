import { describe, it, expect, vi } from 'vitest'
import { Membrane } from '@animalabs/membrane'
import { MembraneProvider } from './provider.js'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, writeFileSync: () => undefined, appendFileSync: () => undefined }
})

const TOOL = { name: 'lookup', description: 'Look something up', inputSchema: { type: 'object', properties: {} } }

/**
 * A stand-in for membrane 0.5.81 to 0.6.0's stream(), which the lockfile
 * doesn't install: with streaming off it refuses onToolCalls before any
 * provider call, and otherwise answers. It records what it was handed.
 */
function membraneFrom0581() {
  const handed: Array<{ streaming?: boolean; tools: number; onToolCalls: unknown }> = []
  const membrane = {
    async stream(request: any, options: any) {
      handed.push({ streaming: request.streaming, tools: request.tools?.length ?? 0, onToolCalls: options.onToolCalls })
      if (request.streaming === false && options.onToolCalls) {
        throw new Error('stream() cannot execute tools with streaming: false')
      }
      return {
        content: [{ type: 'text', text: 'It is noon.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        details: { usage: { cacheCreationTokens: 0, cacheReadTokens: 0 }, model: { actual: 'stub-model' } },
        raw: { response: {} },
      }
    },
  }
  return { handed, provider: new MembraneProvider(membrane as any) }
}

function request(streaming: boolean | undefined, tools?: unknown[]): any {
  return {
    messages: [{ participant: 'alice', content: [{ type: 'text', text: 'What time is it?' }] }],
    system_prompt: 'You are a bot.',
    config: { model: 'openai/gpt-4o', temperature: 0.7, max_tokens: 256, botName: 'Bot', mode: 'chat', ...(streaming === undefined ? {} : { streaming }) },
    ...(tools ? { tools } : {}),
  }
}

const onToolCalls = async () => []

describe('MembraneProvider.stream', () => {
  // A bot with streaming off, as a provider's streaming bugs call for, failed
  // every request on membrane 0.5.81 to 0.6.0, since the native tool path
  // passes onToolCalls whether or not the request has tools. A request with
  // tools: [] has none either.
  it('hands membrane no tool callback for a request with streaming off and no tools, so it gets its answer', async () => {
    for (const tools of [undefined, []]) {
      const { handed, provider } = membraneFrom0581()

      const completion = await provider.stream(request(false, tools), { onToolCalls })

      expect(completion.content).toEqual([{ type: 'text', text: 'It is noon.' }])
      expect(handed).toEqual([{ streaming: false, tools: 0, onToolCalls: undefined }])
    }
  })

  // With streaming on, membrane runs tool calls through the callback, on its
  // XML path even for a request without tools. With streaming off and tools,
  // 0.5.81 to 0.6.0 refuse the request.
  it("hands membrane the caller's tool callback with streaming on, and with streaming off and tools", async () => {
    for (const [streaming, tools] of [[undefined, []], [true, undefined], [true, [TOOL]]] as const) {
      const { handed, provider } = membraneFrom0581()

      await provider.stream(request(streaming, tools as unknown[] | undefined), { onToolCalls })

      expect(handed[0].onToolCalls).toBe(onToolCalls)
    }

    const { handed, provider } = membraneFrom0581()
    await expect(provider.stream(request(false, [TOOL]), { onToolCalls })).rejects.toThrow('cannot execute tools with streaming: false')
    expect(handed).toEqual([{ streaming: false, tools: 1, onToolCalls }])
  })

  it('hands membrane no tool callback when its caller gives none', async () => {
    for (const streaming of [false, undefined]) {
      const { handed, provider } = membraneFrom0581()

      await provider.stream(request(streaming, [TOOL]), {})

      expect(handed[0].onToolCalls).toBeUndefined()
    }
  })

  // The installed membrane itself, with a stand-in for the provider's API. On
  // 0.5.47, the lockfile's, stream() takes a streaming-off request to
  // complete() whatever it is handed; from 0.5.81 it answers only without a
  // callback.
  it('answers a request with streaming off and no tools through the installed membrane', async () => {
    const calls: string[] = []
    const answer = { content: [{ type: 'text', text: 'It is noon.' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, model: 'stub-model', rawRequest: {}, raw: {} }
    const adapter = {
      name: 'stub',
      supportsModel: () => true,
      complete: async () => { calls.push('complete'); return answer },
      stream: async () => { calls.push('stream'); return answer },
    }
    const provider = new MembraneProvider(new Membrane(adapter as any))

    const completion = await provider.stream(request(false, []), { onToolCalls })

    expect(completion.content).toEqual([{ type: 'text', text: 'It is noon.' }])
    expect(calls).toEqual(['complete'])
  })
})
