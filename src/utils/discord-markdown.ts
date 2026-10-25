/**
 * Discord parses each message independently, so a markdown construct that
 * straddles a message boundary breaks (a half-open code fence corrupts
 * everything after it).
 */

export interface OpenMark {
  kind:
    | 'fence'
    | 'inlineCode'
    | 'bold'
    | 'italic'
    | 'boldItalic'
    | 'underline'
    | 'strike'
    | 'spoiler'
  opener: string
  closer: string
}

export type MarkdownCarry = OpenMark[]

export interface ChunkPiece {
  text: string
  bridgeOpen?: string
  bridgeClose?: string
}

const DELIM_CHARS = new Set(['`', '*', '_', '~', '|', '\\'])

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch)
}

function hasNoDelimiters(text: string): boolean {
  for (const ch of text) {
    if (DELIM_CHARS.has(ch)) return false
  }
  return true
}

interface Construct {
  kind: OpenMark['kind']
  opener: string
  closer: string
  openStart: number
  contentStart: number
  contentEnd: number
  closeEnd: number
}

interface ParseResult {
  constructs: Construct[]
  endStack: OpenMark[]
}

const EMPHASIS_BY_CHAR: Record<string, Record<number, OpenMark['kind']>> = {
  '*': { 1: 'italic', 2: 'bold', 3: 'boldItalic' },
  '_': { 1: 'italic', 2: 'underline' },
  '~': { 2: 'strike' },
  '|': { 2: 'spoiler' },
}

interface PendingEmphasis {
  char: string
  len: number
  start: number
  end: number
  canOpen: boolean
  canClose: boolean
  kind: OpenMark['kind']
}

