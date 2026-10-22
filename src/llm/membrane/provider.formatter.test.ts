/**
 * Both of the provider's entry points hand membrane the formatter
 * resolveFormatterForModel gives: the config's mode first, then the model name.
 */
import { describe, it, expect } from 'vitest'
import { AnthropicXmlFormatter, CompletionsFormatter, NativeFormatter } from '@animalabs/membrane'
import { MembraneProvider } from './provider.js'

const ANSWER = {
  content: [{ type: 'text', text: 'It is noon.' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  details: { usage: { cacheCreationTokens: 0, cacheReadTokens: 0 }, model: { actual: 'stub-model' } },
  raw: { response: {} },
}

/** A provider over a membrane that records the formatter each call is handed. */
function recording() {
  const formatters: unknown[] = []
  const membrane = {
    async stream(_request: unknown, options: { formatter?: unknown }) { formatters.push(options.formatter); return ANSWER },
    async complete(_request: unknown, options: { formatter?: unknown }) { formatters.push(options.formatter); return ANSWER },
  }
  return { formatters, provider: new MembraneProvider(membrane as any) }
}

function request(model: string, mode?: string): any {
  return {
    messages: [{ participant: 'alice', content: [{ type: 'text', text: 'What time is it?' }] }],
    system_prompt: 'You are a bot.',
    config: { model, temperature: 0.7, max_tokens: 256, botName: 'Bot', ...(mode ? { mode } : {}) },
  }
}

describe('the formatter the provider hands membrane', () => {
  it.each([
    ['claude-sonnet-4-5', undefined, AnthropicXmlFormatter],
    ['claude-sonnet-4-5', 'chat', NativeFormatter],
    ['gemini-3.5-flash-lite', 'prefill', AnthropicXmlFormatter],
    ['gemini-3.5-flash-lite', 'base-model', CompletionsFormatter],
  ] as const)('for %s with mode %s, on both entry points', async (model, mode, Formatter) => {
    const { formatters, provider } = recording()
    await provider.stream(request(model, mode), {})
    await provider.completeFromLLMRequest(request(model, mode))
    expect(formatters).toHaveLength(2)
    for (const formatter of formatters) expect(formatter).toBeInstanceOf(Formatter)
  })
})
