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
})

describe('extractSleeps', () => {
  it('returns .sleep pins as full records, sorted by id', () => {
    const pins = [pin('2', '.sleep messages: 3'), pin('1', '.sleep'), pin('3', '.config\n---\nx: 1')]
    expect(extractSleeps(pins).map((p) => p.id)).toEqual(['1', '2'])
  })
})