function parse(text: string, startCarry: MarkdownCarry = []): ParseResult {
  const constructs: Construct[] = []

  const inherited = startCarry.length > 0 ? startCarry[startCarry.length - 1]! : undefined
  const inheritedIsExclusive =
    inherited !== undefined && (inherited.kind === 'fence' || inherited.kind === 'inlineCode')

  const inheritedConstructs: Construct[] = startCarry.map((m) => ({
    kind: m.kind,
    opener: m.opener,
    closer: m.closer,
    openStart: -1,
    contentStart: 0,
    contentEnd: text.length,
    closeEnd: text.length,
  }))

  const lines = splitLinesWithIndex(text)

  const emphasisStack: PendingEmphasis[] = []

  let exclusive:
    | { kind: 'fence'; char: string; runLen: number; opener: string; openStart: number; contentStart: number }
    | { kind: 'inlineCode'; runLen: number; opener: string; openStart: number; contentStart: number }
    | undefined

  if (inheritedIsExclusive && inherited) {
    if (inherited.kind === 'fence') {
      const { char, runLen } = parseFenceMarker(inherited.opener)
      exclusive = {
        kind: 'fence',
        char,
        runLen,
        opener: inherited.opener,
        openStart: -1,
        contentStart: 0,
      }
    } else {
      const runLen = inherited.opener.length
      exclusive = { kind: 'inlineCode', runLen, opener: inherited.opener, openStart: -1, contentStart: 0 }
    }
  }

  for (const line of lines) {
    const lineText = line.text
    const lineStart = line.start

    if (exclusive && exclusive.kind === 'fence') {
      const fenceClose = matchFenceClose(lineText, exclusive.char, exclusive.runLen)
      if (fenceClose) {
        const contentEnd = lineStart + fenceClose.markerOffset
        const closeEnd = lineStart + lineText.length
        recordExclusive(exclusive, contentEnd, closeEnd)
        exclusive = undefined
      }
      continue
    }

    let i = 0
    while (i < lineText.length) {
      const absIdx = lineStart + i
      const ch = lineText[i]!

      if (ch === '\\' && !exclusive) {
        i += 2
        continue
      }

      if (exclusive && exclusive.kind === 'inlineCode') {
        if (ch === '`') {
          const run = backtickRunLength(lineText, i)
          if (run === exclusive.runLen) {
            const contentEnd = absIdx
            const closeEnd = absIdx + run
            recordExclusive(exclusive, contentEnd, closeEnd)
            exclusive = undefined
            i += run
            continue
          }
          i += run
          continue
        }
        i += 1
        continue
      }

      if (ch === '`' || ch === '~') {
        if (i === 0) {
          const fence = tryFenceOpen(lineText)
          if (fence) {
            exclusive = {
              kind: 'fence',
              char: fence.char,
              runLen: fence.runLen,
              opener: fence.opener,
              openStart: absIdx,
              contentStart: lineStart + lineText.length,
            }
            i = lineText.length
            continue
          }
        }
        if (i <= 3 && lineText.slice(0, i).trim() === '') {
          const fence = tryFenceOpen(lineText.slice(i))
          if (fence) {
            exclusive = {
              kind: 'fence',
              char: fence.char,
              runLen: fence.runLen,
              opener: fence.opener,
              openStart: absIdx,
              contentStart: lineStart + lineText.length,
            }
            i = lineText.length
            continue
          }
        }
      }

      if (ch === '`') {
        const run = backtickRunLength(lineText, i)
        exclusive = {
          kind: 'inlineCode',
          runLen: run,
          opener: '`'.repeat(run),
          openStart: absIdx,
          contentStart: absIdx + run,
        }
        i += run
        continue
      }

      if (ch === '*' || ch === '_' || ch === '~' || ch === '|') {
        const run = runLength(lineText, i, ch)
        const handled = handleEmphasisRun(
          text,
          absIdx,
          run,
          ch,
          emphasisStack,
          constructs,
        )
        i += handled
        continue
      }

      i += 1
    }
  }

  const endStack: OpenMark[] = []

  for (const ic of inheritedConstructs) {
    if (ic.kind !== 'fence' && ic.kind !== 'inlineCode') {
      constructs.push(ic)
      endStack.push({ kind: ic.kind, opener: ic.opener, closer: ic.closer })
    }
  }

  if (exclusive) {
    constructs.push({
      kind: exclusive.kind,
      opener: exclusive.opener,
      closer: exclusive.kind === 'fence' ? fenceCloserFor(exclusive.opener) : exclusive.opener,
      openStart: exclusive.openStart,
      contentStart: exclusive.contentStart,
      contentEnd: text.length,
      closeEnd: text.length,
    })
    endStack.push({
      kind: exclusive.kind,
      opener: exclusive.opener,
      closer: exclusive.kind === 'fence' ? fenceCloserFor(exclusive.opener) : exclusive.opener,
    })
  }

  for (const pend of emphasisStack) {
    endStack.push({
      kind: pend.kind,
      opener: pend.char.repeat(pend.len),
      closer: pend.char.repeat(pend.len),
    })
  }

  return { constructs, endStack }

  function recordExclusive(
    ex: NonNullable<typeof exclusive>,
    contentEnd: number,
    closeEnd: number,
  ): void {
    constructs.push({
      kind: ex.kind,
      opener: ex.opener,
      closer: ex.kind === 'fence' ? fenceCloserFor(ex.opener) : ex.opener,
      openStart: ex.openStart,
      contentStart: ex.contentStart,
      contentEnd,
      closeEnd,
    })
  }
}

function handleEmphasisRun(
  text: string,
  start: number,
  len: number,
  char: string,
  stack: PendingEmphasis[],
  constructs: Construct[],
): number {
  const before = start > 0 ? text[start - 1] : undefined
  const after = start + len < text.length ? text[start + len] : undefined

  let canOpen = !isWhitespace(after)
  let canClose = !isWhitespace(before)
  if (char === '_') {
    // Underscore emphasis does not work intra-word.
    canOpen = canOpen && !isWordChar(before)
    canClose = canClose && !isWordChar(after)
  }

  const kind = EMPHASIS_BY_CHAR[char]?.[len]
  if (!kind) {
    return len
  }

  if (canClose) {
    for (let s = stack.length - 1; s >= 0; s--) {
      const open = stack[s]!
      if (open.char === char && open.len === len && open.canOpen) {
        constructs.push({
          kind,
          opener: char.repeat(len),
          closer: char.repeat(len),
          openStart: open.start,
          contentStart: open.end,
          contentEnd: start,
          closeEnd: start + len,
        })
        stack.length = s
        return len
      }
    }
  }

  if (canOpen) {
    stack.push({ char, len, start, end: start + len, canOpen, canClose, kind })
  }
  return len
}

interface LineWithIndex {
  text: string
  start: number
}

function splitLinesWithIndex(text: string): LineWithIndex[] {
  const lines: LineWithIndex[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ text: text.slice(start, i), start })
      start = i + 1
    }
  }
  return lines
}

