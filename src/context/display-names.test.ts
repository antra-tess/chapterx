/**
 * Tests for display name mention rewriting
 *
 * Run with: npx vitest run display-names
 */

import { describe, it, expect } from 'vitest'
import { rewriteMentionsForDisplayNames, stripReplyTags } from './builder.js'
import type { ContentBlock } from '../types.js'

// Helper to make a text block and return it after applying the function
function rewrite(
  text: string,
  map: Map<string, string>,
  botName = 'Claude'
): string {
  const blocks: ContentBlock[] = [{ type: 'text', text }]
  rewriteMentionsForDisplayNames(blocks, map, botName)
  return (blocks[0] as { text: string }).text
}

function strip(text: string): string {
  const blocks: ContentBlock[] = [{ type: 'text', text }]
  stripReplyTags(blocks)
  return (blocks[0] as { text: string }).text
}

// ============================================================================
// rewriteMentionsForDisplayNames
// ============================================================================

describe('rewriteMentionsForDisplayNames', () => {
  it('rewrites <@username> to @DisplayName', () => {
    const map = new Map([['alice.smith', 'Alice Smith']])
    expect(rewrite('hey <@alice.smith> check this', map))
      .toBe('hey @Alice Smith check this')
  })

  it('rewrites multiple mentions in same message', () => {
    const map = new Map([
      ['alice.smith', 'Alice Smith'],
      ['bob_jones', 'Bob Jones'],
    ])
    expect(rewrite('<@alice.smith> and <@bob_jones> thoughts?', map))
      .toBe('@Alice Smith and @Bob Jones thoughts?')
  })

  it('rewrites reply tags to (replying to @DisplayName)', () => {
    const map = new Map([['alice.smith', 'Alice Smith']])
    expect(rewrite('<reply:@alice.smith> I agree', map))
      .toBe('(replying to @Alice Smith) I agree')
  })

  it('strips angle brackets from bot mentions', () => {
    const map = new Map<string, string>()
    expect(rewrite('hey <@Claude> what do you think?', map, 'Claude'))
      .toBe('hey @Claude what do you think?')
  })

  it('strips angle brackets from bot reply tags', () => {
    const map = new Map<string, string>()
    expect(rewrite('<reply:@Claude> thanks!', map, 'Claude'))
      .toBe('(replying to @Claude) thanks!')
  })

  it('handles bot name with special regex characters', () => {
    const map = new Map<string, string>()
    expect(rewrite('hey <@Opus 4.5> nice', map, 'Opus 4.5'))
      .toBe('hey @Opus 4.5 nice')
  })

  it('handles usernames with dots', () => {
    const map = new Map([['j.doe.99', 'Jane Doe']])
    expect(rewrite('ask <@j.doe.99>', map))
      .toBe('ask @Jane Doe')
  })

  it('handles duplicate mentions of same user', () => {
    const map = new Map([['alice', 'Alice Smith']])
    expect(rewrite('<@alice> told <@alice> to stop', map))
      .toBe('@Alice Smith told @Alice Smith to stop')
  })

  it('does nothing when map is empty and no bot mentions', () => {
    const map = new Map<string, string>()
    expect(rewrite('hello world', map, 'Claude'))
      .toBe('hello world')
  })

  it('leaves non-mention angle brackets alone', () => {
    const map = new Map([['alice', 'Alice']])
    expect(rewrite('<thinking>some thought</thinking> <@alice>', map))
      .toBe('<thinking>some thought</thinking> @Alice')
  })

  it('skips non-text content blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hey <@alice>' },
      { type: 'image', source: { type: 'base64', data: 'abc', media_type: 'image/png' } },
      { type: 'text', text: '<@alice> again' },
    ]
    const map = new Map([['alice', 'Alice']])
    rewriteMentionsForDisplayNames(blocks, map, 'Claude')
    expect((blocks[0] as any).text).toBe('hey @Alice')
    expect(blocks[1].type).toBe('image')
    expect((blocks[2] as any).text).toBe('@Alice again')
  })

  it('handles combined user mention + bot mention + reply', () => {
    const map = new Map([['alice', 'Alice Smith']])
    const result = rewrite('<reply:@alice> hey <@Claude> and <@alice>', map, 'Claude')
    expect(result).toBe('(replying to @Alice Smith) hey @Claude and @Alice Smith')
  })
})

// ============================================================================
// stripReplyTags
// ============================================================================

describe('stripReplyTags', () => {
  it('strips <reply:@username> format', () => {
    expect(strip('<reply:@alice> hello')).toBe('hello')
  })

  it('strips (replying to @DisplayName) format', () => {
    expect(strip('(replying to @Alice Smith) hello')).toBe('hello')
  })

  it('only strips from start of text', () => {
    expect(strip('middle <reply:@alice> text')).toBe('middle <reply:@alice> text')
  })

  it('only strips from start of text (display name format)', () => {
    expect(strip('middle (replying to @Alice) text')).toBe('middle (replying to @Alice) text')
  })

  it('preserves text with no reply tags', () => {
    expect(strip('just a normal message')).toBe('just a normal message')
  })

  it('handles reply tag with no trailing content', () => {
    expect(strip('<reply:@alice> ')).toBe('')
  })

  it('handles display name with special chars in parens', () => {
    expect(strip('(replying to @J. Doe Jr.) okay')).toBe('okay')
  })
})
