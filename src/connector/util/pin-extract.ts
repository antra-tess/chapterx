/**
 * Pin classification — `.config` / `.steer` / `.sleep` extraction from tracked
 * pins. Ported from DiscordConnector so the portal backend produces identical
 * output. Pins are sorted by id (chronological) before extraction, matching the
 * discord path.
 */
import type { TrackedPin, PinnedSteer } from '../types.js'
import { pinAddressesBot, type BotIdentity } from '../../agent/pin-target.js'

function sortById(pins: TrackedPin[]): TrackedPin[] {
  return [...pins].sort((a, b) => a.id.localeCompare(b.id))
}

/** Identity + roles a connector resolves a pin target against. */
export interface PinMatchContext {
  identity: BotIdentity
  ownRoleIds?: readonly string[]
}

/**
 * `.config [target]\n---\n<yaml>` → yaml. When `ctx` is supplied and the target
 * (its text, or a relay-resolved role/persona mention) addresses this bot, the
 * target is stripped so parseChannelConfig applies it as a bare config.
 * Otherwise the `target:` text is preserved for downstream botId/config-name
 * matching. Without `ctx`, behaves as the original (target text preserved).
 */
export function extractConfigs(pins: TrackedPin[], ctx?: PinMatchContext): string[] {
  const configs: string[] = []
  for (const pin of sortById(pins)) {
    if (!pin.content.startsWith('.config')) continue
    const lines = pin.content.split('\n')
    if (lines.length > 2 && lines[1] === '---') {
      const target = lines[0]!.slice('.config'.length).trim() || undefined
      const yaml = lines.slice(2).join('\n')
      const addressesMe = ctx
        ? pinAddressesBot(
            { targetText: target, mentionedPersonaIds: pin.mentionedPersonaIds, mentionedRoleIds: pin.mentionedRoleIds },
            ctx.identity,
            ctx.ownRoleIds,
          )
        : false
      configs.push(target && !addressesMe ? `target: ${target}\n${yaml}` : yaml)
    }
  }
  return configs
}

/** `.steer` pins not authored by a bot → PinnedSteer (carries resolved mentions). */
export function extractSteers(pins: TrackedPin[]): PinnedSteer[] {
  const out: PinnedSteer[] = []
  for (const pin of sortById(pins)) {
    if (pin.content.startsWith('.steer') && !pin.authorBot) {
      out.push({
        content: pin.content,
        authorId: pin.authorId,
        mentionedPersonaIds: pin.mentionedPersonaIds,
        mentionedRoleIds: pin.mentionedRoleIds,
      })
    }
  }
  return out
}

/** `.sleep` pins (full records — sleep-state counters key on pin id). */
export function extractSleeps(pins: TrackedPin[]): TrackedPin[] {
  return sortById(pins).filter((p) => p.content.startsWith('.sleep'))
}
