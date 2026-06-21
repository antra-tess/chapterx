/**
 * Backend-agnostic attachment cache: download + disk-cache images, fetch text
 * attachments. Ported from DiscordConnector's image-cache logic so the portal
 * backend can produce identical CachedImage/CachedDocument without discord.js.
 *
 * (DiscordConnector keeps its own copy for now; a later refactor can point both
 * at this class.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import sharp from 'sharp'
import { logger } from '../../utils/logger.js'
import type { CachedImage, CachedDocument } from '../../types.js'

const MAX_TEXT_ATTACHMENT_BYTES = 200_000 // ~200 KB inline text per attachment

/** Minimal attachment shape (PortalAttachment maps directly). */
export interface AttachmentLike {
  url: string
  name: string
  contentType?: string | null
  size?: number
}

const TEXT_MIME = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/x-python',
]
const TEXT_EXT = [
  '.txt', '.md', '.markdown', '.rst', '.py', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sh', '.bash', '.zsh', '.fish', '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx', '.java', '.rs', '.go',
  '.rb', '.php', '.sql', '.graphql', '.gql', '.lua', '.perl', '.pl', '.r', '.R', '.swift', '.kt',
  '.kts', '.scala', '.vim', '.el', '.lisp', '.clj', '.cljs', '.ini', '.cfg', '.conf', '.config',
  '.log', '.csv', '.tsv',
]

export class AttachmentCache {
  private imageCache = new Map<string, CachedImage>()
  private urlToFilename = new Map<string, string>()
  private mapPath: string

  constructor(private cacheDir: string) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    this.mapPath = join(cacheDir, 'url-map.json')
    this.loadUrlMap()
  }

  isTextAttachment(att: AttachmentLike): boolean {
    if (att.contentType && TEXT_MIME.some((m) => att.contentType!.startsWith(m))) return true
    const name = att.name?.toLowerCase() || ''
    return TEXT_EXT.some((ext) => name.endsWith(ext))
  }

  private detectImageType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif'
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) return 'image/webp'
    return null
  }

  private async dimsAndTokens(buffer: Buffer): Promise<{ width?: number; height?: number; tokenEstimate: number }> {
    let width: number | undefined
    let height: number | undefined
    try {
      const meta = await sharp(buffer).metadata()
      width = meta.width
      height = meta.height
    } catch {
      // dimensions optional
    }
    const estW = Math.min(width || 1024, 1568)
    const estH = Math.min(height || 1024, 1568)
    return { width, height, tokenEstimate: Math.ceil((estW * estH) / 750) }
  }

  /** True if `url` is already cached (memory or disk-map). */
  has(url: string): boolean {
    return this.imageCache.has(url) || this.urlToFilename.has(url)
  }

  async cacheImage(url: string, _contentType: string): Promise<CachedImage | null> {
    const mem = this.imageCache.get(url)
    if (mem) return mem

    // Disk cache via url→filename map.
    const cachedFilename = this.urlToFilename.get(url)
    if (cachedFilename) {
      const filepath = join(this.cacheDir, cachedFilename)
      if (existsSync(filepath)) {
        try {
          const buffer = readFileSync(filepath)
          const hash = cachedFilename.split('.')[0] || ''
          const ext = cachedFilename.split('.')[1] || 'jpg'
          const { width, height, tokenEstimate } = await this.dimsAndTokens(buffer)
          const cached: CachedImage = { url, data: buffer, mediaType: `image/${ext}`, hash, width, height, tokenEstimate }
          this.imageCache.set(url, cached)
          return cached
        } catch (error) {
          logger.warn({ error, url, filepath }, 'portal: failed to read cached image from disk')
        }
      }
    }

    // Download (cache miss).
    try {
      const response = await fetch(url)
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'portal: image download failed')
        return null
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      const detectedType = this.detectImageType(buffer)
      if (!detectedType) {
        logger.warn({ url, bufferSize: buffer.length }, 'portal: no valid image magic bytes, skipping')
        return null
      }
      const hash = createHash('sha256').update(buffer).digest('hex')
      const ext = detectedType.split('/')[1] || 'jpg'
      const filename = `${hash}.${ext}`
      const filepath = join(this.cacheDir, filename)
      if (!existsSync(filepath)) writeFileSync(filepath, buffer)
      this.urlToFilename.set(url, filename)
      const { width, height, tokenEstimate } = await this.dimsAndTokens(buffer)
      const cached: CachedImage = { url, data: buffer, mediaType: detectedType, hash, width, height, tokenEstimate }
      this.imageCache.set(url, cached)
      return cached
    } catch (error) {
      logger.warn({ error, url }, 'portal: failed to cache image')
      return null
    }
  }

  async fetchTextAttachment(att: AttachmentLike, messageId: string): Promise<CachedDocument | null> {
    if (att.size && att.size > MAX_TEXT_ATTACHMENT_BYTES * 4) {
      logger.warn({ size: att.size, url: att.url }, 'portal: skipping oversized text attachment')
      return null
    }
    try {
      const response = await fetch(att.url)
      if (!response.ok) {
        logger.warn({ status: response.status, url: att.url }, 'portal: failed to fetch text attachment')
        return null
      }
      let buffer = Buffer.from(await response.arrayBuffer())
      let truncated = false
      if (buffer.length > MAX_TEXT_ATTACHMENT_BYTES) {
        buffer = buffer.subarray(0, MAX_TEXT_ATTACHMENT_BYTES)
        truncated = true
      }
      return {
        messageId,
        url: att.url,
        filename: att.name || 'attachment.txt',
        contentType: att.contentType || 'text/plain',
        size: att.size ?? buffer.length,
        text: buffer.toString('utf-8'),
        truncated,
      }
    } catch (error) {
      logger.warn({ error, url: att.url }, 'portal: failed to download text attachment')
      return null
    }
  }

  private loadUrlMap(): void {
    try {
      if (existsSync(this.mapPath)) {
        const raw = JSON.parse(readFileSync(this.mapPath, 'utf-8')) as Record<string, string>
        this.urlToFilename = new Map(Object.entries(raw))
      }
    } catch (error) {
      logger.warn({ error, mapPath: this.mapPath }, 'portal: failed to load url map')
    }
  }

  saveUrlMap(): void {
    try {
      writeFileSync(this.mapPath, JSON.stringify(Object.fromEntries(this.urlToFilename)))
    } catch (error) {
      logger.warn({ error, mapPath: this.mapPath }, 'portal: failed to save url map')
    }
  }
}
