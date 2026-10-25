import { z } from 'zod'

export interface ProbeSetEntry {
  description: string
  labels: Record<string, number>
}

export type ProbeCatalog = Record<string, ProbeSetEntry>

export type SteeringDirective = Record<string, number>

export const INTERVENTION_TYPES = ['steer', 'floor', 'ceil'] as const
export type InterventionType = typeof INTERVENTION_TYPES[number]

export interface SteeringIntervention {
  type: InterventionType
  probe: string
  probe_index: number
  strength: number
  label: string
}

export interface ChannelSteering {
  interventions: SteeringIntervention[]
  readout_probes: string[]
  updated_at: string
  set_by: string
  model: string
}

export interface ParsedSteerMessage {
  target: string
  directives: SteeringDirective
  readout_probes: string[]
}

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

/**
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
      renorm: true,
    }))
  }

  if (steering.readout_probes.length > 0) {
    params.probes = steering.readout_probes
  }

  return params
}