function runLength(line: string, i: number, ch: string): number {
  let n = 0
  while (i + n < line.length && line[i + n] === ch) n++
  return n
}

function backtickRunLength(line: string, i: number): number {
  return runLength(line, i, '`')
}

function tryFenceOpen(line: string): { char: string; runLen: number; opener: string } | undefined {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return undefined
  const marker = m[1]!
  const info = m[2]!
  const char = marker[0]!
  // Backtick fences may not have a backtick in the info string.
  if (char === '`' && info.includes('`')) return undefined
  return { char, runLen: marker.length, opener: marker + info.trimEnd() }
}

function matchFenceClose(
  line: string,
  char: string,
  openRunLen: number,
): { markerOffset: number } | undefined {
  const m = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line)
  if (!m) return undefined
  const indent = m[1]!
  const marker = m[2]!
  if (marker[0] !== char) return undefined
  if (marker.length < openRunLen) return undefined
  return { markerOffset: indent.length }
}

function parseFenceMarker(opener: string): { char: string; runLen: number } {
  const m = /^(`{3,}|~{3,})/.exec(opener)
  if (!m) return { char: '`', runLen: 3 }
  return { char: m[1]![0]!, runLen: m[1]!.length }
}

function fenceCloserFor(opener: string): string {
  const { char, runLen } = parseFenceMarker(opener)
  return char.repeat(runLen)
}

export function closeMarks(stack: MarkdownCarry): string {
  let out = ''
  for (let i = stack.length - 1; i >= 0; i--) {
    const mark = stack[i]!
    if (mark.kind === 'fence') {
      out += (out.endsWith('\n') ? '' : '\n') + mark.closer
    } else {
      out += mark.closer
    }
  }
  return out
}

/** Discord only consumes the first token of a fence's info string, for syntax highlighting. */
function fenceReopener(opener: string, infoBudget = Infinity): string {
  const { char, runLen } = parseFenceMarker(opener)
  const marker = char.repeat(runLen)
  const info = opener.slice(marker.length)
  const firstWord = info.trimStart().split(/\s/)[0] ?? ''
  const budget = Math.max(0, infoBudget)
  return marker + (firstWord.length > budget ? firstWord.slice(0, budget) : firstWord)
}

export function reopenMarks(stack: MarkdownCarry): string {
  let out = ''
  for (const mark of stack) {
    if (mark.kind === 'fence') {
      out += fenceReopener(mark.opener) + '\n'
    } else {
      out += mark.opener
    }
  }
  return out
}

export function exclusiveOnly(stack: MarkdownCarry): MarkdownCarry {
  return stack.filter((m) => m.kind === 'fence' || m.kind === 'inlineCode')
}

export function scanMarkdown(text: string, start: MarkdownCarry = []): MarkdownCarry {
  return parse(text, start).endStack
}

/** A code block as Discord reads one: each ``` opens a block that the next
 *  ``` ends, anywhere in a line, or that runs to the end of the text if
 *  nothing ends it. A backtick after an odd run of backslashes is escaped and
 *  opens nothing, though the backticks after it can. */
const DISCORD_BLOCK = /(?<=(?:^|[^\\])(?:\\\\)*)```[\s\S]*?(?:```|$)/g

/** Code as Discord reads it, from left to right. Each ``` opens a block that
 *  the next ``` ends, anywhere in a line, or that runs to the end of the text
 *  if nothing ends it. Outside a block, backticks open a span by Discord's
 *  inline code rule: an opening run, or when nothing ends the whole run, its
 *  first backticks, ended by the next run of exactly as many after some other
 *  character, across lines too. A backtick after an odd run of backslashes is
 *  escaped and opens nothing, though the backticks after it can. Discord has
 *  no `~~~` blocks, so a span can open inside one the splitter reads. */
