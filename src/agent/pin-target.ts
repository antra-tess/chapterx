export interface BotIdentity {
  botId: string
  configName?: string
  discordUsername?: string
  discordGlobalName?: string
  /** Discord user id (account) or persona id (portal) — matches `<@id>`. */
  discordUserId?: string
}

export interface PinTarget {
  targetText?: string
  mentionedPersonaIds?: readonly string[]
  mentionedRoleIds?: readonly string[]
}

function stripMention(s: string): string {
  return s.replace(/^<@[!&]?([^>]+)>$/, '$1').replace(/^@/, '')
}

export function pinAddressesBot(
  pin: PinTarget,
  identity: BotIdentity,
  ownRoleIds?: readonly string[],
): boolean {
  const targetText = pin.targetText?.trim()
  const hasText = !!targetText
  const hasMentions = !!(pin.mentionedPersonaIds?.length || pin.mentionedRoleIds?.length)

  if (!hasText && !hasMentions) return true

  if (identity.discordUserId && pin.mentionedPersonaIds?.includes(identity.discordUserId)) {
    return true
  }

  if (ownRoleIds?.length && pin.mentionedRoleIds?.length) {
    if (pin.mentionedRoleIds.some((r) => ownRoleIds.includes(r))) return true
  }

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
