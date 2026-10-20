/**
 * The rolling threshold under both rules @animalabs/membrane's shouldRoll()
 * has had within ^0.5.47: 0.5.80 and earlier compare the threshold with
 * state.messagesSinceRoll, and 0.5.81 and later with the messageCount
 * argument. package-lock.json installs 0.5.47, while an install without it
 * takes the newest 0.5.x.
 *
 * Run with: npx vitest run rolling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as membrane from '@animalabs/membrane'
import { applyLimits } from './stages/cache-and-limits.js'
import type { BotConfig, ParticipantMessage } from '../types.js'

vi.mock('@animalabs/membrane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@animalabs/membrane')>()
  return { ...actual, shouldRoll: vi.fn(actual.shouldRoll) }
})

const actual = await vi.importActual<typeof import('@animalabs/membrane')>('@animalabs/membrane')

/**
 * A stand-in for membrane 0.5.81 to 0.6.0's shouldRoll(), as far as ChapterX's
 * config and its reading of `shouldRoll` and `reason` reach, written from
 * shouldRoll() in those versions' dist/context/process.js, which the lockfile
 * doesn't install: 0.5.80's checks, with the threshold compared with
 * messageCount rather than state.messagesSinceRoll.
 */
const shouldRollFrom0581: typeof membrane.shouldRoll = (_state, messageCount, totalTokens, totalCharacters, config) => {
  const { rolling, limits } = config
  if (
    (limits?.maxCharacters && totalCharacters > limits.maxCharacters) ||
    (limits?.maxTokens && totalTokens > limits.maxTokens) ||
    (limits?.maxMessages && messageCount > limits.maxMessages)
  ) {
    return { shouldRoll: true, reason: 'hard_limit', enteredGrace: false }
  }
  if (messageCount >= rolling.threshold + (rolling.grace ?? 0)) {
    return { shouldRoll: true, reason: 'grace_exceeded', enteredGrace: false }
  }
  return { shouldRoll: false, enteredGrace: false }
}

function message(i: number): ParticipantMessage {
  return { participant: 'alice', content: [{ type: 'text', text: `message ${i}` }], messageId: `m${i}` }
}

function botConfig(overrides: Partial<BotConfig>): BotConfig {
  return { recency_window_characters: 100000, hard_max_characters: 500000, ...overrides } as BotConfig
}

describe.each([
  ['the installed membrane', () => actual.shouldRoll],
  ["membrane 0.5.81's rule", () => shouldRollFrom0581],
] as const)('the rolling threshold, with %s', (_name, rule) => {
  beforeEach(() => {
    vi.mocked(membrane.shouldRoll).mockImplementation(rule())
  })

  // From membrane 0.5.81 the threshold never fired, since ChapterX handed it
  // messageCount 0, so with prompt caching on a window was never cut back to
  // recency_window_messages, while the suite, on 0.5.47, passed. A count of
  // 49 is under the threshold and above recency_window_messages, so it would
  // roll if membrane were handed maxMessages, which both rules compare with
  // messageCount.
  it('cuts a window past recency_window_messages to it when the count since the last roll reaches rolling_threshold, and not before', () => {
    const messages = Array.from({ length: 60 }, (_, i) => message(i))
    const config = botConfig({ recency_window_messages: 40, rolling_threshold: 50 })

    const before = applyLimits(messages, 49, config)
    expect(before.didTruncate).toBe(false)
    expect(before.messages).toHaveLength(60)

    const at = applyLimits(messages, 50, config)
    expect(at.didTruncate).toBe(true)
    expect(at.messages).toHaveLength(40)
  })
})