const DISCORD_CODE = /(?<=(?:^|[^\\])(?:\\\\)*)(?:```[\s\S]*?(?:```|$)|(`+)[\s\S]*?[^`]\1(?!`))/g

export function codeRanges(text: string, start: MarkdownCarry = []): Array<[number, number]> {
  const reopener = reopenMarks(exclusiveOnly(start))
  const sent = reopener + text
  const ranges: Array<[number, number]> = []
  const add = (from: number, to: number): void => {
    const range: [number, number] = [Math.max(from, 0), to]
    if (range[1] > range[0]) ranges.push(range)
  }
  for (const construct of parse(text, exclusiveOnly(start)).constructs) {
    if (construct.kind === 'fence' || construct.kind === 'inlineCode') add(construct.openStart, construct.closeEnd)
  }
  for (const construct of parse(sent).constructs) {
    if (construct.kind === 'fence' || construct.kind === 'inlineCode') {
      add(construct.openStart - reopener.length, construct.closeEnd - reopener.length)
    }
  }
  for (const pattern of [DISCORD_CODE, DISCORD_BLOCK]) {
    for (const code of sent.matchAll(pattern)) {
      add(code.index - reopener.length, code.index + code[0].length - reopener.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const joined: Array<[number, number]> = []
  for (const range of ranges) {
    const last = joined[joined.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else joined.push([...range])
  }
  return joined
}

export function splitPreservingMarkdown(
  text: string,
  maxLength: number,
  startCarry: MarkdownCarry = [],
): { chunks: ChunkPiece[]; endCarry: MarkdownCarry } {
  if (startCarry.length === 0 && text.length <= maxLength && hasNoDelimiters(text)) {
    return { chunks: [{ text }], endCarry: [] }
  }

  const { constructs, endStack } = parse(text, startCarry)

  const bridgeable = constructs

  const markup = new Uint8Array(text.length)
  for (const c of bridgeable) {
    if (c.openStart >= 0) markup.fill(1, c.openStart, c.contentStart)
    markup.fill(1, c.contentEnd, c.closeEnd)
  }
  const isContent = (i: number): boolean => markup[i] === 0 && !/\s/.test(text[i]!)
  let lastContentEnd = text.length
  while (lastContentEnd > 0 && !isContent(lastContentEnd - 1)) lastContentEnd--

  const stackAt = (pos: number): OpenMark[] => {
    return bridgeable
      .filter((c) => c.contentStart <= pos && pos <= c.contentEnd)
      .sort((a, b) => a.openStart - b.openStart)
      .map((c) => ({ kind: c.kind, opener: c.opener, closer: c.closer }))
  }

  const chunks: ChunkPiece[] = []
  let chunkStart = 0
  let inherited: OpenMark[] = startCarry.slice()
  let firstContent = 0

  const reopenerFor = (stack: OpenMark[]): string => {
    let out = ''
    for (const mark of stack) {
      if (mark.kind === 'fence') {
        const { runLen } = parseFenceMarker(mark.opener)
        const reopenerNewline = 1
        const closerLength = runLen + 1
        const oneBodyChar = 1
        const infoBudget = maxLength - runLen - reopenerNewline - closerLength - oneBodyChar
        out += fenceReopener(mark.opener, infoBudget) + '\n'
      } else {
        out += mark.opener
      }
    }
    return out
  }

  const pushChunk = (endPos: number, closeStack: OpenMark[], bridgeOpen: string): void => {
    const body = text.slice(chunkStart, endPos)
    const bridgeClose = closeStack.length ? closeMarksForBody(body, closeStack) : ''
    chunks.push({
      text: bridgeOpen + body + bridgeClose,
      ...(bridgeOpen ? { bridgeOpen } : {}),
      ...(bridgeClose ? { bridgeClose } : {}),
    })
    chunkStart = endPos
    inherited = closeStack
  }

  const isRunChar = (ch: string | undefined): boolean =>
    ch === '`' || ch === '~' || ch === '*' || ch === '_' || ch === '|'

  const straddlesNonFence = (pos: number): boolean =>
    bridgeable.some((c) => c.kind !== 'fence' && c.contentStart <= pos && pos <= c.contentEnd)

  const seamMerges = (cut: number, closeStack: OpenMark[], isLast: boolean): boolean => {
    const body = text.slice(chunkStart, cut)
    if (body.length === 0) return false
    const closer = closeStack.length ? closeMarksForBody(body, closeStack) : ''
    if (closer && isRunChar(closer[0]) && closer[0] === body[body.length - 1]) return true
    if (isLast) return false
    const reopener = reopenerFor(closeStack)
    if (
      reopener &&
      isRunChar(reopener[reopener.length - 1]) &&
      reopener[reopener.length - 1] === text[cut]
    )
      return true
    return false
  }

  while (chunkStart < text.length) {
    const reopen = inherited.length ? reopenerFor(inherited) : ''
    const reopenLen = reopen.length

    let end = Math.min(text.length, chunkStart + Math.max(1, maxLength - reopenLen))
    if (firstContent < chunkStart) firstContent = chunkStart
    while (firstContent < text.length && !isContent(firstContent)) firstContent++
    let cut = -1
    let closeStack: OpenMark[] = []
    for (let guard = 0; guard < 64; guard++) {
      if (end < text.length && end >= lastContentEnd && firstContent < lastContentEnd - 1) {
        end = lastContentEnd - 1
      }
      if (end >= text.length) {
        cut = text.length
        closeStack = exclusiveOnly(stackAt(text.length))
      } else {
        const body = text.slice(chunkStart, end)
        let nlCut = -1
        for (let nl = body.lastIndexOf('\n'); nl >= 0; nl = nl > 0 ? body.lastIndexOf('\n', nl - 1) : -1) {
          const candidate = chunkStart + nl + 1
          if (candidate <= firstContent) break
          if (!straddlesNonFence(candidate)) {
            nlCut = candidate
            break
          }
        }
        if (nlCut >= 0) {
          cut = nlCut
        } else {
          cut = avoidDelimiterBisect(end, bridgeable, chunkStart)
          if (cut <= chunkStart) cut = end
        }
        closeStack = stackAt(cut)
      }

      const bodyLen = cut - chunkStart
      const closeLen = closeMarksForBody(text.slice(chunkStart, cut), closeStack).length
      if (reopenLen + bodyLen + closeLen <= maxLength || cut <= chunkStart + 1) break
      end = cut - 1
      if (end <= chunkStart) end = chunkStart + 1
    }

    if (cut < 0) cut = chunkStart + 1
    let isLast = cut >= text.length

    if (isLast && closeStack.length && seamMerges(cut, closeStack, true)) {
      closeStack = []
    }

    if (!isLast) {
      let guard = 0
      while (cut > chunkStart + 1 && (seamMerges(cut, closeStack, isLast) || splitsEscape(text, chunkStart, cut, closeStack)) && guard++ <= text.length) {
        let next = avoidDelimiterBisect(cut - 1, bridgeable, chunkStart)
        if (next <= chunkStart) next = cut - 1
        cut = next
        isLast = cut >= text.length
        closeStack = isLast ? exclusiveOnly(stackAt(text.length)) : stackAt(cut)
      }
    }

    pushChunk(cut, closeStack, reopen)
    if (isLast) break
  }

  if (chunks.length === 0) chunks.push({ text })

  return { chunks, endCarry: endStack }
}

