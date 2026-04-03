/**
 * Post-generation probe readout via /v1/encode.
 *
 * vLLM's probe server disables auto-reprobe during generation (CUDA graph instability).
 * To get full probe projections, we POST the response token_ids back to /v1/encode
 * after generation completes.
 *
 * The encode endpoint lives on the same base URL as the chat completions endpoint
 * (i.e., the Railway proxy, which passes through to vLLM's probe server).
 */

import { logger } from '../utils/logger.js'
import type { VendorConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Vendor credential resolution
// ---------------------------------------------------------------------------

interface VendorCredentials {
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
      // Convert glob pattern to regex: * → .*
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
// Encode call
// ---------------------------------------------------------------------------

export interface EncodeResult {
  token_probes: Record<string, number[][]>
  probe_names: Record<string, string[]>
}

/**
 * Call /v1/encode on the probe server to get full probe projections
 * for a set of token IDs.
 *
 * @param tokenIds - Response token IDs from the generation
 * @param probes - Probe set names to capture (null = all, [] = skip)
 * @param model - Model name (passed through for routing)
 * @param credentials - Base URL and API key for the endpoint
 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
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
  const body = {
    model,
    token_ids: tokenIds,
    probes,
  }

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
      logger.warn({
        status: response.status,
        statusText: response.statusText,
        url,
      }, 'Encode endpoint returned non-OK status')
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
