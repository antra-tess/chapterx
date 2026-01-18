/**
 * Share Image Plugin
 *
 * Allows bots to share images from their context to Discord.
 * Images are referenced by index (1 = most recent).
 *
 * This includes:
 * - Images from Discord messages in context
 * - Images from MCP tool results (which are normally hidden)
 *
 * Tools:
 * - share_image: Share an image by index to the current channel
 * - list_visible_images: List all images the bot can see
 */

import { ToolPlugin, PluginTool, PluginContext } from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger({ plugin: 'share-image' })

interface ShareImageInput {
  index: number
  caption?: string
}

const shareImageTool: PluginTool = {
  name: 'share_image',
  description: 'Share an image from your context to the current Discord channel. Use list_visible_images first to see what images are available. Index 1 = most recent image.',
  inputSchema: {
    type: 'object',
    properties: {
      index: {
        type: 'number',
        description: 'Image index (1 = most recent, 2 = second most recent, etc.)',
      },
      caption: {
        type: 'string',
        description: 'Optional caption to include with the image',
      },
    },
    required: ['index'],
  },
  handler: async (input: ShareImageInput, context: PluginContext): Promise<string> => {
    const { index, caption } = input
    const visibleImages = context.visibleImages || []

    if (visibleImages.length === 0) {
      return 'No images available in context. There are no images from Discord messages or MCP tools visible.'
    }

    if (index < 1 || index > visibleImages.length) {
      return `Invalid index ${index}. Available images: 1-${visibleImages.length}. Use list_visible_images to see details.`
    }

    const image = visibleImages[index - 1]!
    
    logger.info({
      index,
      source: image.source,
      sourceDetail: image.sourceDetail,
      mimeType: image.mimeType,
      dataLength: image.data.length,
      channelId: context.channelId,
    }, 'Sharing image to Discord')

    if (!context.uploadFile) {
      return 'Error: File upload not available in this context.'
    }

    try {
      // Convert base64 to buffer
      const buffer = Buffer.from(image.data, 'base64')
      
      // Generate filename based on source
      const ext = getExtensionFromMime(image.mimeType)
      const filename = image.source === 'discord' 
        ? `shared_image_${index}${ext}`
        : `${image.sourceDetail}_image_${index}${ext}`
      
      // Build caption with source info if not provided
      const fullCaption = caption || `Image ${index} (from ${image.source === 'discord' ? image.sourceDetail : `${image.sourceDetail} tool`})`
      
      await context.uploadFile(buffer, filename, image.mimeType, fullCaption)
      
      return `Successfully shared image ${index} to Discord.`
    } catch (error: any) {
      logger.error({ error: error.message, index }, 'Failed to share image')
      return `Error sharing image: ${error.message}`
    }
  },
}

const listVisibleImagesTool: PluginTool = {
  name: 'list_visible_images',
  description: 'List all images currently visible in your context. Shows index, source, and description for each image.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_input: any, context: PluginContext): Promise<string> => {
    const visibleImages = context.visibleImages || []

    if (visibleImages.length === 0) {
      return 'No images visible in context. There are no images from Discord messages or MCP tool results.'
    }

    const lines = visibleImages.map((img, i) => {
      const idx = i + 1
      const source = img.source === 'discord' 
        ? `Discord (${img.sourceDetail})`
        : `MCP tool: ${img.sourceDetail}`
      const desc = img.description ? ` - ${img.description}` : ''
      const size = Math.round(img.data.length * 0.75 / 1024) // Approximate decoded size in KB
      return `${idx}. [${img.mimeType}] ${source}${desc} (~${size}KB)`
    })

    return `Visible images (${visibleImages.length} total, newest first):\n${lines.join('\n')}\n\nUse share_image with an index to share any of these to Discord.`
  },
}

function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  }
  return mimeToExt[mimeType] || '.png'
}

const plugin: ToolPlugin = {
  name: 'share-image',
  description: 'Share images from context (Discord messages or MCP tool results) to Discord',
  tools: [listVisibleImagesTool, shareImageTool],
}

export default plugin