function closeMarksForBody(body: string, stack: MarkdownCarry): string {
  let out = ''
  for (let i = stack.length - 1; i >= 0; i--) {
    const mark = stack[i]!
    if (mark.kind === 'fence') {
      const needsNl = !(out.length ? out.endsWith('\n') : body.endsWith('\n'))
      out += (needsNl ? '\n' : '') + mark.closer
    } else {
      out += mark.closer
    }
  }
  return out
}

/**
 * Discord's markdown escapes anything but an ASCII letter, a digit or
 * whitespace. Inside a ``` block or a code span a backslash is literal; a
 * `~~~` block is prose to Discord, so a backslash there can escape.
 */
function splitsEscape(text: string, chunkStart: number, pos: number, closeStack: MarkdownCarry): boolean {
  const code = (mark: OpenMark): boolean =>
    mark.kind === 'inlineCode' || (mark.kind === 'fence' && mark.opener.startsWith('`'))
  if (closeStack.some(code)) return false
  let run = 0
  while (run < pos && text[pos - 1 - run] === '\\') run++
  if (run % 2 === 0) return false
  const escaped = (ch: string | undefined): boolean => ch !== undefined && !/[0-9A-Za-z\s]/.test(ch)
  return escaped(text[pos]) || escaped(closeMarksForBody(text.slice(chunkStart, pos), closeStack)[0])
}

function avoidDelimiterBisect(pos: number, constructs: Construct[], floor: number): number {
  for (const c of constructs) {
    if (pos > c.openStart && pos < c.contentStart && c.openStart >= floor) return c.openStart
    if (pos > c.contentEnd && pos < c.closeEnd && c.contentEnd >= floor) return c.contentEnd
  }
  return pos
}
