/**
 * Turn the mentions the model writes back into Discord mentions by id, for
 * the people in the conversation.
 *
 * The model writes a mention the way the context shows names. The context
 * shows each author by their display name when their class (bots or humans)
 * is labelled by display name, and by their username otherwise. It writes a
 * mention of someone shown by display name as `@Display Name`, and of
 * someone shown by username, or whose display name is their username, as
 * `<@username>` (format-messages.ts, mentions.ts). With a `mention_format`,
 * it writes every mention in that template instead, such as `[{name}]`.
 *
 * A name exactly one author in the conversation is shown by in a form
 * becomes `<@id>` there, so that person is pinged. `<@Name>` is read as a
 * name the context writes in that form first, then as a display name, then
 * as a username, so the model can bracket any of them. A bot is pinged only
 * through `<@Name>`, by the name it is shown by or by its username; its
 * `@Name` is left as written.
 *
 * Everything else is left as written:
 * - A name two authors are shown by in the same form, bots and webhooks
 *   included, since it can't say which of them was meant. Its `<@Name>` form
 *   is written as `@Name`, so the connector's lookup doesn't pick one of
 *   them either.
 * - The bot's own name, `config.name`, by which the context labels the bot's
 *   own messages and, usually, mentions of it. It is held by no one in every
 *   form, so a person shown by the same name shares it with the bot, and its
 *   `<@Name>` form is written as `@Name` too.
 * - A name a webhook is shown by, such as an Oblique persona's: a webhook
 *   can't be pinged, so its `<@Name>` form is written as `@Name` too.
 * - A `<@name>` the conversation doesn't hold, which goes on to the
 *   connector's lookup, as before.
 * - A mention by id: `<@` and the 17 to 20 digits of a Discord id, even when
 *   someone in the conversation is shown by that number.
 * - Code blocks and inline code, where Discord shows a mention raw, and a
 *   mention any part of which is code (`codeRanges`, discord-markdown.ts):
 *   what the markdown splitter's parse reads as code, the text read as the
 *   splitter sends it after the reopener of a block or span carried open from
 *   an earlier message (`carry`), and every ``` block as Discord pairs them.
 * - A name ending in a backslash, in the `@Name` form: the backslash escapes
 *   the character after it, which replacing the name would unescape.
 * - `@everyone` and `@here`.
 * - Reply tags: `<reply:@Name>`, and the context's `(replying to @Name)`. A
 *   `<@Name>` in one, as a `<@{name}>` template writes it, is read like any
 *   other `<@Name>`, as before.
 *
 * Outside `<@Name>`, a mention starts at the start of the text, after
 * whitespace, or after an opening bracket, quote or markdown mark. An `@`
 * right after a letter, digit or `/` isn't read, so URLs and addresses such as
 * a@b usually stay as written. It ends where no letter, mark, digit or
 * underscore follows, or with the template's closing text, which a link's
 * `(` may not follow: a template ending in `]`, such as `[{name}]`, would
 * otherwise break the link `[Name](url)`. In the default form a name in a
 * link's text is read like any other, and the link stays whole. A name is
 * read as the longest name in the conversation it begins with, so
 * `@Jack Smith` is Jack Smith, never Jack. A longer name the conversation
 * doesn't hold can't be known: with Sam present, `@Sam Altman` reads as Sam.
 * A `mention_format` with nothing before `{name}`, such as `{name}` alone,
 * isn't read, since a name at the start of a line can't be told from a
 * mention of it.
 */

import { displayNameClasses } from '../discord/member-names.js'
import { codeRanges, type MarkdownCarry } from '../utils/discord-markdown.js'

export interface MentionAuthor {
  id: string
  username: string
  displayName: string
  bot: boolean
  /** Sent through a webhook, such as an Oblique persona: `id` is the webhook's. */
  webhook?: boolean
}

/** The config keys that decide how the context shows people's names. */
export interface MentionConfig {
  /** The bot's own name, which the context shows it by (format-messages.ts). */
  name?: string
  use_display_names?: boolean
  use_display_names_bots?: boolean
  use_display_names_humans?: boolean
  mention_format?: string
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A mention by id, which is left as written. */
const DISCORD_ID = /^\d{17,20}$/
/** Not inside the context's reply tag, `(replying to @Name)`. */
const NOT_IN_REPLY_TAG = '(?<!\\(replying to)'
/** What may come just before a mention. */
const LEAD = `(?<lead>^|[\\s([{"'“‘*_~|])`
/** A mention's name ends where no letter, mark, digit or underscore follows. */
const END = '(?![\\p{L}\\p{M}\\p{N}_])'
/** After a template ending in `]`: not a markdown link's target. */
const NOT_LINK = '(?!\\()'
/** Never read as a name, since Discord gives them to everyone in a channel. */
const CHANNEL_WIDE = new Set(['everyone', 'here'])

/** A name's holder, or null when it can't be pinged (shared, or a webhook's). */
type Holder = { id: string; bot: boolean } | null

/** Lowercased name → holder; a name held by two authors holds null. */
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
  // An empty mention_format is unset, as the context reads it.
  const template = config.mention_format || undefined
  const bracketedTemplate = template === '<@{name}>'
  // The names the context writes as `<@name>`, the names it writes in its
  // other form (`@Name`, or the mention_format's template), and people's
  // usernames, each with who holds it.
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
    // Every author's username, a bot's too, so that `<@username>` of a bot
    // shown by its display name goes to that bot rather than to the
    // connector's lookup, which prefers a person. A webhook's is held by no one.
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
  return text.replace(new RegExp(forms.join('|'), 'giu'), (match: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>
    const offset = rest[rest.length - 3] as number
    // A mention any part of which is code is left as written.
    if (code.some(([start, end]) => offset < end && offset + match.length > start)) return match
    if (groups.bracketed !== undefined) {
      if (DISCORD_ID.test(groups.bracketed)) return match
      const key = groups.bracketed.toLowerCase()
      const names = [bracketedNames, otherNames, usernames].find((n) => n.has(key))
      if (!names) return match
      const holder = names.get(key)
      return holder ? `<@${holder.id}>` : `@${groups.bracketed}`
    }
    // A name ending in a backslash escapes the character after it, which
    // replacing the name would unescape.
    if (groups.shown?.endsWith('\\')) return match
    const holder = otherNames.get((groups.shown ?? '').toLowerCase())
    return holder && !holder.bot ? `${groups.lead ?? ''}<@${holder.id}>` : match
  })
}
