/**
 * Message formatting: converts DiscordMessage[] to ParticipantMessage[]
 *
 * Handles image selection (two-tier: prefix + ephemeral), document attachments,
 * bot mention normalization, display name rewriting, and reply tag stripping.
 */

import type {
  DiscordMessage,
  ParticipantMessage,
  ContentBlock,
  CachedImage,
  CachedDocument,
  BotConfig,
} from '../../types.js'
import { prepareImage, resampleImage, MAX_IMAGE_BASE64_BYTES } from '../image-processing.js'
import { rewriteMentionsForDisplayNames, stripReplyTags } from './mentions.js'
import { logger } from '../../utils/logger.js'

/**
 * Convert Discord messages to participant-based LLM format.
 *
 * This is the core transformation: raw Discord messages become structured
 * ParticipantMessages with embedded images, documents, and normalized mentions.
 */
export async function formatMessages(
  messages: DiscordMessage[],
  images: CachedImage[],
  documents: CachedDocument[],
  config: BotConfig,
  botDiscordUsername?: string,
  cacheMarkerMessageId?: string | null
): Promise<ParticipantMessage[]> {
  const participantMessages: ParticipantMessage[] = []

  // Create image lookup
  const imageMap = new Map(images.map((img) => [img.url, img]))

  // Create document lookup by messageId
  const documentsByMessageId = new Map<string, CachedDocument[]>()
  for (const doc of documents) {
    if (!documentsByMessageId.has(doc.messageId)) {
      documentsByMessageId.set(doc.messageId, [])
    }
    documentsByMessageId.get(doc.messageId)!.push(doc)
  }

  const max_images = config.max_images || 5
  const maxTotalBase64Bytes = 15 * 1024 * 1024  // 15 MB total base64 data for images

  // Find cache marker position for image selection anchoring
  const cacheMarkerIndex = cacheMarkerMessageId
    ? messages.findIndex(m => m.id === cacheMarkerMessageId)
    : -1

  const cacheImages = config.cache_images ?? false
  const maxEphemeralImages = config.max_ephemeral_images ?? max_images

  logger.debug({
    messageCount: messages.length,
    cachedImages: images.length,
    imageUrls: images.map(i => i.url),
    include_images: config.include_images,
    cache_images: cacheImages,
    max_images,
    maxEphemeralImages,
    maxTotalImageMB: maxTotalBase64Bytes / 1024 / 1024,
    cacheMarkerMessageId,
    cacheMarkerIndex,
  }, 'Starting image selection')

  const messagesWithImages = new Set<string>()
  if (config.include_images) {
    let prefixImageCount = 0
    let ephemeralImageCount = 0
    let totalBase64Size = 0

    // TIER 1: Images in cached prefix (only if cache_images is enabled)
    if (cacheImages) {
      const prefixEndIndex = cacheMarkerIndex >= 0 ? cacheMarkerIndex + 1 : messages.length
      for (let i = prefixEndIndex - 1; i >= 0 && prefixImageCount < max_images; i--) {
        const msg = messages[i]!
        for (const attachment of msg.attachments) {
          if (prefixImageCount >= max_images) break

          if (attachment.contentType?.startsWith('image/')) {
            const cached = imageMap.get(attachment.url)
            if (cached) {
              const rawBase64Size = Math.ceil(cached.data.length * 4 / 3)
              const base64Size = rawBase64Size > MAX_IMAGE_BASE64_BYTES
                ? MAX_IMAGE_BASE64_BYTES
                : rawBase64Size

              if (totalBase64Size + base64Size <= maxTotalBase64Bytes) {
                messagesWithImages.add(msg.id)
                prefixImageCount++
                totalBase64Size += base64Size
                logger.debug({
                  messageId: msg.id,
                  rawMB: (rawBase64Size / 1024 / 1024).toFixed(2),
                  budgetMB: (base64Size / 1024 / 1024).toFixed(2),
                  totalMB: (totalBase64Size / 1024 / 1024).toFixed(2),
                  prefixImageCount,
                  tier: 'cached-prefix',
                }, 'Selected image for cached prefix (cache_images enabled)')
              }
            }
          }
        }
      }
    }

    // TIER 2: Images in rolling window (always enabled when include_images is true)
    const ephemeralStartIndex = cacheMarkerIndex >= 0 ? cacheMarkerIndex : 0
    for (let i = messages.length - 1; i >= ephemeralStartIndex && ephemeralImageCount < maxEphemeralImages; i--) {
      const msg = messages[i]!

      // Skip if already selected in TIER 1
      if (messagesWithImages.has(msg.id)) continue

      for (const attachment of msg.attachments) {
        if (ephemeralImageCount >= maxEphemeralImages) break

        if (attachment.contentType?.startsWith('image/')) {
          const cached = imageMap.get(attachment.url)
          if (cached) {
            const rawBase64Size = Math.ceil(cached.data.length * 4 / 3)
            const base64Size = rawBase64Size > MAX_IMAGE_BASE64_BYTES
              ? MAX_IMAGE_BASE64_BYTES
              : rawBase64Size
            if (totalBase64Size + base64Size <= maxTotalBase64Bytes) {
              messagesWithImages.add(msg.id)
              ephemeralImageCount++
              totalBase64Size += base64Size
              logger.debug({
                messageId: msg.id,
                rawMB: (rawBase64Size / 1024 / 1024).toFixed(2),
                budgetMB: (base64Size / 1024 / 1024).toFixed(2),
                totalMB: (totalBase64Size / 1024 / 1024).toFixed(2),
                ephemeralImageCount,
                tier: 'ephemeral',
              }, 'Selected image for rolling window (ephemeral)')
            }
          }
        }
      }
    }

    logger.debug({
      selectedCount: messagesWithImages.size,
      prefixImages: prefixImageCount,
      ephemeralImages: ephemeralImageCount,
      totalMB: (totalBase64Size / 1024 / 1024).toFixed(2),
      cacheImages,
      hasCacheMarker: cacheMarkerIndex >= 0,
    }, 'Image selection complete')
  }

  // Build username -> display name map for mention rewriting
  const usernameToDisplayName = new Map<string, string>()
  if (config.use_display_names) {
    for (const msg of messages) {
      if (msg.author.username !== msg.author.displayName) {
        usernameToDisplayName.set(msg.author.username, msg.author.displayName)
      }
    }
  }

  // Process messages in order, only including pre-selected images
  for (const msg of messages) {
    const content: ContentBlock[] = []

    // Add text content
    if (msg.content.trim()) {
      content.push({
        type: 'text',
        text: msg.content,
      })
    }

    const docAttachments = documentsByMessageId.get(msg.id)
    if (docAttachments && docAttachments.length > 0) {
      for (const doc of docAttachments) {
        const truncatedNotice = doc.truncated ? '\n[Attachment truncated]' : ''
        content.push({
          type: 'text',
          text: `📎 ${doc.filename}\n${doc.text}${truncatedNotice}`,
        })
      }
    }

    // Add image content only for pre-selected messages
    if (config.include_images && messagesWithImages.has(msg.id)) {
      logger.debug({ messageId: msg.id, attachments: msg.attachments.length }, 'Adding pre-selected images for message')

      for (const attachment of msg.attachments) {
        if (attachment.contentType?.startsWith('image/')) {
          const cached = imageMap.get(attachment.url)

          if (cached) {
            let imageData = cached.data
            let mediaType = cached.mediaType
            let imgWidth = cached.width || 1024
            let imgHeight = cached.height || 1024

            try {
              const prepared = await prepareImage(imageData, mediaType)
              imageData = prepared.data
              mediaType = prepared.mediaType
              imgWidth = prepared.width
              imgHeight = prepared.height
            } catch (error) {
              logger.warn({ error, messageId: msg.id }, 'Failed to prepare image, using original')
            }

            const originalBase64Size = imageData.length * 4 / 3

            if (originalBase64Size > MAX_IMAGE_BASE64_BYTES) {
              try {
                const resampled = await resampleImage(imageData, MAX_IMAGE_BASE64_BYTES)
                imageData = resampled.data
                mediaType = resampled.mediaType
                imgWidth = resampled.width
                imgHeight = resampled.height
                logger.info({
                  messageId: msg.id,
                  originalMB: (originalBase64Size / 1024 / 1024).toFixed(2),
                  resampledMB: (imageData.length * 4 / 3 / 1024 / 1024).toFixed(2),
                }, 'Resampled oversized image')
              } catch (error) {
                logger.warn({ error, messageId: msg.id }, 'Failed to resample image, skipping')
                continue
              }
            }

            const base64Data = imageData.toString('base64')

            // Final safety net: skip if still over the 5MB API limit after resampling
            if (imageData.length > MAX_IMAGE_BASE64_BYTES) {
              logger.warn({
                messageId: msg.id,
                url: attachment.url,
                rawSizeMB: (imageData.length / 1024 / 1024).toFixed(2),
              }, 'Image still exceeds 5MB after resampling, skipping')
              continue
            }

            const tokenEstimate = Math.ceil((imgWidth * imgHeight) / 750)

            content.push({
              type: 'image',
              source: {
                type: 'base64',
                data: base64Data,
                media_type: mediaType,
              },
              tokenEstimate,
              sourceUrl: attachment.url,
            } as any)

            logger.debug({
              messageId: msg.id,
              url: attachment.url,
              sizeMB: (base64Data.length / 1024 / 1024).toFixed(2),
              dimensions: `${imgWidth}x${imgHeight}`,
              tokenEstimate,
            }, 'Added image to content')
          }
        }
      }
    }

    // Add text document content in XML blocks
    if (config.include_text_attachments !== false) {
      const maxSizeBytes = (config.max_text_attachment_kb || 200) * 1024
      const msgDocuments = documentsByMessageId.get(msg.id) || []

      for (const doc of msgDocuments) {
        if (doc.size <= maxSizeBytes) {
          const truncatedNote = doc.truncated ? ' [truncated]' : ''
          const xmlContent = `<attachment filename="${doc.filename}"${truncatedNote}>\n${doc.text}\n</attachment>`
          content.push({
            type: 'text',
            text: xmlContent,
          })
          logger.debug({
            messageId: msg.id,
            filename: doc.filename,
            sizeKB: (doc.size / 1024).toFixed(2),
            truncated: doc.truncated
          }, 'Added text document to content')
        } else {
          logger.debug({
            messageId: msg.id,
            filename: doc.filename,
            sizeKB: (doc.size / 1024).toFixed(2),
            maxKB: config.max_text_attachment_kb || 200
          }, 'Skipped text document (too large)')
        }
      }
    }

    // For bot's own messages, use config.name for consistent LLM context
    const isBotMessage = botDiscordUsername && msg.author.username === botDiscordUsername
    const participantName = config.use_display_names ? msg.author.displayName : msg.author.username
    const participant = isBotMessage ? config.name : participantName

    // Normalize mentions and replies to this bot to use config.name
    if (botDiscordUsername && botDiscordUsername !== config.name) {
      const escapedUsername = botDiscordUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const mentionPattern = new RegExp(`<@${escapedUsername}>`, 'g')
      const replyPattern = new RegExp(`<reply:@${escapedUsername}>`, 'g')
      for (const block of content) {
        if (block.type === 'text') {
          block.text = block.text
            .replace(mentionPattern, `<@${config.name}>`)
            .replace(replyPattern, `<reply:@${config.name}>`)
        }
      }
    }

    // When use_display_names is enabled, rewrite mentions to use display names
    if (config.use_display_names) {
      rewriteMentionsForDisplayNames(content, usernameToDisplayName, config.name)
    }

    // Strip reply tags from context if configured
    if (!config.include_reply_tags) {
      stripReplyTags(content)
    }

    // Skip messages with no usable content (sticker-only, embed-only, etc.)
    if (content.length === 0) continue

    participantMessages.push({
      participant,
      content,
      timestamp: msg.timestamp,
      messageId: msg.id,
    })
  }

  // Limit images if needed
  if (config.include_images && config.max_images > 0) {
    limitImages(participantMessages, config.max_images)
  }

  return participantMessages
}

/**
 * Remove oldest images from participant messages if over the limit.
 */
export function limitImages(messages: ParticipantMessage[], max_images: number): void {
  let imageCount = 0
  const imagePositions: Array<{ msgIndex: number; contentIndex: number }> = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j]!.type === 'image') {
        imageCount++
        imagePositions.push({ msgIndex: i, contentIndex: j })
      }
    }
  }

  if (imageCount > max_images) {
    const toRemove = imageCount - max_images
    for (let i = 0; i < toRemove; i++) {
      const pos = imagePositions[i]!
      messages[pos.msgIndex]!.content.splice(pos.contentIndex, 1)
    }
  }
}
