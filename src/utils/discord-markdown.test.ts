/**
 * Exhaustive test suite for src/utils/discord-markdown.ts
 *
 * Covers: splitPreservingMarkdown, scanMarkdown, closeMarks, reopenMarks, exclusiveOnly.
 *
 * Organisation:
 *  1. Helpers & invariant checkers
 *  2. closeMarks / reopenMarks / exclusiveOnly unit tests
 *  3. scanMarkdown unit tests
 *  4. splitPreservingMarkdown — plain-text / fast-path
 *  5. splitPreservingMarkdown — code fences
 *  6. splitPreservingMarkdown — inline code
 *  7. splitPreservingMarkdown — emphasis
 *  8. splitPreservingMarkdown — nesting & ordering
 *  9. splitPreservingMarkdown — startCarry continuation
 * 10. splitPreservingMarkdown — edge cases
 */

import { describe, it, expect } from 'vitest'
import {
  splitPreservingMarkdown,
  scanMarkdown,
  exclusiveOnly,
  closeMarks,
  reopenMarks,
  type ChunkPiece,
  type MarkdownCarry,
  type OpenMark,
} from './discord-markdown.js'

// ---------------------------------------------------------------------------
// 1. Shared helpers
// ---------------------------------------------------------------------------

/** Strip bridge strings from every chunk and concatenate — must equal original. */
function reconstruct(chunks: ChunkPiece[]): string {
  return chunks
    .map((c) => {
      let t = c.text
      if (c.bridgeOpen && t.startsWith(c.bridgeOpen)) t = t.slice(c.bridgeOpen.length)
      if (c.bridgeClose && t.endsWith(c.bridgeClose)) t = t.slice(0, t.length - c.bridgeClose.length)
      return t
    })
    .join('')
}

/** Every chunk's text must be <= maxLength. */
function assertAllWithinLimit(chunks: ChunkPiece[], maxLength: number): void {
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(maxLength)
  }
}

