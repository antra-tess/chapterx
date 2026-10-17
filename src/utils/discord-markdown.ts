/**
 * Discord-markdown fence/emphasis balancer.
 *
 * Discord parses each message independently, so a markdown construct that
 * straddles a message boundary breaks (a half-open code fence corrupts
 * everything after it). This splits text so any construct open at a chunk
 * boundary is closed at the chunk end and reopened at the next, and reports the
 * open-construct stack so continuity can be threaded across separate sends.
 *
 * Scope: code fences (``` / ~~~), inline code, emphasis (*, **, ***, _, __, ~~,
 * ||). Pure and dependency-free.
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
  /** Verbatim opener, e.g. "```bash", "~~~", "``", "**". */
  opener: string
  /** Closer to emit. Fence: marker run only (no info string), on its own line. */
  closer: string
}

/**
 * The open-construct stack at a boundary. Index 0 is the OUTERMOST construct.
 * A `fence` or `inlineCode` is exclusive — when one is open, no inline parsing
 * happens inside it, so it is always the sole entry on the stack.
 */
export type MarkdownCarry = OpenMark[]

/** A ready-to-send chunk plus the exact synthetic strings injected into it. */
export interface ChunkPiece {
  /** Text to send (inherited reopener prepended, synthetic closer appended). */
  text: string
  /** Synthetic reopener prepended to `text` (for later precise stripping). */
  bridgeOpen?: string
  /** Synthetic closer appended to `text` (for later precise stripping). */
  bridgeClose?: string
}

const DELIM_CHARS = new Set(['`', '*', '_', '~', '|', '\\'])

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch)
}

