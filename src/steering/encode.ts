/**
 * Post-generation probe readout via proxy readout endpoint + /v1/encode.
 *
 * Flow:
 *   1. Proxy captures response_token_ids from the final SSE chunk during streaming
 *   2. After generation, ChapterX calls GET /v1/readout/{completion_id} to retrieve them
 *   3. Then POSTs /v1/encode with those token_ids to get full probe projections
 *
 * The proxy stores readout data for ~5 minutes keyed by completion ID.
 */

import { logger } from '../utils/logger.js'
import type { VendorConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Vendor credential resolution
// ---------------------------------------------------------------------------

export interface VendorCredentials {
  baseUrl: string
  apiKey: string
}

/**
 * Resolve vendor credentials (base URL + API key) for a given model name.
 * Matches model against vendor `provides` patterns (glob-style with *).
 */
export function resolveVendorForModel(
  modelName: string,
  vendors: Record<string, VendorConfig>
): VendorCredentials | null {
  for (const [vendorName, vendor] of Object.entries(vendors)) {
    if (!vendor.provides) continue

    const matches = vendor.provides.some(pattern => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i')
      return regex.test(modelName)
    })

    if (matches) {
      const config = vendor.config
      const apiKey = config?.openai_api_key
        ?? config?.open_api_key
        ?? config?.api_key
        ?? config?.openai_compatible_api_key
        ?? 'not-needed'
      const baseUrl = config?.api_base
        ?? config?.openai_compatible_base_url
        ?? config?.openai_completions_base_url

      if (!baseUrl) {
        logger.warn({ vendorName, modelName }, 'Vendor matched but has no base URL')
        continue
      }

      return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Readout data from proxy
// ---------------------------------------------------------------------------

export interface ProxyReadout {
  completion_id: string
  model: string
  response_token_ids: number[] | null
  prompt_token_ids: number[] | null
  intervention_applied: Array<{
    type: string
    probe: string
    probe_index: number
    strength: number
    renorm?: boolean
  }> | null
  probe_status: string | null
}

/**
 * Fetch readout data (response_token_ids, intervention_applied) from the proxy.
 * The proxy captures these from the final SSE chunk during streaming.
 */
export async function fetchProxyReadout(
  completionId: string,
  credentials: VendorCredentials,
  timeoutMs: number = 10000,
): Promise<ProxyReadout | null> {
  const url = `${credentials.baseUrl}/v1/readout/${encodeURIComponent(completionId)}`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${credentials.apiKey}` },
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      if (response.status !== 404) {
        logger.warn({ status: response.status, completionId }, 'Proxy readout endpoint returned error')
      }
      return null
    }

    return await response.json() as ProxyReadout
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug({ completionId }, 'Proxy readout request timed out')
    } else {
      logger.warn({ error, completionId }, 'Failed to fetch proxy readout')
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Encode call (full probe projections from token IDs)
// ---------------------------------------------------------------------------

export interface EncodeResult {
  token_probes: Record<string, number[][]>
  probe_names: Record<string, string[]>
}

/**
 * Call /v1/encode on the probe server to get full probe projections
 * for a set of token IDs.
 */
export async function fetchProbeReadout(
  tokenIds: number[],
  probes: string[] | null,
  model: string,
  credentials: VendorCredentials,
  timeoutMs: number = 30000,
): Promise<EncodeResult | null> {
  if (!tokenIds || tokenIds.length === 0) {
    logger.debug('No token IDs for encode — skipping probe readout')
    return null
  }

  const url = `${credentials.baseUrl}/v1/encode`
  const body = { model, token_ids: tokenIds, probes }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      logger.warn({ status: response.status, url }, 'Encode endpoint returned non-OK status')
      return null
    }

    const data = await response.json() as Record<string, unknown>
    return {
      token_probes: (data.token_probes as Record<string, number[][]>) || {},
      probe_names: (data.probe_names as Record<string, string[]>) || {},
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn({ url, timeoutMs }, 'Encode request timed out')
    } else {
      logger.warn({ error, url }, 'Failed to fetch probe readout from encode endpoint')
    }
    return null
  }
}
