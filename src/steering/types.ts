/**
 * Steering types for representation engineering via vLLM probe interventions.
 *
 * Data flow:
 *   .steer message (YAML pairs) → SteeringDirective
 *     → resolved via ProbeCatalog → SteeringIntervention[]
 *     → stored as ChannelSteering per bot:channel
 *     → injected into provider_params → vLLM
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Probe catalog (loaded from static JSON files in config/probes/)
// ---------------------------------------------------------------------------

/** A single probe set within a model's catalog */
export interface ProbeSetEntry {
  description: string
  labels: Record<string, number>  // label_name → probe_index
}

/** Full probe catalog for a model — keyed by set name (e.g., "emotion", "deflection") */
export type ProbeCatalog = Record<string, ProbeSetEntry>

// ---------------------------------------------------------------------------
// Steering directives (parsed from .steer YAML body)
// ---------------------------------------------------------------------------

/** Raw parsed pairs from .steer YAML: `setname_label: strength` */
export type SteeringDirective = Record<string, number>

// ---------------------------------------------------------------------------
// Resolved interventions (ready for vLLM)
// ---------------------------------------------------------------------------

export const INTERVENTION_TYPES = ['steer', 'floor', 'ceil'] as const
export type InterventionType = typeof INTERVENTION_TYPES[number]

/** Single resolved intervention — maps to vLLM's intervention format */
export interface SteeringIntervention {
  type: InterventionType
  probe: string        // probe set name, e.g., "emotion"
  probe_index: number  // index within the set, e.g., 19 for "cheerful"
  strength: number     // steering strength, e.g., 3.0
  label: string        // original label for display, e.g., "emotion_cheerful"
}

// ---------------------------------------------------------------------------
// Per-channel per-bot steering state
// ---------------------------------------------------------------------------

/** Stored steering configuration for a bot in a channel */
export interface ChannelSteering {
  interventions: SteeringIntervention[]
  /** Probe set names to request readouts for (sent as `probes` in provider_params) */
  readout_probes: string[]
  /** When this config was last set */
  updated_at: string  // ISO timestamp
  /** Discord user ID who set this config */
  set_by: string
  /** Model name this was resolved against */
  model: string
}

// ---------------------------------------------------------------------------
// Parsed .steer message
// ---------------------------------------------------------------------------

export interface ParsedSteerMessage {
  /** Target bot name (from first line after .steer) */
  target: string
  /** Raw directive pairs from YAML body */
  directives: SteeringDirective
  /** Probe set names to request readouts for (optional) */
  readout_probes: string[]
}

// ---------------------------------------------------------------------------
// Zod schemas for validation
// ---------------------------------------------------------------------------

export const steeringDirectiveSchema = z.record(
  z.string(),
  z.number({ invalid_type_error: 'Steering strength must be a number' })
)

export const channelSteeringSchema = z.object({
  interventions: z.array(z.object({
    type: z.enum(INTERVENTION_TYPES),
    probe: z.string(),
    probe_index: z.number().int().nonnegative(),
    strength: z.number(),
    label: z.string(),
  })),
  readout_probes: z.array(z.string()),
  updated_at: z.string(),
  set_by: z.string(),
  model: z.string(),
})

// ---------------------------------------------------------------------------
// Provider params shape (what gets spread into the vLLM request body)
// ---------------------------------------------------------------------------

/** Build provider_params for vLLM from resolved steering config.
 *
 * vLLM API expects:
 *   - `intervention`: single InterventionConfig or array (field name is singular)
 *   - `probes`: null (all), [] (none), or ["setname", "setname:label", ...]
 *
 * InterventionConfig: { type, probe, probe_index, strength, renorm? }
 */
export function toProviderParams(steering: ChannelSteering): Record<string, unknown> {
  const params: Record<string, unknown> = {}

  if (steering.interventions.length > 0) {
    // vLLM field is `intervention` (singular) but accepts an array
    params.intervention = steering.interventions.map(i => ({
      type: i.type,
      probe: i.probe,
      probe_index: i.probe_index,
      strength: i.strength,
    }))
  }

  if (steering.readout_probes.length > 0) {
    params.probes = steering.readout_probes
  }

  return params
}
