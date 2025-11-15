/**
 * Context Builder
 * Transforms Discord messages to normalized participant-based format
 */

import {
  LLMRequest,
  ContextBuildResult,
  ParticipantMessage,
  ContentBlock,
  DiscordMessage,
  DiscordContext,
  CachedImage,
  ToolCall,
  BotConfig,
  ModelConfig,
} from '../types.js'
import { logger } from '../utils/logger.js'

export interface BuildContextParams {
  discordContext: DiscordContext
  toolCacheWithResults: Array<{call: ToolCall, result: any}>
  lastCacheMarker: string | null
  messagesSinceRoll: number
  config: BotConfig
}

export class ContextBuilder {
  /**
   * Build LLM request from Discord context
   */
  buildContext(params: BuildContextParams): ContextBuildResult {
    const { discordContext, toolCacheWithResults, lastCacheMarker, messagesSinceRoll, config } = params

    let messages = discordContext.messages

    // 1. Merge consecutive bot messages
    messages = this.mergeConsecutiveBotMessages(messages, config.innerName)

    // 2. Filter dot messages
    messages = this.filterDotMessages(messages)

    // 3. Apply rolling truncation if needed
    const { messages: rolledMessages, didRoll } = this.applyRollingTruncation(
      messages,
      messagesSinceRoll,
      config
    )
    messages = rolledMessages

    // 4. Convert to participant messages
    const participantMessages = this.formatMessages(messages, discordContext.images, config)

    // 5. Interleave historical tool use from cache (limited to last 5 calls with results)
    // Tools are inserted chronologically where they occurred, not at the end
    const toolMessagesByTrigger = this.formatToolUseWithResults(toolCacheWithResults, config.innerName)
    
    // Create a map of triggering message ID -> tool messages
    const toolsByMessageId = new Map<string, ParticipantMessage[]>()
    for (let i = 0; i < toolMessagesByTrigger.length; i += 2) {
      const toolCall = toolMessagesByTrigger[i]
      const toolResult = toolMessagesByTrigger[i + 1]
      if (toolCall && toolResult) {
        const messageId = toolCall.messageId || ''
        if (!toolsByMessageId.has(messageId)) {
          toolsByMessageId.set(messageId, [])
        }
        toolsByMessageId.get(messageId)!.push(toolCall, toolResult)
      }
    }
    
    // Interleave tools with messages based on messageId
    const interleavedMessages: ParticipantMessage[] = []
    for (const msg of participantMessages) {
      interleavedMessages.push(msg)
      // Add any tools triggered by this message
      if (msg.messageId && toolsByMessageId.has(msg.messageId)) {
        interleavedMessages.push(...toolsByMessageId.get(msg.messageId)!)
      }
    }
    
    logger.debug({ 
      discordMessages: messages.length,
      toolCallsWithResults: toolCacheWithResults.length,
      toolMessages: toolMessagesByTrigger.length,
      interleavedTotal: interleavedMessages.length 
    }, 'Context assembly complete with interleaved tools')
    
    // Replace participantMessages with interleaved version
    participantMessages.length = 0
    participantMessages.push(...interleavedMessages)

    // 6. Determine cache marker
    const cacheMarker = this.determineCacheMarker(messages, lastCacheMarker, didRoll)

    // Apply cache marker to appropriate message
    if (cacheMarker) {
      const msgWithMarker = participantMessages.find((m) => m.messageId === cacheMarker)
      if (msgWithMarker) {
        msgWithMarker.cacheControl = { type: 'ephemeral' }
      }
    }

    // 7. Add empty message for bot to complete
    participantMessages.push({
      participant: config.innerName,
      content: [{ type: 'text', text: '' }],
    })

    // 8. Build stop sequences (from recent participants only)
    const stopSequences = this.buildStopSequences(participantMessages, config)

    logger.debug({ stopSequences, participantCount: participantMessages.length }, 'Built stop sequences')

    const request: LLMRequest = {
      messages: participantMessages,
      systemPrompt: config.systemPrompt,
      config: this.extractModelConfig(config),
      tools: config.toolsEnabled ? undefined : undefined,  // Tools added by Agent Loop
      stopSequences,
    }

    return {
      request,
      didRoll,
      cacheMarker,
    }
  }

  private mergeConsecutiveBotMessages(
    messages: DiscordMessage[],
    botName: string
  ): DiscordMessage[] {
    const merged: DiscordMessage[] = []

    for (const msg of messages) {
      const isBotMessage = msg.author.displayName === botName
      const lastMsg = merged[merged.length - 1]

      if (
        isBotMessage &&
        lastMsg &&
        lastMsg.author.displayName === botName
      ) {
        // Merge with previous message (space separator)
        lastMsg.content = `${lastMsg.content} ${msg.content}`
        // Keep attachments
        lastMsg.attachments.push(...msg.attachments)
      } else {
        merged.push({ ...msg })
      }
    }

    return merged
  }

  private filterDotMessages(messages: DiscordMessage[]): DiscordMessage[] {
    return messages.filter((msg) => {
      // Filter messages starting with period
      if (msg.content.trim().startsWith('.')) {
        return false
      }
      // Filter messages with dotted_face emoji (🙃)
      if (msg.content.includes('🙃')) {
        return false
      }
      return true
    })
  }

