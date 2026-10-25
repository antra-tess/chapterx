import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { logger } from '../utils/logger.js'
import type { ProbeCatalog, SteeringDirective, SteeringIntervention, InterventionType } from './types.js'

const catalogCache = new Map<string, ProbeCatalog>()

let catalogDir = ''

export function initCatalogDir(dir: string): void {
  catalogDir = dir
  catalogCache.clear()
}

export function loadCatalog(modelName: string): ProbeCatalog | null {
  const stripped = modelName.replace(/^[^:]+:/, '')
  const baseName = stripped.split('/').filter(Boolean).pop() || stripped
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

export function resolveLabel(
  catalog: ProbeCatalog,
  key: string
): { probe: string; probe_index: number; label: string } | null {
  const parts = key.split('_')

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

  const matches: Array<{ probe: string; probe_index: number }> = []
  for (const [setName, entry] of Object.entries(catalog)) {
    if (key in entry.labels) {
      matches.push({ probe: setName, probe_index: entry.labels[key]! })
    }
  }

  if (matches.length === 1) {
    return {
      probe: matches[0]!.probe,
      probe_index: matches[0]!.probe_index,
      label: key,
    }
  }

  return null
}

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

export function listAvailableLabels(catalog: ProbeCatalog): string[] {
  const labels: string[] = []
  for (const [setName, entry] of Object.entries(catalog)) {
    for (const label of Object.keys(entry.labels)) {
      labels.push(`${setName}_${label}`)
    }
  }
  return labels.sort()
}

export function listProbeSets(catalog: ProbeCatalog): string[] {
  return Object.keys(catalog).sort()
}
