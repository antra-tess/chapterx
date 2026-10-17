import { describe, it, expect } from 'vitest'
import type { TrackedPin } from '../types.js'
import { extractConfigs, extractSteers, extractSleeps } from './pin-extract.js'

const pin = (id: string, content: string, over: Partial<TrackedPin> = {}): TrackedPin => ({
  id,
  content,
  authorId: 'u',
  authorBot: false,
  ...over,
})

describe('extractConfigs', () => {
  it('extracts yaml from .config pins, prepending target', () => {
    const pins = [
      pin('2', '.config\n---\nfoo: 1'),
      pin('1', '.config Mythos\n---\nbar: 2'),
      pin('3', 'not a config'),
    ]
    // sorted by id: 1 (targeted), 2 (plain)
    expect(extractConfigs(pins)).toEqual(['target: Mythos\nbar: 2', 'foo: 1'])
  })

  it('ignores malformed .config (no --- separator)', () => {
    expect(extractConfigs([pin('1', '.config\nfoo: 1')])).toEqual([])
  })

  it('orders pins from before and after July 2022 by time, not as strings', () => {
    // An 18-digit snowflake (2021) and a 19-digit one (2024): the later config
    // must come last so it wins the merge.
    const pins = [pin('1200000000000000000', '.config\n---\nmood: new'), pin('900000000000000000', '.config\n---\nmood: old')]
    expect(extractConfigs(pins)).toEqual(['mood: old', 'mood: new'])
  })

  it('strips the target of a pin addressed to this bot, by name or by persona mention', () => {
    const ctx = { identity: { botId: '', discordUsername: 'glm52', discordUserId: 'persona-p' } }
    const pins = [
      pin('1', '.config glm52\n---\na: 1'),
      pin('2', '.config someone\n---\nb: 2', { mentionedPersonaIds: ['persona-p'] }),
      pin('3', '.config Mythos\n---\nc: 3'),
    ]
    expect(extractConfigs(pins, ctx)).toEqual(['a: 1', 'b: 2', 'target: Mythos\nc: 3'])
  })
})

describe('extractSteers', () => {
  it('returns non-bot .steer pins with authorId', () => {
    const pins = [
      pin('1', '.steer be nice', { authorId: 'human1' }),
      pin('2', '.steer evil', { authorBot: true, authorId: 'bot1' }),
      pin('3', '.config\n---\nx: 1'),
    ]
    expect(extractSteers(pins)).toEqual([{ content: '.steer be nice', authorId: 'human1' }])
  })

  it('carries a steer pin\'s resolved mentions through', () => {
    const pins = [pin('1', '.steer be brief', { mentionedPersonaIds: ['persona-p'], mentionedRoleIds: ['r1'] })]
    const [steer] = extractSteers(pins)
    expect(steer!.mentionedPersonaIds).toEqual(['persona-p'])
    expect(steer!.mentionedRoleIds).toEqual(['r1'])
  })
})

describe('extractSleeps', () => {
  it('returns .sleep pins as full records, sorted by id', () => {
    const pins = [pin('2', '.sleep messages: 3'), pin('1', '.sleep'), pin('3', '.config\n---\nx: 1')]
    expect(extractSleeps(pins).map((p) => p.id)).toEqual(['1', '2'])
  })
})
