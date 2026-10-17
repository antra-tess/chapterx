/**
 * Parse `.steer` messages from Discord.
 *
 * Supported formats:
 *
 *   Multi-line (YAML body):
 *     .steer BotName
 *     ---
 *     emotion_cheerful: 3.0
 *     emotion_calm: 2.0
 *
 *   Single-line (one label):
 *     .steer BotName label strength
 *     .steer BotName broadcast_f12454 -65
 *
 *   Optional readout section (after a second ---):
 *     .steer BotName
 *     ---
 *     emotion_cheerful: 3.0
 *     ---
 *     readout: emotion, deflection
 *
 *   Clear:
 *     .steer BotName clear
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
 * Strip Discord mention syntax from a target string.
 *   <@username> → username
 *   <@!id> → id
 */
function stripMention(raw: string): string {
  return raw.replace(/^<@!?([^>]+)>$/, '$1')
}

/**
 * Parse a .steer message content string.
 *
 * Supports both multi-line (with --- separator) and single-line formats.
 */
export function parseSteerMessage(content: string): SteerParseResult {
  const trimmed = content.trim()
  if (!trimmed.startsWith('.steer')) {
    return { ok: false, error: 'Not a .steer message' }
  }

  const lines = trimmed.split('\n')
  const firstLine = lines[0]!.trim()

  // Extract everything after .steer on the first line
  const afterSteer = firstLine.slice('.steer'.length).trim()
  if (!afterSteer) {
    return { ok: false, error: 'Missing target bot name. Format: `.steer BotName`' }
  }

  // Split first line into space-separated parts, handling mentions
  const parts = afterSteer.split(/\s+/)
  const target = stripMention(parts[0]!)

  // --- Clear command ---
  // .steer BotName clear
  if (parts.length === 2 && parts[1]!.toLowerCase() === 'clear') {
    return { ok: true, clear: true, target }
  }

  // --- Single-line format ---
  // .steer BotName label strength
  // .steer BotName broadcast_f12454 -65
  if (parts.length >= 3 && lines.length === 1) {
    const label = parts[1]!
    const strength = parseFloat(parts[2]!)
    if (isNaN(strength)) {
      return { ok: false, error: `Invalid strength value: "${parts[2]}". Must be a number.` }
    }
    const directives: SteeringDirective = { [label]: strength }

    // Auto-derive readout probes from the label
    const readout_probes: string[] = []
    const labelParts = label.split('_')
    if (labelParts.length >= 2) {
      readout_probes.push(labelParts[0]!)
    }

    return {
      ok: true,
      data: { target, directives, readout_probes },
    }
  }

  // --- Multi-line format ---
  // .steer BotName
  // ---
  // key: value pairs
  if (lines.length < 3 || lines[1]!.trim() !== '---') {
    // Single line but not enough parts for single-line format
    if (lines.length === 1) {
      return {
        ok: false,
        error: 'Format: `.steer BotName label strength` or multi-line with --- separator',
      }
    }
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
      const keyParts = key.split('_')
      if (keyParts.length >= 2) {
        probeSets.add(keyParts[0]!)
      }
    }
    readout_probes = Array.from(probeSets)
  }

  return {
    ok: true,
    data: { target, directives, readout_probes },
  }
}

/**
 * Check if a message content string is a .steer message.
 */
export function isSteerMessage(content: string): boolean {
  return content.trim().startsWith('.steer')
}