  private applyRollingTruncation(
    messages: DiscordMessage[],
    messagesSinceRoll: number,
    config: BotConfig
  ): { messages: DiscordMessage[]; didRoll: boolean } {
    const shouldRoll = messagesSinceRoll >= config.rollingThreshold

    // Calculate total characters
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
    
    // Hard maximum to prevent API errors (never exceed this)
    // Conservative: ~500k chars = ~140k tokens (well under 200k limit)
    const HARD_MAX_CHARACTERS = 500000
    
    // Check hard maximum first - always enforce this
    if (totalChars > HARD_MAX_CHARACTERS) {
      logger.warn({
        totalChars,
        hardMax: HARD_MAX_CHARACTERS,
        messageCount: messages.length
      }, 'HARD LIMIT EXCEEDED - Forcing truncation')
      
      // Force truncate to hard max
      let keptChars = 0
      let cutoffIndex = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        keptChars += messages[i]!.content.length
        if (keptChars > HARD_MAX_CHARACTERS) {
          cutoffIndex = i + 1
          break
        }
      }
      
      return {
        messages: messages.slice(cutoffIndex),
        didRoll: true,  // Force roll when hitting hard limit
      }
    }

    // If not rolling yet, allow exceeding normal limits (for prompt caching)
    if (!shouldRoll) {
      logger.debug({ 
        messagesSinceRoll, 
        threshold: config.rollingThreshold,
        messageCount: messages.length,
        totalChars
      }, 'Not rolling yet - keeping all messages for cache efficiency')
      return { messages, didRoll: false }
    }

    // Time to roll - apply configured limits
    let messageLimitCutoff = 0  // Index to slice from (0 = no limit)
    let characterLimitCutoff = 0  // Index to slice from (0 = no limit)

    // Calculate message limit cutoff
    if (config.recencyWindowMessages !== undefined && messages.length > config.recencyWindowMessages) {
      messageLimitCutoff = messages.length - config.recencyWindowMessages
    }

    // Calculate character limit cutoff
    if (config.recencyWindowCharacters !== undefined) {
      let chars = 0

      for (let i = messages.length - 1; i >= 0; i--) {
        chars += messages[i]!.content.length
        if (chars > config.recencyWindowCharacters) {
          characterLimitCutoff = i + 1
          break
        }
      }
    }

    // Use the more restrictive limit (higher cutoff index = fewer messages kept)
    const cutoff = Math.max(messageLimitCutoff, characterLimitCutoff)

    if (cutoff === 0) {
      // No truncation needed
      return { messages, didRoll: false }
    }

    const truncatedMessages = messages.slice(cutoff)
    const appliedLimit = characterLimitCutoff > messageLimitCutoff ? 'characters' : 'messages'
    const keptChars = truncatedMessages.reduce((sum, m) => sum + m.content.length, 0)

    logger.info(
      { 
        removed: cutoff,
        kept: truncatedMessages.length,
        appliedLimit,
        messageLimitCutoff,
        characterLimitCutoff,
        originalCount: messages.length,
        totalChars,
        keptChars
      },
      'Rolling context: truncated by ' + appliedLimit
    )

