import { createHash } from 'crypto'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { logger } from './logger.js'

const BLOB_DIR = process.env.BLOB_DIR || './logs/blobs'

function ensureBlobDir(): void {
  if (!existsSync(BLOB_DIR)) {
    mkdirSync(BLOB_DIR, { recursive: true })
  }
}

function hashContent(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function storeBlob(data: string, mediaType?: string): string {
  ensureBlobDir()
  
  const hash = hashContent(data)
  const extension = mediaType?.split('/')[1] || 'bin'
  const filename = `${hash}.${extension}`
  const filepath = join(BLOB_DIR, filename)
  
  if (!existsSync(filepath)) {
    writeFileSync(filepath, data, 'utf-8')
    logger.debug({ hash, mediaType, size: data.length }, 'Stored new blob')
  }
  
  return hash
}

export function readBlob(hash: string, extension = 'bin'): string | null {
  const filepath = join(BLOB_DIR, `${hash}.${extension}`)
  if (!existsSync(filepath)) {
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

export function blobExists(hash: string): boolean {
  for (const ext of ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bin']) {
    if (existsSync(join(BLOB_DIR, `${hash}.${ext}`))) {
      return true
    }
  }
  return false
}

export interface ImageBlobRef {
  type: 'image'
  source: {
    type: 'blob_ref'
    blob_hash: string
    media_type: string
    original_size: number
  }
}

export function extractAndStoreImages(content: any): any {
  if (!Array.isArray(content)) {
    return content
  }
  
  return content.map(block => {
    if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
      const hash = storeBlob(block.source.data, block.source.media_type)
      
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
    
    if (block.type === 'image_url' && block.image_url?.url?.startsWith('data:')) {
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

export function processSystemForLogging(system: string | any[] | undefined): string | any[] | undefined {
  if (!system) return system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return extractAndStoreImages(system)
  }
  return system
}

export function processRequestForLogging(params: any): any {
  const processed = { ...params }
  
  if (params.messages) {
    processed.messages = processMessagesForLogging(params.messages)
  }
  
  if (params.system) {
    processed.system = processSystemForLogging(params.system)
  }
  
  return processed
}

