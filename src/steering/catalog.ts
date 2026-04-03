/**
 * Probe catalog loader and directive resolver.
 *
 * Catalogs are static JSON files at config/probes/{model}.json.
 * Each maps probe set names to { description, labels: { label → index } }.
 *
 * The resolver turns `setname_label: strength` pairs into resolved
 * SteeringIntervention objects ready for vLLM.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { logger } from '../utils/logger.js'
import type { ProbeCatalog, SteeringDirective, SteeringIntervention, InterventionType } from './types.js'

// ---------------------------------------------------------------------------
// Catalog loading
// ---------------------------------------------------------------------------

const catalogCache = new Map<string, ProbeCatalog>()

/** Directory containing probe catalog JSON files */
let catalogDir = ''

/**
 * Initialize the catalog loader with the probe catalog directory path.
 * Call once on startup.
 */
export function initCatalogDir(dir: string): void {
  catalogDir = dir
  catalogCache.clear()
}

/**
 * Load a probe catalog for a model. Caches in memory after first load.
 * Returns null if no catalog exists for the model.
 */
export function loadCatalog(modelName: string): ProbeCatalog | null {
  // Normalize model name to catalog filename:
  //   "steered:/models/Trinity-Large-TrueBase"
  //   → strip namespace prefix ("steered:") → "/models/Trinity-Large-TrueBase"
  //   → extract basename → "Trinity-Large-TrueBase"
  //   → lowercase → "trinity-large-truebase"
  const stripped = modelName.replace(/^[^:]+:/, '')  // strip "steered:" etc.
  const baseName = stripped.split('/').filter(Boolean).pop() || stripped  // extract basename
  const key = baseName.toLowerCase()

  const cached = catalogCache.get(key)
  if (cached) return cached

  if (!catalogDir) {
    logger.warn('Catalog directory not initialized — call initCatalogDir() first')
    return null
  }

  const filePath = join(catalogDir, `${key}.json`)
  if (!existsSync(filePath)) {
    logger.debug({ modelName, key, filePath }, 'No probe catalog found for model')
    return null
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const catalog: ProbeCatalog = JSON.parse(raw)
    catalogCache.set(key, catalog)
    logger.info({ modelName, key, sets: Object.keys(catalog).length }, 'Loaded probe catalog')
    return catalog
  } catch (error) {
    logger.error({ error, filePath }, 'Failed to parse probe catalog')
    return null
  }
}

/**
 * List all available catalog model names (derived from filenames in the catalog dir).
 */
export function listCatalogModels(): string[] {
  if (!catalogDir || !existsSync(catalogDir)) return []
  try {
    return readdirSync(catalogDir)
      .filter(f => f.endsWith('.json'))
      .map(f => basename(f, '.json'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Directive resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a setname_label key against a catalog.
 *
 * Format: `setname_label` where setname is the probe set and label is the probe label.
 * Since both set names and labels can contain underscores, we try longest-prefix matching:
 *   "deflection_afraid_hiding_as_calm" → set="deflection", label="afraid_hiding_as_calm"
 *
 * Returns { probe, probe_index } or null if not found.
 */
export function resolveLabel(
  catalog: ProbeCatalog,
  key: string
): { probe: string; probe_index: number; label: string } | null {
  const parts = key.split('_')

  // Try progressively longer set name prefixes
  for (let i = 1; i < parts.length; i++) {
    const setName = parts.slice(0, i).join('_')
    const labelName = parts.slice(i).join('_')

    const probeSet = catalog[setName]
    if (!probeSet) continue

    if (labelName in probeSet.labels) {
      return {
        probe: setName,
        probe_index: probeSet.labels[labelName]!,
        label: key,
      }
    }
  }

  return null
}

/**
 * Resolve a full SteeringDirective (multiple setname_label: strength pairs)
 * into an array of SteeringInterventions.
 *
 * Returns { interventions, errors } where errors lists any keys that couldn't be resolved.
 */
export function resolveDirective(
  catalog: ProbeCatalog,
  directive: SteeringDirective,
  interventionType: InterventionType = 'steer'
): { interventions: SteeringIntervention[]; errors: string[] } {
  const interventions: SteeringIntervention[] = []
  const errors: string[] = []

  for (const [key, strength] of Object.entries(directive)) {
    const resolved = resolveLabel(catalog, key)
    if (resolved) {
      interventions.push({
        type: interventionType,
        probe: resolved.probe,
        probe_index: resolved.probe_index,
        strength,
        label: resolved.label,
      })
    } else {
      errors.push(key)
    }
  }

  return { interventions, errors }
}

/**
 * List all available `setname_label` keys for a catalog.
 * Useful for autocomplete or error messages showing valid options.
 */
export function listAvailableLabels(catalog: ProbeCatalog): string[] {
  const labels: string[] = []
  for (const [setName, entry] of Object.entries(catalog)) {
    for (const label of Object.keys(entry.labels)) {
      labels.push(`${setName}_${label}`)
    }
  }
  return labels.sort()
}

/**
 * List probe set names for a catalog (e.g., ["emotion", "deflection", "dynamics_ica"]).
 */
export function listProbeSets(catalog: ProbeCatalog): string[] {
  return Object.keys(catalog).sort()
}
