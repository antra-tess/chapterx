import type {
  DiscordMessage,
  ParticipantMessage,
  ContentBlock,
  CachedImage,
  CachedDocument,
  BotConfig,
  ImageContent,
} from '../../types.js'
import { prepareImage, resampleImage, MAX_IMAGE_BASE64_BYTES } from '../image-processing.js'
import { rewriteMentionsForDisplayNames, applyMentionFormat, stripReplyTags } from './mentions.js'
import { uncarriedAttachmentLine } from './attachment-lines.js'
import { logger } from '../../utils/logger.js'

export function characterOverride(content: string): { name: string; text: string } {
  const leadIn = content.match(/^(?:<reply:@[^>]+>\s*)?(?:<@[^>]+>\s*)*/)?.[0] ?? ''
  const afterLeadIn = content.slice(leadIn.length)
  const match = afterLeadIn.match(/^~([^:\n]+):\s?/)
  const name = match ? match[1]!.trim() : ''
  return { name, text: name ? leadIn + afterLeadIn.slice(match![0].length) : content }
}

export async function formatMessages(
  messages: DiscordMessage[],
  images: CachedImage[],
  documents: CachedDocument[],
  config: BotConfig,
  botDiscordUsername?: string,
  cacheMarkerMessageId?: string | null
): Promise<ParticipantMessage[]> {
  const participantMessages: ParticipantMessage[] = []

  const imageMap = new Map(images.map((img) => [img.url, img]))

  const documentsByMessageId = new Map<string, CachedDocument[]>()
  for (const doc of documents) {
    if (!documentsByMessageId.has(doc.messageId)) {
      documentsByMessageId.set(doc.messageId, [])
    }
    documentsByMessageId.get(doc.messageId)!.push(doc)
  }

  const max_images = config.max_images || 5
  const maxTotalBase64Bytes = 15 * 1024 * 1024

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
  const imageLines = new Map<string, string>()
  if (config.include_images) {
    let prefixImageCount = 0
    let ephemeralImageCount = 0
    let totalBase64Size = 0

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

    const ephemeralStartIndex = cacheMarkerIndex >= 0 ? cacheMarkerIndex : 0
    for (let i = messages.length - 1; i >= ephemeralStartIndex && ephemeralImageCount < maxEphemeralImages; i--) {
      const msg = messages[i]!

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

  const botsUseDisplay = config.use_display_names_bots ?? config.use_display_names ?? true
  const humansUseDisplay = config.use_display_names_humans ?? config.use_display_names ?? false
  const anyDisplayNames = botsUseDisplay || humansUseDisplay

  const usernameToDisplayName = new Map<string, string>()
  if (anyDisplayNames) {
    for (const msg of messages) {
      const useForThis = msg.author.bot ? botsUseDisplay : humansUseDisplay
      if (useForThis && msg.author.username !== msg.author.displayName) {
        usernameToDisplayName.set(msg.author.username, msg.author.displayName)
      }
    }
  }

  for (const msg of messages) {
    const content: ContentBlock[] = []
    const carried = new Set<string>()

    // The connector prepends a reply tag for replies (`<reply:@user> `), and
    // Discord messages can start with mentions (`<@user> `), so the prefix may
    // not be the literal first character.
    const { name: overrideParticipant, text: messageText } = characterOverride(msg.content)

    if (messageText.trim()) {
      content.push({
        type: 'text',
        text: messageText,
      })
    }

    const docAttachments = documentsByMessageId.get(msg.id)
    if (docAttachments && docAttachments.length > 0) {
      for (const doc of docAttachments) {
        carried.add(doc.url)
        const truncatedNotice = doc.truncated ? '\n[Attachment truncated]' : ''
        content.push({
          type: 'text',
          text: `📎 ${doc.filename}\n${doc.text}${truncatedNotice}`,
        })
      }
    }

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
            carried.add(attachment.url)
            imageLines.set(attachment.url, uncarriedAttachmentLine(attachment))

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

    const isBotMessage = botDiscordUsername && msg.author.username === botDiscordUsername
    const participantName = (msg.author.bot ? botsUseDisplay : humansUseDisplay)
      ? msg.author.displayName
      : msg.author.username
    const participant = overrideParticipant
      ? overrideParticipant
      : isBotMessage
        ? config.name
        : participantName

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

    if (config.mention_format) {
      applyMentionFormat(
        content,
        config.mention_format,
        anyDisplayNames ? usernameToDisplayName : undefined,
        config.name
      )
    } else if (anyDisplayNames) {
      rewriteMentionsForDisplayNames(content, usernameToDisplayName, config.name)
    }

    if (!config.include_reply_tags) {
      stripReplyTags(content)
    }

    for (const attachment of msg.attachments) {
      if (carried.has(attachment.url)) continue
      content.push({ type: 'text', text: uncarriedAttachmentLine(attachment) })
    }

    if (content.length === 0) continue

    participantMessages.push({
      participant,
      content,
      timestamp: msg.timestamp,
      messageId: msg.id,
      isBot: msg.author.bot,
      isCharacterOverride: overrideParticipant ? true : undefined,
    })
  }

  if (config.include_images && config.max_images > 0) {
    limitImages(participantMessages, config.max_images, (sourceUrl) => imageLines.get(sourceUrl)!)
  }

  return participantMessages
}

export function limitImages(
  messages: ParticipantMessage[],
  max_images: number,
  lineFor: (sourceUrl: string) => string
): void {
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
      const content = messages[pos.msgIndex]!.content
      const image = content[pos.contentIndex] as ImageContent & { sourceUrl: string }
      content[pos.contentIndex] = { type: 'text', text: lineFor(image.sourceUrl) }
    }
  }
}