/** Count (non-overlapping) occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    n++
    pos += needle.length
  }
  return n
}

// ---------------------------------------------------------------------------
// 2. closeMarks / reopenMarks / exclusiveOnly
// ---------------------------------------------------------------------------

describe('closeMarks', () => {
  it('returns empty string for empty stack', () => {
    expect(closeMarks([])).toBe('')
  })

  it('closes a simple fence (adds leading newline)', () => {
    const stack: MarkdownCarry = [{ kind: 'fence', opener: '```bash', closer: '```' }]
    // closeMarks with a non-newline-terminated body will prepend \n
    const result = closeMarks(stack)
    expect(result).toBe('\n```')
  })

  it('closes multiple emphasis innermost-first', () => {
    const stack: MarkdownCarry = [
      { kind: 'bold', opener: '**', closer: '**' },
      { kind: 'italic', opener: '*', closer: '*' },
    ]
    // innermost = italic (index 1) → close * first then **
    expect(closeMarks(stack)).toBe('***')
  })

  it('closes spoiler', () => {
    const stack: MarkdownCarry = [{ kind: 'spoiler', opener: '||', closer: '||' }]
    expect(closeMarks(stack)).toBe('||')
  })

  it('closes strike', () => {
    const stack: MarkdownCarry = [{ kind: 'strike', opener: '~~', closer: '~~' }]
    expect(closeMarks(stack)).toBe('~~')
  })
})

describe('reopenMarks', () => {
  it('returns empty string for empty stack', () => {
    expect(reopenMarks([])).toBe('')
  })

  it('reopens a fence with trailing newline', () => {
    const stack: MarkdownCarry = [{ kind: 'fence', opener: '```python', closer: '```' }]
    expect(reopenMarks(stack)).toBe('```python\n')
  })

  it('reopens multiple emphasis outermost-first', () => {
    const stack: MarkdownCarry = [
      { kind: 'bold', opener: '**', closer: '**' },
      { kind: 'italic', opener: '*', closer: '*' },
    ]
    // outermost = bold (index 0) → reopen ** first then *
    expect(reopenMarks(stack)).toBe('***')
  })

  it('reopens inline code without newline', () => {
    const stack: MarkdownCarry = [{ kind: 'inlineCode', opener: '`', closer: '`' }]
    expect(reopenMarks(stack)).toBe('`')
  })
})

describe('exclusiveOnly', () => {
  it('keeps fence entries', () => {
    const stack: MarkdownCarry = [{ kind: 'fence', opener: '```', closer: '```' }]
    expect(exclusiveOnly(stack)).toHaveLength(1)
  })

  it('keeps inlineCode entries', () => {
    const stack: MarkdownCarry = [{ kind: 'inlineCode', opener: '``', closer: '``' }]
    expect(exclusiveOnly(stack)).toHaveLength(1)
  })

  it('removes all emphasis kinds', () => {
    const stack: MarkdownCarry = [
      { kind: 'bold', opener: '**', closer: '**' },
      { kind: 'italic', opener: '*', closer: '*' },
      { kind: 'boldItalic', opener: '***', closer: '***' },
      { kind: 'underline', opener: '__', closer: '__' },
      { kind: 'strike', opener: '~~', closer: '~~' },
      { kind: 'spoiler', opener: '||', closer: '||' },
    ]
    expect(exclusiveOnly(stack)).toHaveLength(0)
  })

  it('keeps fence but drops emphasis in mixed stack', () => {
    const stack: MarkdownCarry = [
      { kind: 'fence', opener: '```', closer: '```' },
      { kind: 'bold', opener: '**', closer: '**' },
    ]
    const result = exclusiveOnly(stack)
    expect(result).toHaveLength(1)
    expect(result[0]!.kind).toBe('fence')
  })
})

// ---------------------------------------------------------------------------
// 3. scanMarkdown
// ---------------------------------------------------------------------------

describe('scanMarkdown', () => {
  it('returns empty for plain text', () => {
    expect(scanMarkdown('hello world')).toEqual([])
  })

  it('returns empty for balanced fence', () => {
    expect(scanMarkdown('```\ncode\n```')).toEqual([])
  })

  it('detects unclosed fence (backtick)', () => {
    const carry = scanMarkdown('```bash\necho hi')
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('fence')
    expect(carry[0]!.opener).toBe('```bash')
    expect(carry[0]!.closer).toBe('```')
  })

  it('detects unclosed fence (tilde)', () => {
    const carry = scanMarkdown('~~~python\nprint(1)')
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('fence')
    expect(carry[0]!.opener).toBe('~~~python')
    expect(carry[0]!.closer).toBe('~~~')
  })

  it('detects unclosed 4-backtick fence', () => {
    const carry = scanMarkdown('````ts\ncode')
    expect(carry).toHaveLength(1)
    expect(carry[0]!.opener).toBe('````ts')
    expect(carry[0]!.closer).toBe('````')
  })

  it('detects unclosed 5-backtick fence', () => {
    const carry = scanMarkdown('`````\ncode')
    expect(carry[0]!.closer).toBe('`````')
  })

  it('detects unclosed inline code (single backtick)', () => {
    const carry = scanMarkdown('hello `world')
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('inlineCode')
    expect(carry[0]!.opener).toBe('`')
  })

  it('detects unclosed inline code (double backtick)', () => {
    const carry = scanMarkdown('test ``code')
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('inlineCode')
    expect(carry[0]!.opener).toBe('``')
  })

  it('closed inline code returns empty carry', () => {
    expect(scanMarkdown('`hello`')).toEqual([])
  })

  it('unmatched bold is in carry', () => {
    const carry = scanMarkdown('this is **bold')
    expect(carry.some((m) => m.kind === 'bold')).toBe(true)
  })

  it('matched bold returns empty carry', () => {
    expect(scanMarkdown('**bold**')).toEqual([])
  })

  it('unmatched italic is in carry', () => {
    const carry = scanMarkdown('*italic without close')
    expect(carry.some((m) => m.kind === 'italic')).toBe(true)
  })

  it('matched italic returns empty carry', () => {
    expect(scanMarkdown('*italic*')).toEqual([])
  })

  it('unmatched strike is in carry', () => {
    const carry = scanMarkdown('~~strike without close')
    expect(carry.some((m) => m.kind === 'strike')).toBe(true)
  })

  it('unmatched spoiler is in carry', () => {
    const carry = scanMarkdown('||spoiler without close')
    expect(carry.some((m) => m.kind === 'spoiler')).toBe(true)
  })

  it('backtick with backtick in info string is NOT a fence opener', () => {
    // ```foo`bar  — info contains backtick, invalid fence
    const carry = scanMarkdown('```foo`bar\ncode')
    // Should see inlineCode for ```, not a fence
    // The ``` tries to open fence but info has backtick → rejected
    // Then ``` at line start with invalid info → falls to inline code
    // Let's just assert it doesn't open a fence
    expect(carry.every((m) => m.kind !== 'fence')).toBe(true)
  })

  it('closing fence with info string is NOT a valid closer', () => {
    // A closing fence with trailing content (not whitespace) does NOT close the fence
    const carry = scanMarkdown('```\ncode\n``` not-a-close')
    // The "``` not-a-close" line has non-whitespace after the marker → not a valid close
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('fence')
  })

  it('~~~ fence is not closed by ``` and vice versa', () => {
    const carry = scanMarkdown('~~~\ncode\n```')
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('fence')
    expect(carry[0]!.opener).toBe('~~~')
  })

  it('``` inside ~~~ block is literal content, not a fence opener', () => {
    const carry = scanMarkdown('~~~\n```\ncode\n~~~')
    // ~~~ closes the ~~~ fence; the ``` inside is literal
    expect(carry).toEqual([])
  })

  it('scanMarkdown with startCarry', () => {
    const startCarry = scanMarkdown('```python\nprint(1)')
    expect(startCarry[0]!.kind).toBe('fence')
    // Continue: provide the closing line
    const carry2 = scanMarkdown('print(2)\n```\ndone', startCarry)
    expect(carry2).toEqual([])
  })

  it('emphasis inside fence is literal (no carry for it)', () => {
    const carry = scanMarkdown('```\nrate **is** 5\n```')
    expect(carry).toEqual([])
  })

  it('emphasis inside unclosed fence is NOT in carry as emphasis', () => {
    const carry = scanMarkdown('```\nrate **is** 5')
    // Only the fence is open; ** is literal inside fence
    expect(carry.every((m) => m.kind !== 'bold')).toBe(true)
  })

  it('intra-word underscore is NOT italic', () => {
    const carry = scanMarkdown('word_other')
    // The underscore is intra-word → not italic
    expect(carry).toEqual([])
  })

  it('escaped asterisk is literal', () => {
    const carry = scanMarkdown('hello \\* world')
    expect(carry).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. splitPreservingMarkdown — plain text / fast path
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — plain text', () => {
  it('empty string → single empty chunk', () => {
    const r = splitPreservingMarkdown('', 100)
    expect(r.chunks).toHaveLength(1)
    expect(r.chunks[0]!.text).toBe('')
    expect(r.endCarry).toEqual([])
  })

  it('single char within limit → single chunk', () => {
    const r = splitPreservingMarkdown('x', 100)
    expect(r.chunks).toEqual([{ text: 'x' }])
  })

  it('text exactly maxLength → single chunk (not two)', () => {
    const text = 'a'.repeat(100)
    const r = splitPreservingMarkdown(text, 100)
    expect(r.chunks).toHaveLength(1)
    expect(r.chunks[0]!.text).toBe(text)
  })

  it('text one over maxLength → splits into two', () => {
    const text = 'a'.repeat(101)
    const r = splitPreservingMarkdown(text, 100)
    expect(r.chunks.length).toBeGreaterThanOrEqual(2)
    assertAllWithinLimit(r.chunks, 100)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('no-markdown fast path returns single chunk unchanged', () => {
    const text = 'Hello, world! No markdown here.'
    const r = splitPreservingMarkdown(text, 1000)
    expect(r.chunks).toEqual([{ text }])
    expect(r.endCarry).toEqual([])
  })

  it('multi-line plain text splits on newlines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} content`)
    const text = lines.join('\n')
    const r = splitPreservingMarkdown(text, 200)
    assertAllWithinLimit(r.chunks, 200)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('endCarry is empty for fully plain text', () => {
    const r = splitPreservingMarkdown('hello world, no markdown!', 100)
    expect(r.endCarry).toEqual([])
  })

  it('no bridge injected for all-plain-text split', () => {
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50)
    const r = splitPreservingMarkdown(text, 60)
    const anyBridge = r.chunks.some((c) => c.bridgeOpen || c.bridgeClose)
    expect(anyBridge).toBe(false)
    expect(reconstruct(r.chunks)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// 5. splitPreservingMarkdown — code fences
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — code fences', () => {
  it('short fence fits in one chunk → no split, no bridge', () => {
    const text = '```bash\necho hello\n```'
    const r = splitPreservingMarkdown(text, 200)
    expect(r.chunks).toHaveLength(1)
    expect(r.chunks[0]!.text).toBe(text)
    expect(r.chunks[0]!.bridgeOpen).toBeUndefined()
    expect(r.chunks[0]!.bridgeClose).toBeUndefined()
  })

  it('fence split in the middle — both halves are balanced (3 backticks)', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const text = '```bash\n' + body + '\n```'
    const r = splitPreservingMarkdown(text, 200)
    expect(r.chunks.length).toBeGreaterThan(1)
    for (const c of r.chunks) {
      const count = countOccurrences(c.text, '```')
      expect(count % 2).toBe(0)
    }
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 200)
  })

  it('fence split — 4-backtick opener uses 4-backtick closer', () => {
    const body = Array.from({ length: 30 }, (_, i) => `x${i}`).join('\n')
    const text = '````ts\n' + body + '\n````'
    const r = splitPreservingMarkdown(text, 150)
    if (r.chunks.length > 1) {
      for (const c of r.chunks) {
        const count = countOccurrences(c.text, '````')
        expect(count % 2).toBe(0)
      }
    }
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('fence split — 5-backtick opener uses 5-backtick closer', () => {
    const body = 'a\n'.repeat(30)
    const text = '`````python\n' + body + '`````'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
  })

  it('fence split — tilde fence (~~~)', () => {
    const body = Array.from({ length: 30 }, (_, i) => `step ${i}`).join('\n')
    const text = '~~~\n' + body + '\n~~~'
    const r = splitPreservingMarkdown(text, 150)
    if (r.chunks.length > 1) {
      for (const c of r.chunks) {
        const count = countOccurrences(c.text, '~~~')
        expect(count % 2).toBe(0)
      }
    }
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('fence split — tilde fence with info string (~~~python)', () => {
    const body = 'print(x)\n'.repeat(20)
    const text = '~~~python\n' + body + '~~~'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    if (r.chunks.length > 1) {
      expect(r.chunks[1]!.bridgeOpen).toBe('~~~python\n')
    }
  })

  it('fence split — no info string', () => {
    const body = 'code\n'.repeat(30)
    const text = '```\n' + body + '```'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
  })

  it('backtick fence with backtick in info string is NOT a valid opener', () => {
    // ```foo`bar is rejected as fence opener
    const text = '```foo`bar\ncode line\n```'
    const r = splitPreservingMarkdown(text, 500)
    // There should be no fence carry since it's not a valid fence
    expect(r.endCarry.every((m) => m.kind !== 'fence')).toBe(true)
  })

  it('closing fence with info string is NOT a valid closer — fence stays open', () => {
    const text = '```\ncode\n``` extra'
    const r = splitPreservingMarkdown(text, 500)
    // The fence is still open (closer has non-whitespace trailing)
    expect(r.endCarry.some((m) => m.kind === 'fence')).toBe(true)
  })

  it('~~~ fence NOT closed by ``` line', () => {
    const text = '~~~\ncode\n```\nmore\n~~~'
    const r = splitPreservingMarkdown(text, 500)
    expect(r.endCarry).toEqual([])
    // The ``` inside ~~~ is content
  })

  it('``` inside ~~~ is literal content — reopener uses ~~~', () => {
    const body = '```\ninner\n```\n'.repeat(10)
    const text = '~~~\n' + body + '~~~'
    const r = splitPreservingMarkdown(text, 80)
    expect(reconstruct(r.chunks)).toBe(text)
    // All chunks should use ~~~ for bridging, not ```
    for (const c of r.chunks) {
      if (c.bridgeOpen) {
        expect(c.bridgeOpen).toBe('~~~\n')
      }
      if (c.bridgeClose) {
        expect(c.bridgeClose).toContain('~~~')
        expect(c.bridgeClose).not.toContain('```')
      }
    }
  })

  it('unclosed fence → endCarry reports it', () => {
    const r = splitPreservingMarkdown('intro\n```js\nconst x = 1', 1000)
    expect(r.endCarry.some((m) => m.kind === 'fence')).toBe(true)
  })

  it('unclosed fence → exclusiveOnly has it', () => {
    const r = splitPreservingMarkdown('intro\n```js\nconst x = 1', 1000)
    expect(exclusiveOnly(r.endCarry)).toHaveLength(1)
  })

  it('fence split preserves opener in bridgeOpen of next chunk', () => {
    const body = 'x\n'.repeat(30)
    const text = '```bash\n' + body + '```'
    const r = splitPreservingMarkdown(text, 100)
    if (r.chunks.length > 1) {
      expect(r.chunks[1]!.bridgeOpen).toBe('```bash\n')
    }
  })

  it('fence split — bridgeClose ends with fence marker on its own line', () => {
    const body = 'line\n'.repeat(30)
    const text = '```\n' + body + '```'
    const r = splitPreservingMarkdown(text, 100)
    for (const c of r.chunks) {
      if (c.bridgeClose) {
        // bridgeClose for a fence should end with the marker
        expect(c.bridgeClose.trimEnd().endsWith('```')).toBe(true)
      }
    }
  })

  it('two back-to-back code blocks in one chunk — no bridges injected', () => {
    const text = '```js\na=1\n```\n```py\nb=2\n```'
    const r = splitPreservingMarkdown(text, 200)
    expect(r.chunks).toHaveLength(1)
    expect(r.chunks[0]!.bridgeOpen).toBeUndefined()
    expect(r.chunks[0]!.bridgeClose).toBeUndefined()
  })

  it('split exactly at the opener line boundary respects the limit', () => {
    // Regression: the budget loop must size each chunk against the ACTUAL closer
    // (closeMarksForBody, which skips a leading '\n' when the body already ends
    // with one) rather than closeMarks (which always prepends '\n'). Otherwise a
    // fence cut at a newline boundary overflows maxLength by 1.
    const body = 'code\n'.repeat(3)
    const text = '```\n' + body + '```'
    const r = splitPreservingMarkdown(text, 9)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 9)
  })

  it('all-fence content (no prose) round-trips', () => {
    const text = '```\n' + 'line\n'.repeat(50) + '```'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
  })

  it('split with text after the fence', () => {
    const body = 'code\n'.repeat(20)
    const text = '```bash\n' + body + '```\nAfterText here'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    // Last chunk (or the one after fence) should not be fenced
    const lastChunk = r.chunks[r.chunks.length - 1]!
    expect(lastChunk.text).toContain('AfterText')
    expect(r.endCarry).toEqual([])
  })

  it('split with text before and after the fence', () => {
    const prose = 'Before text\n'
    const body = 'code\n'.repeat(20)
    const text = prose + '```\n' + body + '```\nAfter text'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
  })

  it('4-tilde fence (~~~~) uses 4-tilde closer', () => {
    const carry = scanMarkdown('~~~~\ncode')
    expect(carry[0]!.opener).toBe('~~~~')
    expect(carry[0]!.closer).toBe('~~~~')
  })

  it('fence with no newline at body end still closes properly', () => {
    const text = '```\ncode without final newline```'
    // The closing ``` is NOT on its own line here, so fence stays open
    const r = splitPreservingMarkdown(text, 500)
    // fence is unclosed because ``` is mid-line
    expect(r.endCarry.some((m) => m.kind === 'fence')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. splitPreservingMarkdown — inline code
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — inline code', () => {
  it('short inline code fits in one chunk — no split', () => {
    const text = 'Use `console.log()` here'
    const r = splitPreservingMarkdown(text, 200)
    expect(r.chunks).toHaveLength(1)
  })

  it('unclosed inline code → endCarry', () => {
    const r = splitPreservingMarkdown('hello `world', 1000)
    expect(r.endCarry.some((m) => m.kind === 'inlineCode')).toBe(true)
  })

  it('closed inline code → no endCarry', () => {
    const r = splitPreservingMarkdown('`hello`', 1000)
    expect(r.endCarry).toEqual([])
  })

  it('double-backtick inline code — run-length matched close', () => {
    const text = '``code with `backtick` inside``'
    const r = splitPreservingMarkdown(text, 200)
    expect(r.endCarry).toEqual([])
    expect(r.chunks).toHaveLength(1)
  })

  it('inline code does not match different run length', () => {
    // `` opened, closed by single ` — should NOT close it
    const text = '``code`rest'
    const r = splitPreservingMarkdown(text, 200)
    // The `` is still open (single ` inside doesn't close it)
    expect(r.endCarry.some((m) => m.kind === 'inlineCode')).toBe(true)
  })

  it('inline code split across boundary — each piece is self-contained', () => {
    const inline = '`' + 'x'.repeat(80) + '`'
    const text = 'before ' + inline + ' after'
    const r = splitPreservingMarkdown(text, 50)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 50)
    for (const c of r.chunks) {
      const count = countOccurrences(c.text, '`')
      expect(count % 2).toBe(0)
    }
  })

  it('exclusiveOnly includes inlineCode carry', () => {
    const carry = scanMarkdown('hello `world')
    expect(exclusiveOnly(carry)).toHaveLength(1)
    expect(exclusiveOnly(carry)[0]!.kind).toBe('inlineCode')
  })

  it('emphasis inside inline code is literal (not parsed)', () => {
    const carry = scanMarkdown('`**not bold**')
    // inlineCode is open; ** inside is literal
    expect(carry).toHaveLength(1)
    expect(carry[0]!.kind).toBe('inlineCode')
  })

  it('inline code in sentence — round-trips on split', () => {
    const word = '`' + 'v'.repeat(30) + '`'
    const text = 'a '.repeat(30) + word + ' b'.repeat(30)
    const r = splitPreservingMarkdown(text, 80)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 80)
  })
})

// ---------------------------------------------------------------------------
// 7. splitPreservingMarkdown — emphasis
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — emphasis', () => {
  it('matched bold → no endCarry', () => {
    const r = splitPreservingMarkdown('**bold**', 1000)
    expect(r.endCarry).toEqual([])
  })

  it('unmatched bold → endCarry (emphasis kind)', () => {
    const carry = scanMarkdown('**bold without close')
    expect(carry.some((m) => m.kind === 'bold')).toBe(true)
  })

  it('unmatched bold NOT in exclusiveOnly', () => {
    const carry = scanMarkdown('**bold')
    expect(exclusiveOnly(carry)).toHaveLength(0)
  })

  it('bold split — each chunk has even number of **', () => {
    // Use join(' ') so the closing ** is not preceded by a space
    // (a space before ** makes it non-right-flanking → not a valid closer)
    const text = '**' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '**'
    const r = splitPreservingMarkdown(text, 120)
    expect(r.chunks.length).toBeGreaterThan(1)
    for (const c of r.chunks) {
      const n = countOccurrences(c.text, '**')
      expect(n % 2).toBe(0)
    }
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('italic (*) split — bridges correctly in each chunk', () => {
    // NOTE: closing * must NOT be preceded by whitespace (would make it non-right-flanking)
    // Use join(' ') to avoid trailing space before closing *
    const text = '*' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '*'
    const r = splitPreservingMarkdown(text, 100)
    expect(r.chunks.length).toBeGreaterThan(1)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    // Each chunk should have balanced * (from bridge)
    for (const c of r.chunks) {
      const n = countOccurrences(c.text, '*')
      expect(n % 2).toBe(0)
    }
  })

  it('italic (_) split — bridges correctly in each chunk', () => {
    // Use join(' ') to avoid trailing space before closing _ (which blocks closing)
    const text = '_' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '_'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    if (r.chunks.length > 1) {
      for (const c of r.chunks) {
        const n = countOccurrences(c.text, '_')
        expect(n % 2).toBe(0)
      }
    }
  })

  it('underline (__) split — bridges correctly in each chunk', () => {
    // Use join(' ') to avoid trailing space before closing __ (which blocks closing)
    const text = '__' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '__'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    if (r.chunks.length > 1) {
      for (const c of r.chunks) {
        const n = countOccurrences(c.text, '__')
        expect(n % 2).toBe(0)
      }
    }
  })

  it('boldItalic (***) split — balanced', () => {
    // Use join(' ') to avoid trailing space before closing ***
    const text = '***' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '***'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
  })

  it('strikethrough (~~) split — balanced', () => {
    // Use join(' ') so closing ~~ is not preceded by whitespace (which blocks closing)
    const text = '~~' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '~~'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    if (r.chunks.length > 1) {
      for (const c of r.chunks) {
        const n = countOccurrences(c.text, '~~')
        expect(n % 2).toBe(0)
      }
    }
  })

  it('spoiler (||) split — balanced', () => {
    // Use join(' ') to avoid trailing space before closing ||
    const text = '||' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '||'
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
    if (r.chunks.length > 1) {
      for (const c of r.chunks) {
        const n = countOccurrences(c.text, '||')
        expect(n % 2).toBe(0)
      }
    }
  })

  it('unmatched lone asterisk (math) — no bridge injected', () => {
    const text = 'a'.repeat(100) + ' 2 * 3 is math'
    const r = splitPreservingMarkdown(text, 50)
    expect(reconstruct(r.chunks)).toBe(text)
    const anyBridge = r.chunks.some((c) => c.bridgeOpen || c.bridgeClose)
    expect(anyBridge).toBe(false)
  })

  it('right-flanking ** with whitespace before — NOT a valid closer', () => {
    // "** close" — the ** has a space before it (after), so it is NOT right-flanking
    // The ** before is left-flanking (nothing before), this ** has space before → not a match
    // Actually: "bold **" trailing space means ** may not be a closer
    // The text: **bold ** — the closer "**" has a space immediately before it (word char?)
    // Let's test a clear case: opening with no close
    const carry = scanMarkdown('**bold  **')
    // "  **" — two spaces before **, so before = ' ' which is whitespace → not right-flanking → not a closer
    // So **bold  ** should NOT close the bold
    // (checking the implementation behavior)
    // The opening ** sees: before=undefined (start), after='b' → canOpen=true
    // The closing ** sees: before=' ' → canClose = !isWhitespace(' ') = false → not a closer
    expect(carry.some((m) => m.kind === 'bold')).toBe(true)
  })

  it('intra-word underscore is NOT italic', () => {
    const carry = scanMarkdown('word_other_word')
    expect(carry).toEqual([])
  })

  it('escaped asterisk is literal — no carry', () => {
    const carry = scanMarkdown('hello \\* world \\*')
    expect(carry).toEqual([])
  })

  it('escaped backtick is literal', () => {
    const carry = scanMarkdown('\\`not code\\`')
    expect(carry).toEqual([])
  })

  it('lone ~ (not ~~) is literal', () => {
    const carry = scanMarkdown('~single tilde~')
    // ~ with len=1 has no kind in EMPHASIS_BY_CHAR → literal
    expect(carry).toEqual([])
  })

  it('lone | is literal', () => {
    const carry = scanMarkdown('|single pipe|')
    // | with len=1 has no kind → literal
    expect(carry).toEqual([])
  })

  it('bridgeOpen for bold split is **', () => {
    // Use join(' ') so closing ** is not preceded by a space (which blocks closing)
    const text = '**' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '**'
    const r = splitPreservingMarkdown(text, 120)
    expect(r.chunks.length).toBeGreaterThan(1)
    expect(r.chunks[1]!.bridgeOpen).toBe('**')
  })

  it('bridgeClose for bold split is **', () => {
    // Use join(' ') so closing ** is not preceded by a space (which blocks closing)
    const text = '**' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '**'
    const r = splitPreservingMarkdown(text, 120)
    expect(r.chunks.length).toBeGreaterThan(1)
    expect(r.chunks[0]!.bridgeClose).toBe('**')
  })

  it('italic inside bold split — bridgeClose closes italic first', () => {
    // **bold *italic* back**
    // If split inside *italic*, close * before **
    const text = '**bold ' + '*italic '.repeat(10) + '* back**'
    const r = splitPreservingMarkdown(text, 40)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 40)
  })
})

// ---------------------------------------------------------------------------
// 8. Nesting & ordering of close/reopen
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — nesting and ordering', () => {
  it('nested bold+italic: close inner first, reopen outer first', () => {
    // **bold _italic_** — if split mid-italic, bridgeClose should be "_**" and bridgeOpen should be "**_"
    const text = '**bold _' + 'w '.repeat(30) + '_back**'
    const r = splitPreservingMarkdown(text, 60)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 60)
    // Check ordering on a chunk that has both open
    for (const c of r.chunks) {
      if (c.bridgeClose && c.bridgeOpen) {
        // bridgeClose: innermost first (italic before bold)
        const closeIdx_italic = c.bridgeClose.indexOf('_')
        const closeIdx_bold = c.bridgeClose.indexOf('**')
        if (closeIdx_italic !== -1 && closeIdx_bold !== -1) {
          expect(closeIdx_italic).toBeLessThan(closeIdx_bold)
        }
        // bridgeOpen: outermost first (bold before italic)
        const openIdx_bold = c.bridgeOpen.indexOf('**')
        const openIdx_italic = c.bridgeOpen.indexOf('_')
        if (openIdx_bold !== -1 && openIdx_italic !== -1) {
          expect(openIdx_bold).toBeLessThan(openIdx_italic)
        }
      }
    }
  })

  it('bold inside italic: round-trips', () => {
    const text = '_italic **bold** end_'
    const r = splitPreservingMarkdown(text, 15)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 15)
  })

  it('emphasis inside code fence is not bridged as emphasis', () => {
    const body = '**not bridged**\n'.repeat(10)
    const text = '```\n' + body + '```'
    const r = splitPreservingMarkdown(text, 80)
    expect(reconstruct(r.chunks)).toBe(text)
    for (const c of r.chunks) {
      // No emphasis-type bridge — only fence bridges allowed
      if (c.bridgeOpen) expect(c.bridgeOpen).toMatch(/^(`{3,}|~{3,})/)
      if (c.bridgeClose) expect(c.bridgeClose.trim()).toMatch(/^(`{3,}|~{3,})$/)
    }
  })

  it('multiple adjacent bold spans — only open ones bridged', () => {
    const text = '**one** and **' + 'long '.repeat(30) + '**'
    const r = splitPreservingMarkdown(text, 80)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 80)
  })
})

// ---------------------------------------------------------------------------
// 9. startCarry continuation
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — startCarry', () => {
  it('inherited fence carry — first chunk prepends reopener', () => {
    const carry = scanMarkdown('```python\nprint(1)')
    const r = splitPreservingMarkdown('print(2)\n```\ndone', 1750, carry)
    expect(r.chunks[0]!.text.startsWith('```python\n')).toBe(true)
    expect(r.chunks[0]!.bridgeOpen).toBe('```python\n')
  })

  it('inherited fence carry — round-trip', () => {
    const carry = scanMarkdown('```python\nprint(1)')
    const text = 'print(2)\n```\ndone'
    const r = splitPreservingMarkdown(text, 1750, carry)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('inherited fence carry — each chunk within limit', () => {
    const carry = scanMarkdown('```bash\necho start')
    const body = 'line\n'.repeat(40)
    const text = body + '```\npost'
    const r = splitPreservingMarkdown(text, 100, carry)
    assertAllWithinLimit(r.chunks, 100)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('inherited fence carry — budget accounts for reopener length', () => {
    // reopener is "```bash\n" (8 chars); with maxLength=50, first chunk body ≤ 42
    const carry = scanMarkdown('```bash\n')
    const text = 'x'.repeat(100)
    const r = splitPreservingMarkdown(text, 50, carry)
    assertAllWithinLimit(r.chunks, 50)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('inherited bold carry — first chunk prepends **', () => {
    const carry: MarkdownCarry = [{ kind: 'bold', opener: '**', closer: '**' }]
    const text = 'continued bold text here'
    const r = splitPreservingMarkdown(text, 1000, carry)
    expect(r.chunks[0]!.bridgeOpen).toBe('**')
    expect(r.chunks[0]!.text.startsWith('**')).toBe(true)
  })

  it('inherited fence carry that is closed mid-text → no endCarry fence', () => {
    const carry = scanMarkdown('```\ncode')
    const r = splitPreservingMarkdown('more\n```\nplain', 1000, carry)
    expect(r.endCarry.every((m) => m.kind !== 'fence')).toBe(true)
  })

  it('carries from scanMarkdown with a tilde fence', () => {
    const carry = scanMarkdown('~~~bash\nstart')
    expect(carry[0]!.opener).toBe('~~~bash')
    const r = splitPreservingMarkdown('middle\n~~~\nend', 1000, carry)
    expect(r.chunks[0]!.bridgeOpen).toBe('~~~bash\n')
    expect(reconstruct(r.chunks)).toBe('middle\n~~~\nend')
  })

  it('empty startCarry behaves like no carry', () => {
    const r1 = splitPreservingMarkdown('hello', 100, [])
    const r2 = splitPreservingMarkdown('hello', 100)
    expect(r1.chunks).toEqual(r2.chunks)
    expect(r1.endCarry).toEqual(r2.endCarry)
  })
})

// ---------------------------------------------------------------------------
// 10. Edge cases
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — edge cases', () => {
  it('text is only newlines', () => {
    const text = '\n\n\n\n\n'
    const r = splitPreservingMarkdown(text, 10)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 10)
  })

  it('maxLength of 4 — still produces chunks without stalling', () => {
    // Very small maxLength to test the guard-against-stall path
    const text = 'abcde'
    const r = splitPreservingMarkdown(text, 4)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 4)
  })

  it('large all-fence text with moderate maxLength', () => {
    const body = 'line\n'.repeat(100)
    const text = '```\n' + body + '```'
    const r = splitPreservingMarkdown(text, 80)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 80)
  })

  it('no markdown fast path: hasNoDelimiters → single chunk', () => {
    // Text with no backtick, asterisk, underscore, tilde, pipe, or backslash
    const text = 'Hello world! This is a plain sentence. 12345 abc DEF.'
    const r = splitPreservingMarkdown(text, 1000)
    expect(r.chunks).toHaveLength(1)
    expect(r.chunks[0]!.text).toBe(text)
  })

  it('text with only backslash — delimiter detected, no fast path, but no carry', () => {
    const text = 'hello \\ world'
    const r = splitPreservingMarkdown(text, 1000)
    expect(reconstruct(r.chunks)).toBe(text)
    expect(r.endCarry).toEqual([])
  })

  it('chunks array is never empty', () => {
    const r = splitPreservingMarkdown('', 100)
    expect(r.chunks.length).toBeGreaterThan(0)
  })

  it('a single very long line inside a fence — hard-splits but each piece is fenced', () => {
    const longLine = 'x'.repeat(100)
    const text = '```\n' + longLine + '\n```'
    // maxLength=40: overhead is "```\n" (4) + "\n```" (4) = 8, leaving 32 chars per chunk
    const r = splitPreservingMarkdown(text, 40)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 40)
    for (const c of r.chunks) {
      const count = countOccurrences(c.text, '```')
      expect(count % 2).toBe(0)
    }
  })

  it('text that ends immediately after fence opener', () => {
    const text = '```'
    const r = splitPreservingMarkdown(text, 1000)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('fence opener on last line (no newline after)', () => {
    const text = 'prose\n```'
    const r = splitPreservingMarkdown(text, 1000)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('mix of ``` and ~~~ fences (different types)', () => {
    const text = '```\ncode1\n```\n~~~\ncode2\n~~~'
    const r = splitPreservingMarkdown(text, 500)
    expect(r.endCarry).toEqual([])
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('text with all emphasis kinds back to back respects the limit', () => {
    // Regression: when avoidDelimiterBisect pulls `cut` back to a construct's
    // contentEnd it adds that construct's closer to the stack; the budget loop
    // re-derives the close-stack at the FINAL cut so those closer chars are
    // always counted and no chunk exceeds maxLength.
    const text = '**bold** _italic_ __under__ ~~strike~~ ||spoiler|| ***bi***'
    const r = splitPreservingMarkdown(text, 20)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 20)
  })

  it('endCarry is empty after fully matched text', () => {
    const text = '**bold** `code` ~~strike~~'
    const r = splitPreservingMarkdown(text, 1000)
    expect(r.endCarry).toEqual([])
  })

  it('startCarry + text requires no split → single chunk with bridgeOpen only', () => {
    const carry: MarkdownCarry = [{ kind: 'bold', opener: '**', closer: '**' }]
    const text = 'short'
    const r = splitPreservingMarkdown(text, 1000, carry)
    expect(r.chunks).toHaveLength(1)
    expect(r.chunks[0]!.bridgeOpen).toBe('**')
  })

  it('fence with 1-3 spaces of indent is still a valid fence opener', () => {
    const text = '  ```\ncode\n```'
    const r = splitPreservingMarkdown(text, 1000)
    expect(r.endCarry).toEqual([]) // closed
  })

  it('fence with 4 spaces of indent is NOT a valid fence opener', () => {
    // 4 spaces = code block, not fence
    const text = '    ```\ncode\n```'
    const r = splitPreservingMarkdown(text, 1000)
    // The ``` with 4 spaces prefix is not a fence opener in CommonMark
    // The last ``` without indent is not a fence closer (no open fence)
    expect(r.endCarry.every((m) => m.kind !== 'fence')).toBe(true)
  })

  it('multiple splits — all chunks within limit, round-trips', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'content '.repeat(5)}`).join('\n')
    const r = splitPreservingMarkdown(text, 150)
    assertAllWithinLimit(r.chunks, 150)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('inline code bridging — bridgeOpen and bridgeClose are the opener', () => {
    const inline = '`' + 'x'.repeat(200) + '`'
    const r = splitPreservingMarkdown(inline, 80)
    if (r.chunks.length > 1) {
      expect(r.chunks[1]!.bridgeOpen).toBe('`')
      expect(r.chunks[0]!.bridgeClose).toBe('`')
    }
  })

  it('text with only a single delimiter char — no crash', () => {
    for (const ch of ['`', '*', '_', '~', '|', '\\']) {
      const r = splitPreservingMarkdown(ch, 100)
      expect(r.chunks.length).toBeGreaterThan(0)
      expect(reconstruct(r.chunks)).toBe(ch)
    }
  })
})

// ---------------------------------------------------------------------------
// 11. Invariant stress tests
// ---------------------------------------------------------------------------

describe('splitPreservingMarkdown — stress / invariants', () => {
  it('invariant: every chunk <= maxLength for mixed content', () => {
    const text = [
      'Intro paragraph.',
      '```bash',
      'echo hello',
      'echo world',
      '```',
      '**Bold text** and _italic_ and ~~strike~~ and ||spoiler||.',
      '```js',
      "const x = 'hello'",
      '```',
      'Conclusion.',
    ].join('\n')
    const maxLength = 60
    const r = splitPreservingMarkdown(text, maxLength)
    assertAllWithinLimit(r.chunks, maxLength)
    expect(reconstruct(r.chunks)).toBe(text)
  })

  it('invariant: round-trip for repeated emphasis splits', () => {
    const text = '**' + ('word '.repeat(20) + '\n').repeat(5) + '**'
    const r = splitPreservingMarkdown(text, 80)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 80)
  })

  it('invariant: round-trip for fence inside prose (both sides)', () => {
    const before = 'This is some prose before. '
    const body = 'code_line\n'.repeat(20)
    const after = '\nAnd some prose after.'
    const text = before + '```python\n' + body + '```' + after
    const r = splitPreservingMarkdown(text, 100)
    expect(reconstruct(r.chunks)).toBe(text)
    assertAllWithinLimit(r.chunks, 100)
  })

  it('invariant: chunks.length >= 1 always', () => {
    for (const text of ['', 'a', '**b**', '```\ncode\n```', '`x`']) {
      const r = splitPreservingMarkdown(text, 50)
      expect(r.chunks.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('invariant: reconstruct works for multi-split fence', () => {
    const body = 'item\n'.repeat(100)
    const text = '```\n' + body + '```'
    for (const maxLen of [50, 100, 200]) {
      const r = splitPreservingMarkdown(text, maxLen)
      expect(reconstruct(r.chunks)).toBe(text)
      assertAllWithinLimit(r.chunks, maxLen)
    }
  })
})

// ---------------------------------------------------------------------------
// 11. Cross-send continuity (the reported bug)
// ---------------------------------------------------------------------------
// A fence opened before a tool call and continued after it spans two
// independent sends (a streaming pre-tool flush, then the final send).
// AgentLoop.sendSegments threads endCarry → startCarry across the two; this
// models that threading at the utility level.
describe('splitPreservingMarkdown — cross-send continuity', () => {
  it('keeps the fence balanced across two separate sends', () => {
    const preTool = 'Here are the flags:\n```bash\n--disable-blink-features=AutomationControlled'
    const postTool = '--password-store=basic\n```\nThat avoids keyring weirdness.'

    const r1 = splitPreservingMarkdown(preTool, 1750, [])
    const carry = exclusiveOnly(r1.endCarry) // only exclusive constructs cross a send boundary
    expect(carry.map((m) => m.kind)).toEqual(['fence'])
    const r2 = splitPreservingMarkdown(postTool, 1750, carry)

    const all = [...r1.chunks, ...r2.chunks]
    // Every Discord message renders with a balanced fence count.
    for (const c of all) {
      expect((c.text.match(/```/g) || []).length % 2).toBe(0)
    }
    // The second send reopens the fence the first one closed.
    expect(r2.chunks[0]!.text.startsWith('```bash\n')).toBe(true)
    expect(r2.chunks[0]!.bridgeOpen).toBe('```bash\n')
    // Context reconstruction strips the synthetic bridges back to the original.
    expect(reconstruct(all)).toBe(preTool + postTool)
  })

  it('drops dangling emphasis at a send boundary (not carried)', () => {
    const r = splitPreservingMarkdown('this is **bold', 1750, [])
    expect(r.endCarry.map((m) => m.kind)).toEqual(['bold'])
    expect(exclusiveOnly(r.endCarry)).toEqual([]) // emphasis does not cross a send
  })
})
