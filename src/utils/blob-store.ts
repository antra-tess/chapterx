/**
 * Blob Store for LLM Request Logging
 * 
 * Stores images separately as content-addressed blobs to avoid
 * duplicating large base64 data in every request log.
 * 
 * Images are hashed with SHA-256 and stored once per unique hash.
 * Request logs reference images by hash instead of embedding full data.
 */

import { createHash } from 'crypto'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { logger } from './logger.js'

const BLOB_DIR = process.env.BLOB_DIR || './logs/blobs'

// Ensure blob directory exists
function ensureBlobDir(): void {
  if (!existsSync(BLOB_DIR)) {
    mkdirSync(BLOB_DIR, { recursive: true })
  }
}

/**
 * Hash content using SHA-256
 */
function hashContent(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Store a blob and return its hash
 * Returns the hash if stored successfully, or existing hash if already stored
 */
export function storeBlob(data: string, mediaType?: string): string {
  ensureBlobDir()
  
  const hash = hashContent(data)
  const extension = mediaType?.split('/')[1] || 'bin'
  const filename = `${hash}.${extension}`
  const filepath = join(BLOB_DIR, filename)
  
  // Only write if not already stored (content-addressed = idempotent)
  if (!existsSync(filepath)) {
    writeFileSync(filepath, data, 'utf-8')
    logger.debug({ hash, mediaType, size: data.length }, 'Stored new blob')
  }
  
  return hash
}

/**
 * Read a blob by hash
 */
export function readBlob(hash: string, extension = 'bin'): string | null {
  const filepath = join(BLOB_DIR, `${hash}.${extension}`)
  if (!existsSync(filepath)) {
    // Try common extensions
    for (const ext of ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bin']) {
      const altPath = join(BLOB_DIR, `${hash}.${ext}`)
      if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8')
      }
    }
    return null
  }
  return readFileSync(filepath, 'utf-8')
}

/**
 * Check if a blob exists
 */
export function blobExists(hash: string): boolean {
  // Check with common extensions
  for (const ext of ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bin']) {
    if (existsSync(join(BLOB_DIR, `${hash}.${ext}`))) {
      return true
    }
  }
  return false
}

/**
 * Image reference that replaces inline data
 */
export interface ImageBlobRef {
  type: 'image'
  source: {
    type: 'blob_ref'
    blob_hash: string
    media_type: string
    original_size: number
  }
}

/**
 * Extract and store images from message content, replacing with references
 * Returns a new content array with images replaced by blob references
 */
export function extractAndStoreImages(content: any): any {
  if (!Array.isArray(content)) {
    return content
  }
  
  return content.map(block => {
    if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
      // Store the image blob
      const hash = storeBlob(block.source.data, block.source.media_type)
      
      // Return a reference instead of the full data
      return {
        type: 'image',
        source: {
          type: 'blob_ref',
          blob_hash: hash,
          media_type: block.source.media_type,
          original_size: block.source.data.length,
        }
      } as ImageBlobRef
    }
    
    // For URL-based images, keep as-is
    if (block.type === 'image_url' && block.image_url?.url?.startsWith('data:')) {
      // OpenAI-style data URL
      const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const [, mediaType, data] = match
        const hash = storeBlob(data, mediaType)
        
        return {
          type: 'image_url',
          image_url: {
            url: `blob://${hash}`,
            detail: block.image_url.detail,
            _blob_ref: {
              hash,
              media_type: mediaType,
              original_size: data.length,
            }
          }
        }
      }
    }
    
    return block
  })
}

/**
 * Process messages array, extracting images from all messages
 */
export function processMessagesForLogging(messages: any[]): any[] {
  return messages.map(message => {
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: extractAndStoreImages(message.content)
      }
    }
    return message
  })
}

/**
 * Process system prompt (can be string or array with cache_control)
 */
export function processSystemForLogging(system: string | any[] | undefined): string | any[] | undefined {
  if (!system) return system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return extractAndStoreImages(system)
  }
  return system
}

/**
 * Process full request params for logging
 * Extracts all images and replaces with blob references
 */
export function processRequestForLogging(params: any): any {
  const processed = { ...params }
  
  // Process messages
  if (params.messages) {
    processed.messages = processMessagesForLogging(params.messages)
  }
  
  // Process system (Anthropic-style)
  if (params.system) {
    processed.system = processSystemForLogging(params.system)
  }
  
  return processed
}

