/**
 * Character RAG Plugin
 *
 * Injects relevant character context from pre-indexed .chr files
 * into the LLM context using embedding-based retrieval.
 *
 * Requires:
 * - Pre-computed index files (index_vectors.npy + index_chunks.json)
 * - Running embed server (FastAPI on Mac Studio or similar)
 *
 * Config (via plugin_config.character in bot YAML):
 *   index_path: /path/to/chr_data
 *   embed_url: http://host:6009
 *   embed_model: mixedbread-ai/mxbai-embed-large-v1
 *   top_k: 20
 *   recent_messages: 7
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { ToolPlugin, PluginStateContext, ContextInjection } from './types.js'

// Module-level cache: index_path → { vectors, chunks }
const indexCache = new Map<string, { vectors: Float64Array, chunks: string[], dim: number }>()

function loadIndex(indexPath: string): { vectors: Float64Array, chunks: string[], dim: number } {
  const cached = indexCache.get(indexPath)
  if (cached) return cached

  // Load chunks
  const chunksData = readFileSync(join(indexPath, 'index_chunks.json'), 'utf-8')
  const chunks: string[] = JSON.parse(chunksData)

  // Load numpy .npy file (float64, C-contiguous)
  const npyBuffer = readFileSync(join(indexPath, 'index_vectors.npy'))
  const { data, shape } = parseNpy(npyBuffer)
  const dim = shape[1]!

  const entry = { vectors: data, chunks, dim }
  indexCache.set(indexPath, entry)
  return entry
}

/**
 * Minimal .npy parser for float64 2D arrays.
 * Handles numpy format 1.0 with fortran_order=False.
 */
function parseNpy(buffer: Buffer): { data: Float64Array, shape: number[] } {
  // Magic: \x93NUMPY
  const headerLen = buffer.readUInt16LE(8)
  const headerStr = buffer.subarray(10, 10 + headerLen).toString('ascii')

  // Parse shape from header like "{'descr': '<f8', 'fortran_order': False, 'shape': (9187, 1024), }"
  const shapeMatch = headerStr.match(/\((\d+),\s*(\d+)\)/)
  if (!shapeMatch) throw new Error('Cannot parse .npy shape from header: ' + headerStr)
  const shape = [parseInt(shapeMatch[1]!), parseInt(shapeMatch[2]!)]

  const dataOffset = 10 + headerLen
  const data = new Float64Array(buffer.buffer, buffer.byteOffset + dataOffset, shape[0]! * shape[1]!)
  return { data, shape }
}

/**
 * Query the embed server for a vector embedding.
 */
async function embedQuery(url: string, model: string, text: string): Promise<Float64Array> {
  const response = await fetch(`${url}/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text] }),
  })

  if (!response.ok) {
    throw new Error(`Embed server error: ${response.status} ${await response.text()}`)
  }

  const arrayBuf = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)
  const { data } = parseNpy(buffer)
  return data
}

/**
 * Cosine similarity search. Vectors are assumed L2-normalized.
 */
function searchTopK(
  queryVec: Float64Array,
  indexVecs: Float64Array,
  dim: number,
  topK: number
): number[] {
  const n = indexVecs.length / dim
  const scores = new Float64Array(n)

  // Normalize query
  let qNorm = 0
  for (let i = 0; i < dim; i++) qNorm += queryVec[i]! * queryVec[i]!
  qNorm = Math.sqrt(qNorm)

  // Dot product (index vectors already normalized from numpy)
  for (let row = 0; row < n; row++) {
    let dot = 0
    const offset = row * dim
    for (let i = 0; i < dim; i++) {
      dot += (queryVec[i]! / qNorm) * indexVecs[offset + i]!
    }
    scores[row] = dot
  }

  // Top-K via partial sort
  const indices = Array.from({ length: n }, (_, i) => i)
  indices.sort((a, b) => scores[b]! - scores[a]!)
  return indices.slice(0, topK)
}

const characterPlugin: ToolPlugin = {
  name: 'character',
  description: 'RAG character context injection from pre-indexed .chr files',
  tools: [],

  onInit: async (context: PluginStateContext) => {
    const config = context.pluginConfig
    if (!config?.index_path) return
    try {
      loadIndex(config.index_path)
    } catch (e) {
      console.warn('[character plugin] Failed to load index:', e)
    }
  },

  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = context.pluginConfig
    if (!config?.index_path || !config?.embed_url || !config?.embed_model) {
      return []
    }

    // Get recent messages passed from the agent loop
    const recentMessages: string[] | undefined = config._recentMessages
    if (!recentMessages || recentMessages.length === 0) return []

    try {
      // Load index (cached after first call)
      const { vectors, chunks, dim } = loadIndex(config.index_path)

      // Build query from recent messages
      const query = recentMessages.slice(-(config.recent_messages || 7)).join('\n')

      // Embed query
      const queryVec = await embedQuery(config.embed_url, config.embed_model, query)

      // Search
      const topK = config.top_k || 20
      const topIndices = searchTopK(queryVec, vectors, dim, topK)

      // Format results
      const separator = config.separator || '###'
      const resultChunks = topIndices.map(i => chunks[i]!)
      const content = resultChunks.join(`\n${separator}\n`)

      return [{
        id: 'character-context',
        content,
        targetDepth: -1,
        priority: 50,
      }]
    } catch (e) {
      console.warn('[character plugin] RAG query failed:', e)
      return []
    }
  },
}

export default characterPlugin