    return {
      messages: truncatedMessages,
      didRoll: true,
    }
  }

  private determineCacheMarker(
    messages: DiscordMessage[],
    lastMarker: string | null,
    didRoll: boolean
  ): string | null {
    if (messages.length === 0) {
      return null
    }

    // If we didn't roll, keep the same marker if it's still in the message list
    if (!didRoll && lastMarker) {
      const markerStillExists = messages.some((m) => m.id === lastMarker)
      if (markerStillExists) {
        return lastMarker
      }
    }

    // If we rolled or marker is invalid, place new marker
    // Place marker 5 messages from the end, or at the oldest message
    const offset = 5
    const index = Math.max(0, messages.length - offset)
    return messages[index]!.id
  }

  private formatMessages(
    messages: DiscordMessage[],
    images: CachedImage[],
    config: BotConfig
  ): ParticipantMessage[] {
    const participantMessages: ParticipantMessage[] = []

    // Create image lookup
    const imageMap = new Map(images.map((img) => [img.url, img]))
    
    // Track image count and total base64 payload size to stay under API limits
    // Anthropic has ~10MB total request limit, we want to keep images under 3-4MB
    let imageCount = 0
    let totalBase64Size = 0
    const maxImages = config.maxImages || 5
    const maxTotalBase64Bytes = 3 * 1024 * 1024  // 3 MB total base64 data for images
    
    logger.debug({
      messageCount: messages.length,
      cachedImages: images.length,
      imageUrls: images.map(i => i.url),
      includeImages: config.includeImages,
      maxImages,
      maxTotalImageMB: maxTotalBase64Bytes / 1024 / 1024
    }, 'Starting formatMessages with images')

    for (const msg of messages) {
      const content: ContentBlock[] = []

      // Add text content
      if (msg.content.trim()) {
        content.push({
          type: 'text',
          text: msg.content,
        })
      }

      // Add image content (if enabled and within limits)
      if (config.includeImages && msg.attachments.length > 0 && imageCount < maxImages) {
        logger.debug({ messageId: msg.id, attachments: msg.attachments.length }, 'Processing attachments for message')
        
        for (const attachment of msg.attachments) {
          if (imageCount >= maxImages) {
            logger.debug({ maxImages, currentCount: imageCount }, 'Reached maxImages count limit, skipping remaining images')
            break
          }
          
          if (attachment.contentType?.startsWith('image/')) {
            const cached = imageMap.get(attachment.url)
            
            if (cached) {
              const base64Data = cached.data.toString('base64')
              const base64Size = base64Data.length
              
              // Check if adding this image would exceed total size limit
              if (totalBase64Size + base64Size > maxTotalBase64Bytes) {
                logger.warn({ 
                  currentTotalMB: (totalBase64Size / 1024 / 1024).toFixed(2),
                  imageSizeMB: (base64Size / 1024 / 1024).toFixed(2),
                  maxTotalMB: (maxTotalBase64Bytes / 1024 / 1024).toFixed(1),
                  imageCount,
                  url: attachment.url
                }, 'Skipping image - would exceed total size limit')
                break  // Stop adding more images
              }
              
              logger.debug({ 
                url: attachment.url, 
                imageSizeMB: (base64Size / 1024 / 1024).toFixed(2),
                currentImageCount: imageCount,
                currentTotalMB: (totalBase64Size / 1024 / 1024).toFixed(2)
              }, 'Adding image to content')
              
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  data: base64Data,
                  media_type: cached.mediaType,  // Anthropic API uses snake_case
                },
              })
              imageCount++
              totalBase64Size += base64Size
              
              logger.debug({ 
                messageId: msg.id, 
                imageCount, 
                maxImages,
                totalImageMB: (totalBase64Size / 1024 / 1024).toFixed(2)
              }, 'Added image to content')
            }
          }
        }
      }

      participantMessages.push({
        participant: msg.author.displayName,
        content,
        timestamp: msg.timestamp,
        messageId: msg.id,
      })
    }

    // Limit images if needed
    if (config.includeImages && config.maxImages > 0) {
      this.limitImages(participantMessages, config.maxImages)
    }

    return participantMessages
  }

  private limitImages(messages: ParticipantMessage[], maxImages: number): void {
    // Count and collect image positions
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

    // Remove oldest images if over limit
    if (imageCount > maxImages) {
      const toRemove = imageCount - maxImages

      for (let i = 0; i < toRemove; i++) {
        const pos = imagePositions[i]!
        messages[pos.msgIndex]!.content.splice(pos.contentIndex, 1)
      }
    }
  }

  private formatToolUseWithResults(
    toolCacheWithResults: Array<{call: ToolCall, result: any}>, 
    botName: string
  ): ParticipantMessage[] {
    const messages: ParticipantMessage[] = []

    for (const entry of toolCacheWithResults) {
      // Bot's message with original completion text (includes XML tool call)
      messages.push({
        participant: botName,
        content: [
          {
            type: 'text',
            text: entry.call.originalCompletionText,
          },
        ],
        timestamp: entry.call.timestamp,
        messageId: entry.call.messageId,
      })

      // Tool result message from SYSTEM (not bot)
      const resultText = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result)
      messages.push({
        participant: `System<[${entry.call.name}]`,
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
        timestamp: entry.call.timestamp,
        messageId: entry.call.messageId,
      })
    }

    return messages
  }

  /**
   * Format tool results as participant messages (for tool loop)
   * Tool results are attributed to System, not the bot
   */
  formatToolResults(
    toolCalls: Array<{ call: ToolCall; result: any }>
  ): ParticipantMessage[] {
    const messages: ParticipantMessage[] = []

    for (const { call, result } of toolCalls) {
      // Tool result message from System
      const resultText = typeof result === 'string' ? result : JSON.stringify(result)
      messages.push({
        participant: `System<[${call.name}]`,
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
        timestamp: new Date(),
      })
    }

    return messages
  }

  private buildStopSequences(
    participantMessages: ParticipantMessage[],
    config: BotConfig
  ): string[] {
    const sequences: string[] = []

    // Get recent N unique participants (from most recent messages)
    const recentParticipants: string[] = []
    const seen = new Set<string>()

    // Iterate backwards to get most recent participants
    for (let i = participantMessages.length - 1; i >= 0 && recentParticipants.length < config.recentParticipantCount; i--) {
      const participant = participantMessages[i]?.participant
      if (participant && !seen.has(participant)) {
        seen.add(participant)
        recentParticipants.push(participant)
      }
    }

    // Add participant names with colon
    for (const participant of recentParticipants) {
      sequences.push(`${participant}:`)
    }

    // Add configured stop sequences
    sequences.push(...config.stopSequences)

    return sequences
  }

  private extractModelConfig(config: BotConfig): ModelConfig {
    return {
      model: config.continuationModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
      mode: config.mode,
      botInnerName: config.innerName,
    }
  }
}

