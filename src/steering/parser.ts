/**
 * Parse `.steer` messages from Discord.
 *
 * Format:
 *   .steer BotName
 *   ---
 *   emotion_cheerful: 3.0
 *   emotion_calm: 2.0
 *   deflection_afraid_hiding_as_calm: -1.5
 *
 * Optional readout section (after a second ---):
 *   .steer BotName
 *   ---
 *   emotion_cheerful: 3.0
 *   ---
 *   readout: emotion, deflection
 *
 * Special: `.steer BotName clear` removes all steering for that bot in the channel.
 */

import { parse as parseYAML } from 'yaml'
import { steeringDirectiveSchema } from './types.js'
import { logger } from '../utils/logger.js'
import type { ParsedSteerMessage, SteeringDirective } from './types.js'

/** Result of parsing a .steer message */
export type SteerParseResult =
  | { ok: true; data: ParsedSteerMessage }
  | { ok: true; clear: true; target: string }
  | { ok: false; error: string }

/**
 * Parse a .steer message content string.
 *
 * Follows the same pattern as extractConfigs() in connector.ts:
 * first line has the target, `---` separator, then YAML body.
 */
export function parseSteerMessage(content: string): SteerParseResult {
  const trimmed = content.trim()
  if (!trimmed.startsWith('.steer')) {
    return { ok: false, error: 'Not a .steer message' }
  }

  const lines = trimmed.split('\n')
  const firstLine = lines[0]!.trim()

  // Extract target bot name from first line
  const target = firstLine.slice('.steer'.length).trim()
  if (!target) {
    return { ok: false, error: 'Missing target bot name. Format: `.steer BotName`' }
  }

  // Check for clear command: `.steer BotName clear`
  const targetParts = target.split(/\s+/)
  if (targetParts.length > 1 && targetParts[targetParts.length - 1]!.toLowerCase() === 'clear') {
    return { ok: true, clear: true, target: targetParts.slice(0, -1).join(' ') }
  }

  // Must have --- separator
  if (lines.length < 3 || lines[1]!.trim() !== '---') {
    return {
      ok: false,
      error: 'Missing YAML separator. Format:\n```\n.steer BotName\n---\nemotion_cheerful: 3.0\n```',
    }
  }

  // Split remaining lines on optional second --- for readout section
  const bodyLines = lines.slice(2)
  const secondSeparator = bodyLines.findIndex(l => l.trim() === '---')

  const yamlSection = secondSeparator >= 0
    ? bodyLines.slice(0, secondSeparator).join('\n')
    : bodyLines.join('\n')

  const readoutSection = secondSeparator >= 0
    ? bodyLines.slice(secondSeparator + 1).join('\n')
    : ''

  // Parse directive YAML
  let rawDirective: unknown
  try {
    rawDirective = parseYAML(yamlSection)
  } catch (error) {
    return { ok: false, error: `Invalid YAML in steering body: ${error}` }
  }

  if (!rawDirective || typeof rawDirective !== 'object') {
    return { ok: false, error: 'Steering body must contain key: value pairs' }
  }

  // Validate directive shape
  const validated = steeringDirectiveSchema.safeParse(rawDirective)
  if (!validated.success) {
    const issues = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    return { ok: false, error: `Invalid steering values:\n${issues.join('\n')}` }
  }

  const directives: SteeringDirective = validated.data
  if (Object.keys(directives).length === 0) {
    return { ok: false, error: 'Steering body is empty — provide at least one `label: strength` pair' }
  }

  // Parse optional readout probes
  let readout_probes: string[] = []
  if (readoutSection.trim()) {
    try {
      const readoutParsed = parseYAML(readoutSection)
      if (readoutParsed && typeof readoutParsed === 'object' && 'readout' in readoutParsed) {
        const val = (readoutParsed as Record<string, unknown>).readout
        if (typeof val === 'string') {
          readout_probes = val.split(',').map(s => s.trim()).filter(Boolean)
        } else if (Array.isArray(val)) {
          readout_probes = val.map(String)
        }
      }
    } catch {
      logger.debug('Failed to parse readout section — ignoring')
    }
  }

  // Auto-derive readout probes from directive keys if not explicitly set
  if (readout_probes.length === 0) {
    const probeSets = new Set<string>()
    for (const key of Object.keys(directives)) {
      // Extract set name (everything before the last label part)
      // This is a heuristic — catalog.resolveLabel does the real resolution
      const parts = key.split('_')
      if (parts.length >= 2) {
        probeSets.add(parts[0]!)
      }
    }
    readout_probes = Array.from(probeSets)
  }

  return {
    ok: true,
    data: {
      target: targetParts[0] || target,
      directives,
      readout_probes,
    },
  }
}

/**
 * Check if a message content string is a .steer message.
 */
export function isSteerMessage(content: string): boolean {
  return content.trim().startsWith('.steer')
}
