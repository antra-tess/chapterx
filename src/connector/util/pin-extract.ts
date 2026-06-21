/**
 * Pin classification — `.config` / `.steer` / `.sleep` extraction from tracked
 * pins. Ported from DiscordConnector so the portal backend produces identical
 * output. Pins are sorted by id (chronological) before extraction, matching the
 * discord path.
 */
import type { TrackedPin } from '../types.js'

function sortById(pins: TrackedPin[]): TrackedPin[] {
  return [...pins].sort((a, b) => a.id.localeCompare(b.id))
}

/** `.config [target]\n---\n<yaml>` → yaml (with `target:` prepended if present). */
export function extractConfigs(pins: TrackedPin[]): string[] {
  const configs: string[] = []
  for (const pin of sortById(pins)) {
    if (!pin.content.startsWith('.config')) continue
    const lines = pin.content.split('\n')
    if (lines.length > 2 && lines[1] === '---') {
      const target = lines[0]!.slice('.config'.length).trim() || undefined
      const yaml = lines.slice(2).join('\n')
      configs.push(target ? `target: ${target}\n${yaml}` : yaml)
    }
  }
  return configs
}

/** `.steer` pins not authored by a bot → { content, authorId }. */
export function extractSteers(pins: TrackedPin[]): Array<{ content: string; authorId: string }> {
  const out: Array<{ content: string; authorId: string }> = []
  for (const pin of sortById(pins)) {
    if (pin.content.startsWith('.steer') && !pin.authorBot) {
      out.push({ content: pin.content, authorId: pin.authorId })
    }
  }
  return out
}

/** `.sleep` pins (full records — sleep-state counters key on pin id). */
export function extractSleeps(pins: TrackedPin[]): TrackedPin[] {
  return sortById(pins).filter((p) => p.content.startsWith('.sleep'))
}
