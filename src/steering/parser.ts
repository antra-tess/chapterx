import { parse as parseYAML } from 'yaml'
import { steeringDirectiveSchema } from './types.js'
import { logger } from '../utils/logger.js'
import type { ParsedSteerMessage, SteeringDirective } from './types.js'

export type SteerParseResult =
  | { ok: true; data: ParsedSteerMessage }
  | { ok: true; clear: true; target: string }
  | { ok: false; error: string }

function stripMention(raw: string): string {
  return raw.replace(/^<@!?([^>]+)>$/, '$1')
}

export function parseSteerMessage(content: string): SteerParseResult {
  const trimmed = content.trim()
  if (!trimmed.startsWith('.steer')) {
    return { ok: false, error: 'Not a .steer message' }
  }

  const lines = trimmed.split('\n')
  const firstLine = lines[0]!.trim()

  const afterSteer = firstLine.slice('.steer'.length).trim()
  if (!afterSteer) {
    return { ok: false, error: 'Missing target bot name. Format: `.steer BotName`' }
  }

  const parts = afterSteer.split(/\s+/)
  const target = stripMention(parts[0]!)

  if (parts.length === 2 && parts[1]!.toLowerCase() === 'clear') {
    return { ok: true, clear: true, target }
  }

  if (parts.length >= 3 && lines.length === 1) {
    const label = parts[1]!
    const strength = parseFloat(parts[2]!)
    if (isNaN(strength)) {
      return { ok: false, error: `Invalid strength value: "${parts[2]}". Must be a number.` }
    }
    const directives: SteeringDirective = { [label]: strength }

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

  if (lines.length < 3 || lines[1]!.trim() !== '---') {
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

  const bodyLines = lines.slice(2)
  const secondSeparator = bodyLines.findIndex(l => l.trim() === '---')

  const yamlSection = secondSeparator >= 0
    ? bodyLines.slice(0, secondSeparator).join('\n')
    : bodyLines.join('\n')

  const readoutSection = secondSeparator >= 0
    ? bodyLines.slice(secondSeparator + 1).join('\n')
    : ''

  let rawDirective: unknown
  try {
    rawDirective = parseYAML(yamlSection)
  } catch (error) {
    return { ok: false, error: `Invalid YAML in steering body: ${error}` }
  }

  if (!rawDirective || typeof rawDirective !== 'object') {
    return { ok: false, error: 'Steering body must contain key: value pairs' }
  }

  const validated = steeringDirectiveSchema.safeParse(rawDirective)
  if (!validated.success) {
    const issues = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    return { ok: false, error: `Invalid steering values:\n${issues.join('\n')}` }
  }

  const directives: SteeringDirective = validated.data
  if (Object.keys(directives).length === 0) {
    return { ok: false, error: 'Steering body is empty — provide at least one `label: strength` pair' }
  }

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

export function isSteerMessage(content: string): boolean {
  return content.trim().startsWith('.steer')
}
