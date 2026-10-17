/**
 * Upload Plugin
 * 
 * Provides tools for uploading files (images, videos, etc.) to Discord.
 * Useful for sharing outputs from MCP tools like video generation.
 * 
 * Tools:
 * - upload_file_to_discord: Upload a file from URL or local path to current channel
 */

import { ToolPlugin, PluginTool, PluginContext } from './types.js'
import { createLogger } from '../../utils/logger.js'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename } from 'path'

const logger = createLogger({ plugin: 'upload' })

// Discord file size limits
const DISCORD_FILE_LIMIT_BYTES = 25 * 1024 * 1024  // 25MB (conservative, actual varies by server boost)

interface UploadFileInput {
  url?: string
  path?: string  // Local file path
  filename?: string
  caption?: string
}

const uploadFileTool: PluginTool = {
  name: 'upload_file_to_discord',
  description: 'Upload a file to the current Discord channel. Supports both URLs and local file paths. Useful for sharing outputs from tools like video generation (use path for files saved by download_video). Max size: 25MB.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to download the file from (use this OR path, not both)',
      },
      path: {
        type: 'string',
        description: 'Local file path to upload (use this OR url, not both). Use this for files saved by other tools like download_video.',
      },
      filename: {
        type: 'string',
        description: 'Optional filename for the upload (will be inferred from URL/path if not provided)',
      },
      caption: {
        type: 'string',
        description: 'Optional caption/message to include with the file',
      },
    },
    required: [],
  },
  handler: async (input: UploadFileInput, context: PluginContext): Promise<string> => {
    const { url, path, filename, caption } = input
    
    if (!url && !path) {
      return 'Error: Must provide either url or path parameter.'
    }
    
    logger.info({ url, path, filename, channelId: context.channelId }, 'Uploading file to Discord')
    
    try {
      let buffer: Buffer
      let contentType = 'application/octet-stream'
      let finalFilename = filename
      
      if (path) {
        // Load from local file
        if (!existsSync(path)) {
          return `Error: File not found: ${path}`
        }
        
        buffer = await readFile(path)
        
        // Infer filename from path
        if (!finalFilename) {
          finalFilename = basename(path)
        }
        
        // Infer content type from extension
        const ext = finalFilename.split('.').pop()?.toLowerCase()
        if (ext) {
          contentType = getMimeFromExtension(ext)
        }
        
      } else if (url) {
        // Download from URL
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`Failed to download: HTTP ${response.status} ${response.statusText}`)
        }
        
        contentType = response.headers.get('content-type') || 'application/octet-stream'
        const contentLength = response.headers.get('content-length')
        
        // Check file size before downloading fully
        if (contentLength && parseInt(contentLength) > DISCORD_FILE_LIMIT_BYTES) {
          const sizeMB = (parseInt(contentLength) / 1024 / 1024).toFixed(1)
          return `Error: File too large (${sizeMB}MB). Discord limit is ~25MB.`
        }
        
        const arrayBuffer = await response.arrayBuffer()
        buffer = Buffer.from(arrayBuffer)
        
        // Infer filename from URL
        if (!finalFilename) {
          const urlPath = new URL(url).pathname
          finalFilename = urlPath.split('/').pop() || 'file'
          
          // Add extension based on content type if missing
          if (!finalFilename.includes('.')) {
            const ext = getExtensionFromMime(contentType)
            if (ext) finalFilename += ext
          }
        }
      } else {
        return 'Error: Must provide either url or path parameter.'
      }
      
      // Check actual size
      if (buffer.length > DISCORD_FILE_LIMIT_BYTES) {
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(1)
        return `Error: File too large (${sizeMB}MB). Discord limit is ~25MB.`
      }
      
      // Upload file to Discord
      if (context.uploadFile) {
        const messageIds = await context.uploadFile(
          buffer,
          finalFilename!,
          contentType,
          caption
        )
        
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2)
        logger.info({ 
          filename: finalFilename, 
          size: buffer.length, 
          messageIds,
          channelId: context.channelId 
        }, 'File uploaded to Discord')
        
        return `Successfully uploaded ${finalFilename} (${sizeMB}MB) to Discord.`
      }
      
      // Fallback: return info about the file (upload not available)
      const sizeMB = (buffer.length / 1024 / 1024).toFixed(2)
      return `File ready (${finalFilename}, ${sizeMB}MB) but upload not available in this context.`
      
    } catch (error: any) {
      logger.error({ error: error.message, url, path }, 'Failed to upload file')
      return `Error uploading file: ${error.message}`
    }
  },
}

function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
  }
  return mimeToExt[mimeType] || ''
}

function getMimeFromExtension(ext: string): string {
  const extToMime: Record<string, string> = {
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'pdf': 'application/pdf',
    'zip': 'application/zip',
  }
  return extToMime[ext] || 'application/octet-stream'
}

const plugin: ToolPlugin = {
  name: 'upload',
  description: 'Upload files (images, videos) to Discord',
  tools: [uploadFileTool],
}

export default plugin
