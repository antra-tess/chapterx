/**
 * Split content into chunks ≤ maxLen, preferring newline then space boundaries.
 * Mirrors the discord connector's 1800-char auto-split. Returns [] for empty.
 */
export function splitContent(content: string, maxLen = 1800): string[] {
  if (content.length <= maxLen) return content.length ? [content] : []
  const chunks: string[] = []
  let rest = content
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen)
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen)
    if (cut < maxLen * 0.5) cut = maxLen
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length) chunks.push(rest)
  return chunks
}