/** True if the text contains no markdown delimiter characters at all. */
function hasNoDelimiters(text: string): boolean {
  for (const ch of text) {
    if (DELIM_CHARS.has(ch)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Construct {
  kind: OpenMark['kind']
  opener: string
  closer: string
  /** Index of the first opener char (−1 for an inherited startCarry construct). */
  openStart: number
  /** Index just past the opener (content start). 0 for inherited carry. */
  contentStart: number
  /** Index of the first closer char (= content end). text.length if unclosed. */
  contentEnd: number
  /** Index just past the closer. text.length if unclosed. */
  closeEnd: number
}

interface ParseResult {
  /** Matched (closed) constructs, plus any inherited carry construct. */
  constructs: Construct[]
  /** Constructs still open at the very end of the text (outermost first). */
  endStack: OpenMark[]
}

const EMPHASIS_BY_CHAR: Record<string, Record<number, OpenMark['kind']>> = {
  '*': { 1: 'italic', 2: 'bold', 3: 'boldItalic' },
  '_': { 1: 'italic', 2: 'underline' },
  '~': { 2: 'strike' },
  '|': { 2: 'spoiler' },
}

/** Pending open emphasis delimiter awaiting a match. */
interface PendingEmphasis {
  char: string
  len: number
  start: number // index of first delimiter char
  end: number // index just past the run
  canOpen: boolean
  canClose: boolean
  kind: OpenMark['kind']
}

/**
 * Parse `text` into matched constructs and the open stack at the end.
 *
 * `startCarry` represents constructs already open before `text` begins (e.g.
 * inherited from a previous message). The innermost inherited construct, if it
 * is exclusive (fence/inlineCode), means the text begins inside that construct.
 */
function parse(text: string, startCarry: MarkdownCarry = []): ParseResult {
  const constructs: Construct[] = []

  // Model inherited carry: if the innermost is exclusive, we begin inside it
  // and must first find its closer before any other parsing resumes.
  const inherited = startCarry.length > 0 ? startCarry[startCarry.length - 1]! : undefined
  const inheritedIsExclusive =
    inherited !== undefined && (inherited.kind === 'fence' || inherited.kind === 'inlineCode')

  // Track inherited constructs as open spans starting "before" the text.
  // Outer carry entries (non-exclusive) wrap the whole text; the exclusive
  // innermost one closes when its closer appears.
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

  // Emphasis delimiter stack (only used outside exclusive constructs).
  const emphasisStack: PendingEmphasis[] = []

  // Exclusive state: a currently-open fence or inline-code span.
  let exclusive:
    | { kind: 'fence'; char: string; runLen: number; opener: string; openStart: number; contentStart: number }
    | { kind: 'inlineCode'; runLen: number; opener: string; openStart: number; contentStart: number }
    | undefined

  // Seed exclusive state from inherited carry so the text starts inside it.
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

    // ----- Inside an open fence: only a matching closer line ends it. -----
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

    // ----- Not inside a fence: scan the line char by char. -----
    let i = 0
    while (i < lineText.length) {
      const absIdx = lineStart + i
      const ch = lineText[i]!

      // Backslash escape: the next char is literal.
      if (ch === '\\' && !exclusive) {
        i += 2
        continue
      }

      // Inside inline code: only a matching backtick run closes it.
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

      // Fence opener? Only valid at line start (after up to 3 spaces).
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
              contentStart: lineStart + lineText.length, // content begins next line
            }
            i = lineText.length // rest of opener line is the info string
            continue
          }
        }
        // Leading-whitespace fence (1–3 spaces of indent).
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

      // Inline code opener (backtick run, mid-line or non-fence).
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

      // Emphasis delimiters.
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

  // Anything still exclusive at end is an unclosed fence/inline → open at end.
  const endStack: OpenMark[] = []

  // Outer inherited (non-exclusive) carry entries remain open if never closed.
  // For simplicity inherited non-exclusive carry is treated as wrapping the
  // whole text and remaining open (it is dropped by exclusiveOnly at the cross
  // call boundary anyway). They are added to constructs so split points inside
  // see them as straddling.
  for (const ic of inheritedConstructs) {
    if (ic.kind !== 'fence' && ic.kind !== 'inlineCode') {
      constructs.push(ic)
      endStack.push({ kind: ic.kind, opener: ic.opener, closer: ic.closer })
    }
  }

  if (exclusive) {
    // Unclosed fence/inline: record as a construct open through end-of-text.
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

  // Unmatched emphasis delimiters left on the stack are open at end ONLY if
  // exclusive isn't set (already handled). They render literally if never
  // closed, so they are open-at-end but should not bridge internal splits
  // (they are not in `constructs`). We still report them in endStack so the
  // caller can decide (the loop filters to exclusiveOnly for cross-call carry).
  for (const pend of emphasisStack) {
    endStack.push({
      kind: pend.kind,
      opener: pend.char.repeat(pend.len),
      closer: pend.char.repeat(pend.len),
    })
  }

  return { constructs, endStack }

  // --- inner helpers that close over `constructs` ---
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

/**
 * Process an emphasis delimiter run; returns how many characters to advance.
 * Pushes openers and records matched constructs on close.
 */
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

  // Flanking rules (simplified CommonMark / Discord).
  let canOpen = !isWhitespace(after)
  let canClose = !isWhitespace(before)
  if (char === '_') {
    // Underscore emphasis does not work intra-word.
    canOpen = canOpen && !isWordChar(before)
    canClose = canClose && !isWordChar(after)
  }

  const kind = EMPHASIS_BY_CHAR[char]?.[len]
  // ~ and | only form constructs at length 2; a length-1 ~ or | is literal.
  if (!kind) {
    return len
  }

  // Try to close a matching open delimiter of the same char and length.
  if (canClose) {
    for (let s = stack.length - 1; s >= 0; s--) {
      const open = stack[s]!
      if (open.char === char && open.len === len && open.canOpen) {
        // Record the matched construct.
        constructs.push({
          kind,
          opener: char.repeat(len),
          closer: char.repeat(len),
          openStart: open.start,
          contentStart: open.end,
          contentEnd: start,
          closeEnd: start + len,
        })
        // Discard delimiters opened between the match (unmatched/literal).
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

// ---------------------------------------------------------------------------
// Fence helpers
// ---------------------------------------------------------------------------

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

/** Try to parse a fence opener from the start of a (de-indented) line. */
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

/** Does this line close an open fence with the given marker char/run? */
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

/** The closer string for a fence opener: just the marker run, no info. */
function fenceCloserFor(opener: string): string {
  const { char, runLen } = parseFenceMarker(opener)
  return char.repeat(runLen)
}

// ---------------------------------------------------------------------------
// Public stack helpers
// ---------------------------------------------------------------------------

/** Closing delimiters for an open stack, innermost first (reverse order). */
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

/**
 * A fence's reopener body: the marker run plus at most the first
 * whitespace-delimited word of the info string (the language tag), optionally
 * truncated to `infoBudget` chars. Replaying the entire verbatim opening line
 * is unnecessary — Discord only consumes the first token for syntax
 * highlighting — and a long info string would otherwise blow past maxLength
 * when the fence straddles a cut. Truncating the tag only affects the synthetic
 * reopener (a bridge that is stripped on reconstruction), never the body, so
 * losslessness is preserved.
 */
function fenceReopener(opener: string, infoBudget = Infinity): string {
  const { char, runLen } = parseFenceMarker(opener)
  const marker = char.repeat(runLen)
  const info = opener.slice(marker.length)
  const firstWord = info.trimStart().split(/\s/)[0] ?? ''
  const budget = Math.max(0, infoBudget)
  return marker + (firstWord.length > budget ? firstWord.slice(0, budget) : firstWord)
}

/** Reopening delimiters for an open stack, outermost first. */
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

/** Keep only exclusive constructs (fence / inlineCode) for cross-call carry. */
export function exclusiveOnly(stack: MarkdownCarry): MarkdownCarry {
  return stack.filter((m) => m.kind === 'fence' || m.kind === 'inlineCode')
}

/** Open-construct stack at the end of `text`, given inherited `start` carry. */
export function scanMarkdown(text: string, start: MarkdownCarry = []): MarkdownCarry {
  return parse(text, start).endStack
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Split `text` into chunks each <= maxLength, closing any open construct at a
 * chunk boundary and reopening it at the next. `startCarry` continues a
 * construct inherited from a previous message; `endCarry` reports the open
 * stack after the last chunk so callers can thread continuity across calls.
 */
export function splitPreservingMarkdown(
  text: string,
  maxLength: number,
  startCarry: MarkdownCarry = [],
): { chunks: ChunkPiece[]; endCarry: MarkdownCarry } {
  // Fast path: short, no inherited carry, no markdown.
  if (startCarry.length === 0 && text.length <= maxLength && hasNoDelimiters(text)) {
    return { chunks: [{ text }], endCarry: [] }
  }

  const { constructs, endStack } = parse(text, startCarry)

  // Every recorded construct is bridgeable: matched emphasis (closed), every
  // fence/inline-code span (open or closed), and inherited-carry constructs.
  // Unmatched emphasis is never recorded in `constructs`, so it is left literal.
  const bridgeable = constructs

  // stackAt(pos): constructs straddling pos (opener before, closer after),
  // ordered outermost-first.
  const stackAt = (pos: number): OpenMark[] => {
    return bridgeable
      .filter((c) => c.contentStart <= pos && pos <= c.contentEnd)
      .sort((a, b) => a.openStart - b.openStart)
      .map((c) => ({ kind: c.kind, opener: c.opener, closer: c.closer }))
  }

  const chunks: ChunkPiece[] = []
  let chunkStart = 0
  let inherited: OpenMark[] = startCarry.slice()

  // Reopener for an inherited stack, with a fence's info-string tail capped so
  // the reopener can never, on its own, crowd out maxLength. A fence is
  // exclusive (the sole stack entry when active); the room we must leave is its
  // own closer (marker + newline) plus at least one body char. This is what
  // makes invariant A (chunk.text.length <= maxLength) a hard guarantee even
  // when the original opening line is pathologically long. Emphasis openers are
  // tiny and never capped.
  const reopenerFor = (stack: OpenMark[]): string => {
    let out = ''
    for (const mark of stack) {
      if (mark.kind === 'fence') {
        const { runLen } = parseFenceMarker(mark.opener)
        // marker + info + '\n' (reopener) and marker + '\n' (closer) and 1 body.
        const infoBudget = maxLength - runLen - 1 - (runLen + 1) - 1
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

  // Delimiter chars whose runs merge when concatenated (backslash excluded — it
  // escapes rather than forming a run).
  const isRunChar = (ch: string | undefined): boolean =>
    ch === '`' || ch === '~' || ch === '*' || ch === '_' || ch === '|'

  // Does a NON-fence bridgeable construct's content span cross `pos`? Bridging
  // an inline construct (inline code / emphasis) across a cut abuts its
  // delimiter with the body and can fuse delimiter runs at the seam; a newline
  // that lands inside such a construct also needlessly fragments a small span.
  // Fences are exempt — straddling them at a newline is exactly how they bridge,
  // and their newline-anchored markers never fuse.
  const straddlesNonFence = (pos: number): boolean =>
    bridgeable.some((c) => c.kind !== 'fence' && c.contentStart <= pos && pos <= c.contentEnd)

  // Would emitting this chunk (body = text[chunkStart, cut], closed by
  // `closeStack`) and reopening `closeStack` in the next chunk fuse a synthetic
  // bridge string with an identical run char in the adjacent body, changing how
  // Discord parses the seam? Fences are newline-delimited so they never fuse.
  const seamMerges = (cut: number, closeStack: OpenMark[], isLast: boolean): boolean => {
    const body = text.slice(chunkStart, cut)
    if (body.length === 0) return false
    const closer = closeStack.length ? closeMarksForBody(body, closeStack) : ''
    // (ii) synthetic closer starts with the run char the body ends with.
    if (closer && isRunChar(closer[0]) && closer[0] === body[body.length - 1]) return true
    if (isLast) return false
    // (i) reopener (inherited by the next chunk) ends with the run char the next
    // chunk's body starts with.
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

    // Pick a cut whose real size (reopener + body + the closers for constructs
    // open AT THE CUT) fits maxLength. Shrink from the largest feasible end,
    // re-deriving the cut and its close-stack each pass so closers added by a
    // snapped cut are counted. `cut <= chunkStart + 1` escapes the pathological
    // case where the closers alone exceed maxLength.
    let end = Math.min(text.length, chunkStart + Math.max(1, maxLength - reopenLen))
    let cut = -1
    let closeStack: OpenMark[] = []
    for (let guard = 0; guard < 64; guard++) {
      if (end >= text.length) {
        cut = text.length
        // Final chunk: close only exclusive constructs (emphasis stays literal).
        closeStack = exclusiveOnly(stackAt(text.length))
      } else {
        // Prefer the latest newline within (chunkStart, end] that does not land
        // inside a non-fence construct (which would fragment it and risk a seam
        // merge); keep it at this chunk's end so reconstruction is exact.
        // Otherwise hard-split without bisecting a delimiter run.
        const body = text.slice(chunkStart, end)
        let nlCut = -1
        for (let nl = body.lastIndexOf('\n'); nl >= 0; nl = nl > 0 ? body.lastIndexOf('\n', nl - 1) : -1) {
          const candidate = chunkStart + nl + 1
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

    // Final chunk: if closing the dangling exclusive construct would fuse its
    // closer with a trailing delimiter run in the body (e.g. inline code whose
    // content ends in backticks), leave it open. It is unclosed in the original
    // — which Discord already renders literally — and there is no more body in
    // this call, so leaving it open both avoids the seam and matches the
    // original rendering. endCarry still reports it for cross-call continuation.
    if (isLast && closeStack.length && seamMerges(cut, closeStack, true)) {
      closeStack = []
    }

    // Avoid a seam that would fuse a bridge string with a same-char delimiter run
    // in the adjacent body (which merges runs and changes parsing). Pull the cut
    // left — off the offending delimiter and out of any construct it straddled —
    // until the seam clears. A smaller body only shrinks the fit, so invariant A
    // still holds. Monotonic (cut strictly decreases) so it always terminates.
    if (!isLast) {
      let guard = 0
      while (cut > chunkStart + 1 && seamMerges(cut, closeStack, isLast) && guard++ <= text.length) {
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

/** Closers for `stack`, ensuring a fence closer starts on its own line. */
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

/** Pull `pos` back so it never bisects a delimiter run; never below `floor`. */
function avoidDelimiterBisect(pos: number, constructs: Construct[], floor: number): number {
  for (const c of constructs) {
    // Inside an opener run?
    if (pos > c.openStart && pos < c.contentStart && c.openStart >= floor) return c.openStart
    // Inside a closer run?
    if (pos > c.contentEnd && pos < c.closeEnd && c.contentEnd >= floor) return c.contentEnd
  }
  return pos
}
