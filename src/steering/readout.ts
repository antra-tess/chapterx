/**
 * Format vLLM steering readout data into a markdown file embed.
 *
 * vLLM probe server response format (final SSE chunk or non-streaming):
 *   token_probes: { [setName]: number[][] }  — (n_tokens, n_probes) per set
 *   probe_names:  { [setName]: string[] }    — label names per set
 *   response_tokens: string[]                — per-token strings
 *   probe_status: "complete" | "computing" | "skipped"
 *   generation_mode: "steered" | "vllm"
 *   intervention_applied: InterventionConfig[]
 *   response_token_ids: number[]
 *
 * NOTE: Auto-reprobe during generation is currently disabled on the server
 * (causes CUDA graph instability). token_probes may be empty {}.
 * For full readouts, clients should POST /v1/encode with token_ids after generation.
 *
 * Follows the thinking block file embed pattern from agent/loop.ts:2359.
 */

import type { ChannelSteering } from './types.js'

// ---------------------------------------------------------------------------
// vLLM response shape (subset relevant to readouts)
// ---------------------------------------------------------------------------

interface VLLMReadoutData {
  token_probes: Record<string, number[][]>  // setName → (n_tokens × n_labels)
  probe_names: Record<string, string[]>     // setName → label names
  response_tokens?: string[]
  probe_status?: string
  generation_mode?: string
  intervention_applied?: Array<{
    type: string
    probe: string
    probe_index: number
    strength: number
    renorm?: boolean
  }>
  response_token_ids?: number[]
}

/**
 * Extract readout data from a raw vLLM response.
 * Returns null if no readout data is present.
 */
export function extractReadout(rawResponse: unknown): VLLMReadoutData | null {
  if (!rawResponse || typeof rawResponse !== 'object') return null

  const resp = rawResponse as Record<string, unknown>

  // Check for token_probes at top level (non-streaming or final chunk data)
  const tokenProbes = resp.token_probes as Record<string, number[][]> | undefined
  const probeNames = resp.probe_names as Record<string, string[]> | undefined

  if (tokenProbes && typeof tokenProbes === 'object' && Object.keys(tokenProbes).length > 0) {
    return {
      token_probes: tokenProbes,
      probe_names: probeNames || {},
      response_tokens: resp.response_tokens as string[] | undefined,
      probe_status: resp.probe_status as string | undefined,
      generation_mode: resp.generation_mode as string | undefined,
      intervention_applied: resp.intervention_applied as VLLMReadoutData['intervention_applied'],
      response_token_ids: resp.response_token_ids as number[] | undefined,
    }
  }

  // May also have intervention_applied even without probes
  if (resp.intervention_applied && Array.isArray(resp.intervention_applied)) {
    return {
      token_probes: {},
      probe_names: {},
      probe_status: resp.probe_status as string | undefined,
      generation_mode: resp.generation_mode as string | undefined,
      intervention_applied: resp.intervention_applied as VLLMReadoutData['intervention_applied'],
      response_token_ids: resp.response_token_ids as number[] | undefined,
    }
  }

  return null
}

/**
 * Format readout data into a markdown string for a file embed.
 * Returns null if there's nothing meaningful to display.
 */
export function formatReadout(
  rawResponse: unknown,
  steering: ChannelSteering,
): string | null {
  const readout = extractReadout(rawResponse)

  // Show readout if we have probe data or active interventions
  const hasProbes = readout && Object.keys(readout.token_probes).length > 0
  if (!hasProbes && steering.interventions.length === 0) return null

  const lines: string[] = []

  // Header
  lines.push(`# Steering Readout`)
  lines.push(`Model: \`${steering.model}\` | Set by: <@${steering.set_by}> | ${steering.updated_at}`)
  if (readout?.generation_mode) {
    lines.push(`Mode: ${readout.generation_mode} | Probe status: ${readout.probe_status || 'unknown'}`)
  }
  lines.push('')

  // Active interventions summary (from our config or from vLLM's confirmation)
  const applied = readout?.intervention_applied
  if (applied && applied.length > 0) {
    lines.push('## Interventions Applied (confirmed by vLLM)')
    lines.push('| Type | Probe | Index | Strength |')
    lines.push('|------|-------|-------|----------|')
    for (const i of applied) {
      lines.push(`| ${i.type} | ${i.probe} | ${i.probe_index} | ${i.strength > 0 ? '+' : ''}${i.strength.toFixed(2)} |`)
    }
    lines.push('')
  } else if (steering.interventions.length > 0) {
    lines.push('## Active Interventions')
    lines.push('| Probe | Label | Strength |')
    lines.push('|-------|-------|----------|')
    for (const i of steering.interventions) {
      lines.push(`| ${i.probe} | ${i.label} | ${i.strength > 0 ? '+' : ''}${i.strength.toFixed(1)} |`)
    }
    lines.push('')
  }

  // Probe projection tables
  if (hasProbes) {
    lines.push('## Probe Projections')

    for (const [setName, projections] of Object.entries(readout.token_probes)) {
      if (!projections || projections.length === 0) continue

      const labels = readout.probe_names[setName] || []
      const nTokens = projections.length

      // Compute per-label aggregates across tokens
      const nLabels = projections[0]?.length || 0
      if (nLabels === 0) continue

      lines.push(`### ${setName} (${nTokens} tokens, ${nLabels} labels)`)

      // For large label sets, show top-N by absolute mean
      const labelStats: Array<{ label: string; mean: number; min: number; max: number }> = []
      for (let j = 0; j < nLabels; j++) {
        const values = projections.map(row => row[j] ?? 0)
        const mean = values.reduce((a, b) => a + b, 0) / values.length
        const min = Math.min(...values)
        const max = Math.max(...values)
        labelStats.push({
          label: labels[j] || `idx_${j}`,
          mean,
          min,
          max,
        })
      }

      // Sort by absolute mean descending, show top 20
      labelStats.sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))
      const shown = labelStats.slice(0, 20)

      lines.push('| Label | Mean | Min | Max |')
      lines.push('|-------|------|-----|-----|')
      for (const s of shown) {
        lines.push(`| ${s.label} | ${s.mean.toFixed(3)} | ${s.min.toFixed(3)} | ${s.max.toFixed(3)} |`)
      }
      if (labelStats.length > 20) {
        lines.push(`| ... | *(${labelStats.length - 20} more)* | | |`)
      }
      lines.push('')
    }
  } else if (readout?.probe_status === 'skipped') {
    lines.push('*Probe readout skipped (probes: [])*')
    lines.push('')
  }

  // Token count
  if (readout?.response_token_ids) {
    lines.push(`Response tokens: ${readout.response_token_ids.length}`)
  }

  return lines.join('\n')
}
