/**
 * asSentence: how a tool's answer to the model quotes the reason an action
 * failed.
 *
 * Run with: npm test -- error-text
 */

import { describe, it, expect } from 'vitest'
import { asSentence } from './error-text.js'

describe('asSentence', () => {
  it('ends a reason with a full stop', () => {
    expect(asSentence(new Error('the channel has 50 pins'))).toBe('the channel has 50 pins.')
  })

  it('keeps a reason that already ends a sentence as it is', () => {
    expect(asSentence(new Error('Missing Permissions.'))).toBe('Missing Permissions.')
    expect(asSentence(new Error('Pin it yourself!'))).toBe('Pin it yourself!')
  })

  it('takes a thrown string as the reason', () => {
    expect(asSentence('relay down')).toBe('relay down.')
  })

  it('takes a thrown number or an object\'s message as the reason', () => {
    expect(asSentence(50013)).toBe('50013.')
    expect(asSentence({ message: 'Missing Access', code: 50001 })).toBe('Missing Access.')
  })

  it('says there was no reason rather than print an empty one', () => {
    expect(asSentence(new Error(''))).toBe('No reason was given.')
    expect(asSentence(undefined)).toBe('No reason was given.')
    expect(asSentence(null)).toBe('No reason was given.')
    expect(asSentence({ code: 50013 })).toBe('No reason was given.')
  })
})
