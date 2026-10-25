import { displayNameClasses } from '../discord/member-names.js'
import { codeRanges, type MarkdownCarry } from '../utils/discord-markdown.js'

export interface MentionAuthor {
  id: string
  username: string
  displayName: string
  bot: boolean
  webhook?: boolean
}

export interface MentionConfig {
  name?: string
  use_display_names?: boolean
  use_display_names_bots?: boolean
  use_display_names_humans?: boolean
  mention_format?: string
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const DISCORD_ID = /^\d{17,20}$/
/** Discord's mention of a role, or of a user by `!` and an id. */
const DISCORD_MENTION = /<@[!&]\d+>/y
const NOT_IN_REPLY_TAG = '(?<!\\(replying to)'
const LEAD = `(?<lead>^|[\\s([{"'“‘*_~|])`
const END = '(?![\\p{L}\\p{M}\\p{N}_])'
/** After a template ending in `]`, a `(` would make a markdown link `[Name](url)`. */
const NOT_LINK = '(?!\\()'
/** Discord shows `<\@` as `<@`, and neither it nor the connector's lookup
 *  reads a mention there. */
const inert = (text: string): string => text.replaceAll('<@', '<\\@')
/** Never read as a name, since Discord gives them to everyone in a channel. */
const CHANNEL_WIDE = new Set(['everyone', 'here'])

type Holder = { id: string; bot: boolean } | null

class Names extends Map<string, Holder> {
  /** Each name as written and lowercased: a regex's `iu` flags don't fold
   *  every pair, such as `İ` and the `i̇` its lowercase gives. */
  readonly spellings = new Set<string>()

  hold(written: string, holder: Holder): void {
    const name = written.toLowerCase()
    if (!name || CHANNEL_WIDE.has(name)) return
    this.spellings.add(written).add(name)
    const known = this.get(name)
    this.set(name, known === undefined || (known !== null && holder !== null && known.id === holder.id) ? holder : null)
  }
}

export function mentionsToIds(
  text: string,
  authors: MentionAuthor[],
  config: MentionConfig,
  carry: MarkdownCarry = [],
): string {
  const classes = displayNameClasses(config)
  const template = config.mention_format || undefined
  const bracketedTemplate = template === '<@{name}>'
  const bracketedNames = new Names()
  const otherNames = new Names()
  const usernames = new Names()
  if (config.name) for (const names of [bracketedNames, otherNames, usernames]) names.hold(config.name, null)
  for (const author of authors) {
    const holder: Holder = author.webhook ? null : { id: author.id, bot: author.bot }
    const byDisplayName = (author.bot ? classes.bots : classes.humans) && Boolean(author.displayName)
    const name = byDisplayName ? author.displayName : author.username
    if (template) {
      ;(bracketedTemplate ? bracketedNames : otherNames).hold(name, holder)
    } else {
      if (byDisplayName) otherNames.hold(name, holder)
      if (!byDisplayName || author.displayName === author.username) bracketedNames.hold(name, holder)
    }
    usernames.hold(author.username, holder)
  }

  const alternatives = (names: Iterable<string>): string =>
    [...new Set(names)].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const anyName = alternatives([...bracketedNames.spellings, ...otherNames.spellings, ...usernames.spellings])
  if (!anyName) return text

  const forms = [`<@(?<bracketed>${anyName})>`]
  const format = template ?? '@{name}'
  const at = format.indexOf('{name}')
  const prefix = at < 0 ? '' : format.slice(0, at)
  const suffix = at < 0 ? '' : format.slice(at + '{name}'.length)
  const otherForm = alternatives(otherNames.spellings)
  if (otherForm && prefix && !bracketedTemplate) {
    const end = suffix ? escapeRegExp(suffix) + (suffix.endsWith(']') ? NOT_LINK : '') : END
    forms.push(`${NOT_IN_REPLY_TAG}${LEAD}${escapeRegExp(prefix)}(?<shown>${otherForm})${end}`)
  }

  const code = codeRanges(text, carry)
  let lastEnd = -1
  let lastWritten = ''
  const rewrite = (match: string, groups: Record<string, string | undefined>, offset: number): string => {
    // Escaped in code too, where Discord shows the backslash: what's read as code
    // here reaches past what Discord shows as code, and where Discord reads prose,
    // a `<@` could ping.
    if (code.some(([start, end]) => offset < end && offset + match.length > start)) {
      DISCORD_MENTION.lastIndex = offset
      const kept = code.some(([start, end]) => offset >= start && offset < end) && !DISCORD_MENTION.test(text)
      return match.replace(/<@/g, (lt: string, at: number) => (at > 0 || !kept ? '<\\@' : lt))
    }
    if (groups.bracketed !== undefined) {
      if (DISCORD_ID.test(groups.bracketed)) return match
      const key = groups.bracketed.toLowerCase()
      const names = [bracketedNames, otherNames, usernames].find((n) => n.has(key))
      if (!names) return match
      const holder = names.get(key)
      if (holder) return `<@${holder.id}>`
      // A name ending in an odd run of backslashes gets one more, so the run
      // escapes nothing after it.
      const run = /\\*$/.exec(groups.bracketed)![0].length
      return inert(`@${groups.bracketed}${run % 2 ? '\\' : ''}`)
    }
    // A trailing odd run of backslashes escapes the character after the mention,
    // which replacing the mention would unescape.
    if (match.endsWith('\\')) return inert(match)
    const holder = otherNames.get((groups.shown ?? '').toLowerCase())
    return holder && !holder.bot ? `${groups.lead ?? ''}<@${holder.id}>` : inert(match)
  }
  return text.replace(new RegExp(forms.join('|'), 'giu'), (match: string, ...rest: unknown[]) => {
    const offset = rest[rest.length - 3] as number
    let written = rewrite(match, rest[rest.length - 1] as Record<string, string | undefined>, offset)
    const before = offset === lastEnd ? lastWritten.slice(-1) : text.slice(Math.max(offset - 1, 0), offset)
    if (before === '<' && written.startsWith('@')) written = `\\${written}`
    if (written.endsWith('<') && text[offset + match.length] === '@') written = `${written}\\`
    lastWritten = written
    lastEnd = offset + match.length
    return written
  })
}
