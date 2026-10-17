/**
 * Shared "does this pinned command address me?" resolution for `.config`,
 * `.sleep`, and `.steer`.
 *
 * Historically each pinned-command path matched its target differently
 * (`.sleep` against the full identity set; `.config` against botId + display
 * name only) and none understood Discord/portal *mentions* — a role mention
 * `<@&id>` stripped to the literal `&id` and matched nothing.
 *
 * This unifies them. A pinned command addresses a bot when:
 *   - it has no target and no mentions at all (a bare command → applies to all), OR
 *   - the relay/Discord already resolved a mention to this bot — its persona id
 *     (portal) or one of its own guild role ids (account), OR
 *   - the literal target text matches any of the bot's identity forms.
 *
 * Adding mention-awareness is purely additive: existing bare-command and
 * text-target behavior is unchanged.
 */

export interface BotIdentity {
  /** EMS directory / internal bot id — e.g. `opus47`. */
  botId: string
  /** Config `name:` field — e.g. `Opus4.7`. */
  configName?: string
  /** Discord account username — e.g. `opus4.7`. */
  discordUsername?: string
  /** Discord account global display name — e.g. `Opus 4.7` (with spaces). */
  discordGlobalName?: string
  /** Discord user id (account) or persona id (portal) — matches `<@id>`. */
  discordUserId?: string
}

/** Mention/target signals carried by a pinned command message. */
export interface PinTarget {
  /** Raw target text after the command (`<@123>`, `haiku45`, `<@&456>`, …). */
  targetText?: string
  /** Relay-resolved persona ids addressed by this pin (portal backend). */
  mentionedPersonaIds?: readonly string[]
  /** Raw role ids mentioned in this pin (discord + portal backends). */
  mentionedRoleIds?: readonly string[]
}

/** Strip a single Discord mention wrapper: `<@id>`, `<@!id>`, `<@&id>`, or `@name`. */
function stripMention(s: string): string {
  return s.replace(/^<@[!&]?([^>]+)>$/, '$1').replace(/^@/, '')
}

/**
 * True if a pinned command (`.config` / `.sleep` / `.steer`) addresses this bot.
 *
 * @param ownRoleIds the bot's OWN Discord role ids in the pin's guild (account
 *   bots only — resolve per-guild and pass in). Omit for portal bots: they
 *   match via `mentionedPersonaIds` against their persona id
 *   (`identity.discordUserId`).
 */
export function pinAddressesBot(
  pin: PinTarget,
  identity: BotIdentity,
  ownRoleIds?: readonly string[],
): boolean {
  const targetText = pin.targetText?.trim()
  const hasText = !!targetText
  const hasMentions = !!(pin.mentionedPersonaIds?.length || pin.mentionedRoleIds?.length)

  // Bare command — no explicit target at all — applies to every bot.
  if (!hasText && !hasMentions) return true

  // Resolved persona mention (portal): the relay addressed our persona id.
  if (identity.discordUserId && pin.mentionedPersonaIds?.includes(identity.discordUserId)) {
    return true
  }

  // Resolved role mention (account): a mentioned role is one of ours.
  if (ownRoleIds?.length && pin.mentionedRoleIds?.length) {
    if (pin.mentionedRoleIds.some((r) => ownRoleIds.includes(r))) return true
  }

  // Literal target-text match against the full identity set (case-insensitive).
  if (hasText) {
    const t = stripMention(targetText!).toLowerCase()
    const candidates = [
      identity.botId,
      identity.configName,
      identity.discordUsername,
      identity.discordGlobalName,
      identity.discordUserId,
    ]
    if (candidates.some((c) => !!c && c.toLowerCase() === t)) return true
  }

  return false
}
