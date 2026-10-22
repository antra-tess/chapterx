/**
 * Whether a bot's requests carry a voice message's audio: only from membrane's
 * native formatter, to a Gemini model on its own Gemini adapter. Other bots
 * with the setting on keep the "not included" line and are warned once per
 * model and mode.
 *
 * A file of its own, since building a membrane sets the factory's routing for
 * the rest of the file. The warnings are given once per process, so each test
 * uses models and modes no other test here does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMembrane, createMembraneFromVendorConfigs, resolveFormatterForModel } from '../llm/membrane/factory.js'
import { logger } from '../utils/logger.js'
import { hearsVoiceMessages, voiceMessagesUnheardReason } from './voice-messages.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A bot config with the setting on. */
const on = (continuation_model: string, mode?: 'chat' | 'prefill' | 'base-model') =>
  ({ include_voice_messages: true, continuation_model, mode })

const ONLY_GEMINI = "voice messages go only to Gemini models (gemini-* or gemini_*) on Gemini's own adapter"

describe('resolveFormatterForModel', () => {
  it('takes the mode first, then the model name: anthropic-xml for Claude, native otherwise', () => {
    expect(resolveFormatterForModel('claude-sonnet-4-5')).toBe('anthropic-xml')
    expect(resolveFormatterForModel('anthropic.claude-3-sonnet')).toBe('anthropic-xml')
    expect(resolveFormatterForModel('gemini-3.5-flash-lite')).toBe('native')
    expect(resolveFormatterForModel('claude-sonnet-4-5', 'chat')).toBe('native')
    expect(resolveFormatterForModel('gemini-3.5-flash-lite', 'prefill')).toBe('anthropic-xml')
    expect(resolveFormatterForModel('gemini-3.5-flash-lite', 'base-model')).toBe('completions')
  })
})

describe('with no membrane built', () => {
  it('passes a Gemini model through the native formatter, and nothing else', () => {
    expect(voiceMessagesUnheardReason('gemini-3.5-flash-lite')).toBeUndefined()
    expect(voiceMessagesUnheardReason('gemini-3.5-flash-lite', 'chat')).toBeUndefined()
    expect(voiceMessagesUnheardReason('gemini_3_5_flash_lite')).toBeUndefined()
    expect(voiceMessagesUnheardReason('google/gemini-3.5-flash-lite', 'chat')).toBe(ONLY_GEMINI)
    expect(voiceMessagesUnheardReason('gemini-3.5-flash-lite', 'prefill')).toBe("membrane's anthropic-xml formatter can't send audio")
    expect(voiceMessagesUnheardReason('gemini-3.5-flash-lite', 'base-model')).toBe("membrane's completions formatter can't send audio")
    expect(voiceMessagesUnheardReason('claude-sonnet-4-5')).toBe("membrane's anthropic-xml formatter can't send audio")
    expect(voiceMessagesUnheardReason('claude-sonnet-4-5', 'chat')).toBe(ONLY_GEMINI)
    expect(voiceMessagesUnheardReason('gpt-5.6')).toBe(ONLY_GEMINI)
    expect(voiceMessagesUnheardReason('openai/gpt-audio')).toBe(ONLY_GEMINI)
  })

  it('warns once for each model and mode that cannot carry audio', () => {
    const warn = vi.spyOn(logger, 'warn')
    expect(hearsVoiceMessages(on('claude-haiku-4-5'))).toBe(false)
    expect(hearsVoiceMessages(on('claude-haiku-4-5'))).toBe(false)
    expect(hearsVoiceMessages(on('claude-haiku-4-5', 'base-model'))).toBe(false)
    expect(hearsVoiceMessages(on('claude-opus-4-1'))).toBe(false)
    expect(hearsVoiceMessages(on('claude-opus-4-1'))).toBe(false)
    const stop = 'Set include_voice_messages: false to stop this warning.'
    expect(warn.mock.calls).toEqual([
      [{ model: 'claude-haiku-4-5', mode: undefined }, `Voice messages not sent: membrane's anthropic-xml formatter can't send audio. ${stop}`],
      [{ model: 'claude-haiku-4-5', mode: 'base-model' }, `Voice messages not sent: membrane's completions formatter can't send audio. ${stop}`],
      [{ model: 'claude-opus-4-1', mode: undefined }, `Voice messages not sent: membrane's anthropic-xml formatter can't send audio. ${stop}`],
    ])
  })
})

describe('with a membrane built', () => {
  it('reads the adapter a Gemini model is routed to, by its class rather than its configurable name', () => {
    createMembrane({
      assistantName: 'Bot',
      anthropicApiKey: 'test-key',
      openrouterApiKey: 'test-key',
      gemini: { apiKey: 'test-key' },
      // An OpenAI-compatible endpoint named "gemini" serving gemini-compat-* models
      openaiCompatibleProviders: [{ name: 'gemini', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/v1', provides: ['gemini-compat-*'] }],
    } as any)
    const warn = vi.spyOn(logger, 'warn')
    expect(hearsVoiceMessages(on('gemini-3.8-flash'))).toBe(true)
    expect(hearsVoiceMessages(on('gemini_3_8_flash', 'chat'))).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    expect(voiceMessagesUnheardReason('google/gemini-3.8-flash', 'chat')).toBe(ONLY_GEMINI)
    expect(voiceMessagesUnheardReason('anthropic/claude-sonnet-4-5', 'chat')).toBe(ONLY_GEMINI)
    expect(voiceMessagesUnheardReason('gemini-compat-1', 'chat')).toBe('this model is routed to membrane\'s OpenAICompatibleAdapter ("gemini"), not its GeminiAdapter')
  })

  it("takes a vendor's formatter route between the mode and the model name", () => {
    createMembraneFromVendorConfigs(
      { gemini: { config: { google_api_key: 'test-key' }, provides: ['gemini-routed-*'], formatter: 'anthropic-xml' } },
      'Bot',
    )
    expect(resolveFormatterForModel('gemini-routed-1')).toBe('anthropic-xml')
    expect(resolveFormatterForModel('gemini-routed-1', 'chat')).toBe('native')
    expect(voiceMessagesUnheardReason('gemini-routed-1')).toBe("membrane's anthropic-xml formatter can't send audio")
  })
})
