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
import { Activation, Completion } from '../activation/index.js'
import { logger } from '../utils/logger.js'
import { 
  ContextBuildInfo, 
  ContextMessageInfo,
  MessageTransformation,
  getCurrentTrace,
} from '../trace/index.js'
import {
  estimateMessageTokens,
  estimateSystemTokens,
  extractTextContent,
} from '../trace/tokens.js'
import { ContextInjection } from '../tools/plugins/types.js'

export interface BuildContextParams {
  discordContext: DiscordContext
  toolCacheWithResults: Array<{call: ToolCall, result: any}>
  lastCacheMarker: string | null
  messagesSinceRoll: number
  config: BotConfig
  botDiscordUsername?: string  // Bot's actual Discord username for chat mode message matching
  activations?: Activation[]  // For preserve_thinking_context
  pluginInjections?: ContextInjection[]  // Plugin context injections
}

export interface ContextBuildResultWithTrace extends ContextBuildResult {
  /** Trace info for debugging (only populated if tracing is active) */
  traceInfo?: ContextBuildInfo
}

export class ContextBuilder {
  /**
   * Build LLM request from Discord context
   */
  buildContext(params: BuildContextParams): ContextBuildResultWithTrace {
    const { discordContext, toolCacheWithResults, lastCacheMarker, messagesSinceRoll, config, botDiscordUsername, activations, pluginInjections } = params
    const originalMessageCount = discordContext.messages.length

    let messages = discordContext.messages

    // Track which messages were merged (for tracing)
    const mergedMessageIds = new Set<string>()

    // 1. Merge consecutive bot messages (skip when preserve_thinking_context to keep IDs for injection)
    if (!config.preserve_thinking_context) {
      const beforeMerge = messages.length
    messages = this.mergeConsecutiveBotMessages(messages, config.innerName)
      if (messages.length < beforeMerge) {
        // Some messages were merged - track them
        const afterIds = new Set(messages.map(m => m.id))
        discordContext.messages.forEach(m => {
          if (!afterIds.has(m.id)) mergedMessageIds.add(m.id)
        })
      }
    }

    // 2. Filter dot messages
    const beforeFilter = messages.length
    messages = this.filterDotMessages(messages)
    const filteredCount = beforeFilter - messages.length

    // 3. Convert to participant messages (limits applied later on final context)
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

    // 4.5. Inject activation completions if preserve_thinking_context is enabled
    if (config.preserve_thinking_context && activations && activations.length > 0) {
      this.injectActivationCompletions(participantMessages, activations, config.innerName)
    }

    // 4.6. Inject plugin context injections at calculated depths
    if (pluginInjections && pluginInjections.length > 0) {
      this.insertPluginInjections(participantMessages, pluginInjections, messages)
    }

    // 5. Apply limits on final assembled context (after images & tools added)
    const { messages: finalMessages, didTruncate, messagesRemoved } = this.applyLimits(
      participantMessages, 
      messagesSinceRoll,
      config
    )
    // Only update if a different array was returned (truncation happened)
    if (finalMessages !== participantMessages) {
    participantMessages.length = 0
    participantMessages.push(...finalMessages)
    }

    // 6. Determine cache marker
    const cacheMarker = this.determineCacheMarker(messages, lastCacheMarker, didTruncate, config.rolling_threshold)

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
    const stop_sequences = this.buildStopSequences(participantMessages, config)

    logger.debug({ stop_sequences, participantCount: participantMessages.length }, 'Built stop sequences')

    const request: LLMRequest = {
      messages: participantMessages,
      system_prompt: config.system_prompt,
      context_prefix: config.context_prefix,
      config: this.extractModelConfig(config, botDiscordUsername),
      tools: config.tools_enabled ? undefined : undefined,  // Tools added by Agent Loop
      stop_sequences,
    }

    // Build trace info if tracing is active
    const traceInfo = this.buildTraceInfo(
      participantMessages,
      discordContext,
      toolCacheWithResults,
      config,
      {
        originalMessageCount,
        filteredCount,
        mergedMessageIds,
        didTruncate,
        messagesRolledOff: messagesRemoved || 0,
        cacheMarker,
        lastCacheMarker,
        stopSequences: stop_sequences,
      }
    )
    
    // Record to active trace if available
    if (traceInfo) {
      getCurrentTrace()?.recordContextBuild(traceInfo)
    }

    return {
      request,
      didRoll: didTruncate,
      cacheMarker,
      traceInfo,
    }
  }
  
  /**
   * Build trace info for debugging
   */
  private buildTraceInfo(
    finalMessages: ParticipantMessage[],
    _discordContext: DiscordContext,
    toolCacheWithResults: Array<{call: ToolCall, result: any}>,
    config: BotConfig,
    metadata: {
      originalMessageCount: number
      filteredCount: number
      mergedMessageIds: Set<string>
      didTruncate: boolean
      messagesRolledOff: number
      cacheMarker: string | null
      lastCacheMarker: string | null
      stopSequences: string[]
    }
  ): ContextBuildInfo | undefined {
    // Build message info for each message in final context
    const messageInfos: ContextMessageInfo[] = []
    const triggeringMessageId = finalMessages.length > 1 
      ? finalMessages[finalMessages.length - 2]?.messageId  // Last message before empty completion
      : undefined
    
    // Count images
    let totalImages = 0
    const imageDetails: ContextBuildInfo['imageDetails'] = []
    
    for (let i = 0; i < finalMessages.length; i++) {
      const msg = finalMessages[i]!
      if (!msg.content.length) continue  // Skip empty completion message
      
      const transformations: MessageTransformation[] = []
      
      // Check for merged messages
      if (msg.messageId && metadata.mergedMessageIds.has(msg.messageId)) {
        transformations.push('merged_consecutive')
      }
      
      // Check for images
      let imageCount = 0
      for (const block of msg.content) {
        if (block.type === 'image') {
          imageCount++
          totalImages++
          // Add image detail
          imageDetails.push({
            discordMessageId: msg.messageId || '',
            url: 'embedded',  // Base64 embedded
            tokenEstimate: 1000,  // Rough estimate
          })
        }
      }
      if (imageCount > 0) {
        transformations.push('image_extracted')
      }
      
      // Check for cache control
      const hasCacheControl = !!msg.cacheControl
      
      const textContent = extractTextContent(msg)
      
      messageInfos.push({
        position: i,
        discordMessageId: msg.messageId || null,
        participant: msg.participant,
        contentPreview: textContent.slice(0, 150) + (textContent.length > 150 ? '...' : ''),
        contentLength: textContent.length,
        tokenEstimate: estimateMessageTokens(msg),
        transformations,
        isTrigger: msg.messageId === triggeringMessageId,
        hasImages: imageCount > 0,
        imageCount,
        hasCacheControl,
        discordTimestamp: msg.timestamp,
      })
    }
    
    // Calculate token estimates
    const systemTokens = estimateSystemTokens(config.system_prompt)
    let messageTokens = 0
    let imageTokens = 0
    let toolTokens = 0
    
    for (const msg of finalMessages) {
      const msgTokens = estimateMessageTokens(msg)
      
      // Categorize by participant
      if (msg.participant.startsWith('System<[')) {
        toolTokens += msgTokens
      } else {
        // Check for images
        for (const block of msg.content) {
          if (block.type === 'image') {
            imageTokens += 1000
          }
        }
        messageTokens += msgTokens - (msg.content.filter(b => b.type === 'image').length * 1000)
      }
    }
    
    // Build tool cache details
    const toolCacheDetails: ContextBuildInfo['toolCacheDetails'] = toolCacheWithResults.map(t => ({
      toolName: t.call.name,
      triggeringMessageId: t.call.messageId,
      tokenEstimate: estimateMessageTokens({
        participant: 'System',
        content: [{ type: 'text', text: JSON.stringify(t.result) }],
      }),
    }))
    
    return {
      messagesConsidered: metadata.originalMessageCount,
      messagesIncluded: finalMessages.length - 1,  // Exclude empty completion message
      messages: messageInfos,
      imagesIncluded: totalImages,
      imageDetails,
      toolCacheEntries: toolCacheWithResults.length,
      toolCacheDetails,
      didTruncate: metadata.didTruncate,
      truncateReason: metadata.didTruncate 
        ? (metadata.messagesRolledOff > 0 ? 'rolling_threshold' : 'character_limit')
        : undefined,
      messagesRolledOff: metadata.messagesRolledOff,
      cacheMarker: metadata.cacheMarker || undefined,
      previousCacheMarker: metadata.lastCacheMarker || undefined,
      stopSequences: metadata.stopSequences,
      tokenEstimates: {
        system: systemTokens,
        messages: messageTokens,
        images: imageTokens,
        tools: toolTokens,
        total: systemTokens + messageTokens + imageTokens + toolTokens,
      },
      configSnapshot: {
        recencyWindow: config.recency_window_messages || 0,
        rollingThreshold: config.rolling_threshold,
        maxImages: config.max_images || 0,
        mode: config.mode,
      },
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
      
      // Don't merge messages starting with "." (tool outputs, preambles)
      // These need to stay separate so they can be filtered later
      const isDotMessage = msg.content.trim().startsWith('.')
      const lastIsDotMessage = lastMsg?.content.trim().startsWith('.')

      if (
        isBotMessage &&
        lastMsg &&
        lastMsg.author.displayName === botName &&
        !isDotMessage &&
        !lastIsDotMessage
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
      // Filter messages with dotted_line_face reaction (🫥)
      // Anyone can add this reaction to hide a message from context
      if (msg.reactions?.some(r => r.emoji === '🫥' || r.emoji === 'dotted_line_face')) {
        return false
      }
      return true
    })
  }


  /**
   * Apply limits on assembled context (after images and tools added)
   * This is the ONLY place limits are enforced - accounts for total payload size
   */
  private applyLimits(
    messages: ParticipantMessage[],
    messagesSinceRoll: number,
    config: BotConfig
  ): { messages: ParticipantMessage[], didTruncate: boolean, messagesRemoved?: number } {
    const shouldRoll = messagesSinceRoll >= config.rolling_threshold
    
    // Calculate total size of FINAL context (text + tool results only)
    // Images are NOT counted here - they have separate limits (max_images, 3MB total)
    let totalChars = 0
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          totalChars += (block as any).text.length
        } else if (block.type === 'tool_result') {
          const toolBlock = block as any
          const content = typeof toolBlock.content === 'string' 
            ? toolBlock.content 
            : JSON.stringify(toolBlock.content)
          totalChars += content.length
        }
        // Images not counted - handled separately with max_images and 3MB size limit
      }
    }
    
    const hardMaxCharacters = config.hard_max_characters || 500000
    const normalLimit = config.recency_window_characters || 100000  // Default normal limit
    
    // ALWAYS enforce hard maximum (even when not rolling)
    // When exceeded, truncate to NORMAL limit (not hard max) to reset cache properly
    if (totalChars > hardMaxCharacters) {
      logger.warn({
        totalChars,
        hardMax: hardMaxCharacters,
        normalLimit,
        messageCount: messages.length
      }, 'HARD LIMIT EXCEEDED - Truncating to normal limit and forcing roll')
      
      const result = this.truncateToLimit(messages, normalLimit, true)
      return { ...result, messagesRemoved: messages.length - result.messages.length }
    }
    
    // If not rolling yet, allow normal limits to be exceeded (for cache efficiency)
    if (!shouldRoll) {
      logger.debug({
        messagesSinceRoll,
        threshold: config.rolling_threshold,
        messageCount: messages.length,
        totalChars,
        totalMB: (totalChars / 1024 / 1024).toFixed(2)
      }, 'Not rolling yet - keeping all messages for cache')
      return { messages, didTruncate: false, messagesRemoved: 0 }
    }
    
    // Time to roll - check normal limits
    const messageLimit = config.recency_window_messages || Infinity
    
    // Apply character limit
    if (totalChars > normalLimit) {
      logger.info({
        totalChars,
        limit: normalLimit,
        messageCount: messages.length
      }, 'Rolling: Character limit exceeded, truncating final context')
      const result = this.truncateToLimit(messages, normalLimit, true)
      return { ...result, messagesRemoved: messages.length - result.messages.length }
    }
    
    // Apply message count limit
    if (messages.length > messageLimit) {
      logger.info({
        messageCount: messages.length,
        limit: messageLimit,
        keptChars: totalChars
      }, 'Rolling: Message count limit exceeded, truncating')
      const removed = messages.length - messageLimit
      return { 
        messages: messages.slice(messages.length - messageLimit), 
        didTruncate: true,
        messagesRemoved: removed,
      }
    }
    
    return { messages, didTruncate: false, messagesRemoved: 0 }
  }
  
  /**
   * Helper to truncate messages to character limit (works on ParticipantMessage[])
   */
  private truncateToLimit(
    messages: ParticipantMessage[], 
    charLimit: number,
    isHardLimit: boolean
  ): { messages: ParticipantMessage[], didTruncate: boolean } {
    let keptChars = 0
    let cutoffIndex = messages.length
    
    // Count from end backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      let msgSize = 0
      
      for (const block of msg.content) {
        if (block.type === 'text') {
          msgSize += (block as any).text.length
        } else if (block.type === 'image') {
          const imageBlock = block as any
          if (imageBlock.source?.data) {
            msgSize += imageBlock.source.data.length
          }
        } else if (block.type === 'tool_result') {
          const toolBlock = block as any
          const content = typeof toolBlock.content === 'string' 
            ? toolBlock.content 
            : JSON.stringify(toolBlock.content)
          msgSize += content.length
        }
      }
      
      if (keptChars + msgSize > charLimit) {
        cutoffIndex = i + 1
        break
      }
      
      keptChars += msgSize
    }
    
    const truncated = messages.slice(cutoffIndex)
    
    if (cutoffIndex > 0) {
      logger.warn({
        removed: cutoffIndex,
        kept: truncated.length,
        keptChars,
        limitType: isHardLimit ? 'HARD' : 'normal',
        charLimit
      }, `Truncated final context to ${isHardLimit ? 'HARD' : 'normal'} limit`)
    }
    
    return { messages: truncated, didTruncate: cutoffIndex > 0 }
  }

  private determineCacheMarker(
    messages: DiscordMessage[],
    lastMarker: string | null,
    didRoll: boolean,
    _rollingThreshold: number = 50
  ): string | null {
    if (messages.length === 0) {
      return null
    }

    // If we didn't roll, keep the same marker if it's still in the message list
    if (!didRoll && lastMarker) {
      const markerStillExists = messages.some((m) => m.id === lastMarker)
      if (markerStillExists) {
        logger.debug({ lastMarker, messagesLength: messages.length }, 'Keeping existing cache marker')
        return lastMarker
      }
    }

    // If we rolled or marker is invalid, place new marker
    // Place marker at: length - buffer (~20 messages from end)
    // This ensures:
    // 1. Initially after roll: ~20 recent messages uncached (for dynamic content)
    // 2. As messages accumulate: uncached grows (20 → 30 → ... → 70 at next roll)
    // 3. Cached portion stays STABLE until next roll
    const buffer = 20
    const index = Math.max(0, messages.length - buffer)
    
    const markerId = messages[index]!.id
    logger.debug({ 
      index, 
      messagesLength: messages.length, 
      buffer,
      markerId,
      didRoll
    }, 'Setting new cache marker')
    
    return markerId
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
    const max_images = config.max_images || 5
    const maxTotalBase64Bytes = 3 * 1024 * 1024  // 3 MB total base64 data for images
    
    logger.debug({
      messageCount: messages.length,
      cachedImages: images.length,
      imageUrls: images.map(i => i.url),
      include_images: config.include_images,
      max_images,
      maxTotalImageMB: maxTotalBase64Bytes / 1024 / 1024
    }, 'Starting formatMessages with images')

    // PRE-SELECT which messages get images by iterating BACKWARDS (newest first)
    // This ensures recent images take priority over old ones
    const messagesWithImages = new Set<string>()
    if (config.include_images) {
      let imageCount = 0
      let totalBase64Size = 0
      
      for (let i = messages.length - 1; i >= 0 && imageCount < max_images; i--) {
        const msg = messages[i]!
        for (const attachment of msg.attachments) {
          if (imageCount >= max_images) break
          
          if (attachment.contentType?.startsWith('image/')) {
            const cached = imageMap.get(attachment.url)
            if (cached) {
              const base64Size = cached.data.toString('base64').length
              
              if (totalBase64Size + base64Size <= maxTotalBase64Bytes) {
                messagesWithImages.add(msg.id)
                imageCount++
                totalBase64Size += base64Size
                logger.debug({ 
                  messageId: msg.id,
                  imageSizeMB: (base64Size / 1024 / 1024).toFixed(2),
                  totalMB: (totalBase64Size / 1024 / 1024).toFixed(2),
                  imageCount
                }, 'Pre-selected image (newest-first)')
              }
            }
          }
        }
      }
      logger.debug({ 
        selectedCount: messagesWithImages.size, 
        totalMB: (totalBase64Size / 1024 / 1024).toFixed(2) 
      }, 'Pre-selected images for inclusion')
    }

    // Now process messages in order, only including pre-selected images
    for (const msg of messages) {
      const content: ContentBlock[] = []

      // Add text content
      if (msg.content.trim()) {
        content.push({
          type: 'text',
          text: msg.content,
        })
      }

      // Add image content only for pre-selected messages
      if (config.include_images && messagesWithImages.has(msg.id)) {
        logger.debug({ messageId: msg.id, attachments: msg.attachments.length }, 'Adding pre-selected images for message')
        
        for (const attachment of msg.attachments) {
          if (attachment.contentType?.startsWith('image/')) {
            const cached = imageMap.get(attachment.url)
            
            if (cached) {
              const base64Data = cached.data.toString('base64')
              
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  data: base64Data,
                  media_type: cached.mediaType,  // Anthropic API uses snake_case
                },
              })
              
              logger.debug({ 
                messageId: msg.id, 
                url: attachment.url,
                sizeMB: (base64Data.length / 1024 / 1024).toFixed(2)
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
    if (config.include_images && config.max_images > 0) {
      this.limitImages(participantMessages, config.max_images)
    }

    return participantMessages
  }

  private limitImages(messages: ParticipantMessage[], max_images: number): void {
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
    if (imageCount > max_images) {
      const toRemove = imageCount - max_images

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

  /**
   * Inject activation completions into participant messages
   * - Replaces bot message content with full completion text (including thinking)
   * - Inserts phantom completions after their anchor messages
   */
  private injectActivationCompletions(
    messages: ParticipantMessage[],
    activations: Activation[],
    botName: string
  ): void {
    logger.debug({
      activationCount: activations.length,
      botName,
      messageCount: messages.length,
    }, 'Starting activation completion injection')
    
    // Build a map of messageId -> completion
    const completionMap = new Map<string, { activation: Activation; completion: Completion }>()
    for (const activation of activations) {
      for (const completion of activation.completions) {
        for (const msgId of completion.sentMessageIds) {
          completionMap.set(msgId, { activation, completion })
        }
      }
    }
    
    logger.debug({
      completionMapSize: completionMap.size,
      completionMapKeys: Array.from(completionMap.keys()),
    }, 'Built completion map')
    
    // Build phantom insertions: messageId -> completions to insert after
    const phantomInsertions = new Map<string, Completion[]>()
    for (const activation of activations) {
      let currentAnchor = activation.trigger.anchorMessageId
      
      for (const completion of activation.completions) {
        if (completion.sentMessageIds.length === 0) {
          // Phantom - insert after current anchor
          const existing = phantomInsertions.get(currentAnchor) || []
          existing.push(completion)
          phantomInsertions.set(currentAnchor, existing)
        } else {
          // Update anchor to last sent message
          currentAnchor = completion.sentMessageIds[completion.sentMessageIds.length - 1] || currentAnchor
        }
      }
    }
    
    // Log bot messages in context for debugging
    const botMessages = messages.filter(m => m.participant === botName)
    logger.debug({
      botMessageCount: botMessages.length,
      botMessageIds: botMessages.map(m => m.messageId),
      botName,
    }, 'Bot messages in context')
    
    // Process messages: replace content and insert phantoms
    // Process in reverse to avoid index shifting issues
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      
      // Check if this message has a full completion to inject
      if (msg.messageId && msg.participant === botName && completionMap.has(msg.messageId)) {
        const { completion } = completionMap.get(msg.messageId)!
        // Replace content with full completion text
        msg.content = [{ type: 'text', text: completion.text }]
        logger.debug({ 
          messageId: msg.messageId, 
          originalLength: msg.content[0]?.type === 'text' ? (msg.content[0] as any).text?.length : 0,
          newLength: completion.text.length 
        }, 'Injected full completion into bot message')
      } else if (msg.messageId && msg.participant === botName) {
        // Log why we didn't inject with more detail
        const mapKeys = Array.from(completionMap.keys())
        const exactMatch = mapKeys.find(k => k === msg.messageId)
        const includesMatch = mapKeys.find(k => k.includes(msg.messageId) || msg.messageId.includes(k))
        logger.debug({
          messageId: msg.messageId,
          messageIdType: typeof msg.messageId,
          participant: msg.participant,
          inCompletionMap: completionMap.has(msg.messageId),
          mapKeyCount: mapKeys.length,
          exactMatch: exactMatch || 'none',
          includesMatch: includesMatch || 'none',
          firstFewKeys: mapKeys.slice(0, 3),
        }, 'Bot message NOT injected')
      }
      
      // Check if phantoms should be inserted after this message
      if (msg.messageId && phantomInsertions.has(msg.messageId)) {
        const phantoms = phantomInsertions.get(msg.messageId)!
        // Insert phantom messages after this one
        const phantomMessages: ParticipantMessage[] = phantoms.map(p => ({
          participant: botName,
          content: [{ type: 'text', text: p.text }],
          // No messageId - this is a phantom
        }))
        // Insert after current message
        messages.splice(i + 1, 0, ...phantomMessages)
        logger.debug({ 
          afterMessageId: msg.messageId, 
          phantomCount: phantomMessages.length 
        }, 'Inserted phantom completions')
      }
    }
  }
  
  /**
   * Insert plugin context injections at calculated depths
   * 
   * Depth 0 = after the most recent message
   * Depth N = N messages from the end
   * 
   * Injections age from 0 (when modified) toward their targetDepth.
   */
  private insertPluginInjections(
    messages: ParticipantMessage[],
    injections: ContextInjection[],
    discordMessages: DiscordMessage[]
  ): void {
    if (injections.length === 0) return
    
    // Build message ID -> position map for depth calculation
    const messagePositions = new Map<string, number>()
    for (let i = 0; i < discordMessages.length; i++) {
      messagePositions.set(discordMessages[i]!.id, i)
    }
    
    // Calculate current depth for each injection
    // Positive targetDepth = from end (latest), negative = from start (earliest)
    const injectionsWithDepth = injections.map(injection => {
      let currentDepth: number
      const isFromEarliest = injection.targetDepth < 0
      
      if (isFromEarliest) {
        // Negative depth means "from start" - no aging, always at fixed position
        // -1 = position 0, -6 = position 5, etc.
        currentDepth = injection.targetDepth  // Keep negative for sorting
      } else if (!injection.lastModifiedAt) {
        // No modification tracking - settled at target
        currentDepth = injection.targetDepth
      } else {
        const position = messagePositions.get(injection.lastModifiedAt)
        if (position === undefined) {
          // Message not in context - assume settled
          currentDepth = injection.targetDepth
        } else {
          // Calculate messages since modification
          const messagesSince = discordMessages.length - 1 - position
          // Depth is min of messagesSince and targetDepth
          currentDepth = Math.min(messagesSince, injection.targetDepth)
        }
      }
      
      return { injection, currentDepth, isFromEarliest }
    })
    
    // Separate "from earliest" (negative) and "from latest" (positive) injections
    const fromEarliest = injectionsWithDepth.filter(i => i.isFromEarliest)
    const fromLatest = injectionsWithDepth.filter(i => !i.isFromEarliest)
    
    // Sort "from earliest" by position (most negative = closest to start)
    // Then by priority (higher first)
    fromEarliest.sort((a, b) => {
      if (a.currentDepth !== b.currentDepth) {
        return a.currentDepth - b.currentDepth  // More negative first (closer to start)
      }
      return (b.injection.priority || 0) - (a.injection.priority || 0)
    })
    
    // Sort "from latest" by depth (deepest first, so we insert from back to front)
    // Then by priority (higher first)
    fromLatest.sort((a, b) => {
      if (a.currentDepth !== b.currentDepth) {
        return b.currentDepth - a.currentDepth  // Deeper first
      }
      return (b.injection.priority || 0) - (a.injection.priority || 0)
    })
    
    // Insert "from latest" first (they reference end of array which won't shift)
    for (const { injection, currentDepth } of fromLatest) {
      // Convert depth to insertion index (from the END of the array)
      // Depth 0 = after last message = messages.length
      // Depth 1 = before last message = messages.length - 1
      const insertIndex = Math.max(0, messages.length - currentDepth)
      
      // Convert content to ContentBlock[]
      const content: ContentBlock[] = typeof injection.content === 'string'
        ? [{ type: 'text', text: injection.content }]
        : injection.content
      
      // Create the injection message
      const injectionMessage: ParticipantMessage = {
        participant: injection.asSystem ? 'System' : 'System>[plugin]',
        content,
        // No messageId - synthetic injection
      }
      
      messages.splice(insertIndex, 0, injectionMessage)
      
      logger.debug({
        injectionId: injection.id,
        targetDepth: injection.targetDepth,
        currentDepth,
        insertIndex,
        anchor: 'latest',
        totalMessages: messages.length,
      }, 'Inserted plugin context injection')
    }
    
    // Insert "from earliest" (they reference start of array, insert in reverse order)
    // Process in reverse so earlier positions are inserted last (preserving indices)
    for (let i = fromEarliest.length - 1; i >= 0; i--) {
      const { injection, currentDepth } = fromEarliest[i]!
      
      // Convert negative depth to insertion index (from the START of the array)
      // -1 = position 0 (very start)
      // -6 = position 5 (after first 5 messages)
      const insertIndex = Math.min(messages.length, Math.abs(currentDepth) - 1)
      
      // Convert content to ContentBlock[]
      const content: ContentBlock[] = typeof injection.content === 'string'
        ? [{ type: 'text', text: injection.content }]
        : injection.content
      
      // Create the injection message
      const injectionMessage: ParticipantMessage = {
        participant: injection.asSystem ? 'System' : 'System>[plugin]',
        content,
        // No messageId - synthetic injection
      }
      
      messages.splice(insertIndex, 0, injectionMessage)
      
      logger.debug({
        injectionId: injection.id,
        targetDepth: injection.targetDepth,
        currentDepth,
        insertIndex,
        anchor: 'earliest',
        totalMessages: messages.length,
      }, 'Inserted plugin context injection')
    }
  }

  private buildStopSequences(
    participantMessages: ParticipantMessage[],
    config: BotConfig
  ): string[] {
    const sequences: string[] = []

    // Get recent N unique participants (from most recent messages)
    // Include both message authors AND mentioned users
    const recentParticipants: string[] = []
    const seen = new Set<string>()

    // Iterate backwards to get most recent participants and their mentions
    for (let i = participantMessages.length - 1; i >= 0 && recentParticipants.length < config.recent_participant_count; i--) {
      const msg = participantMessages[i]
      if (!msg) continue
      
      // Add message author
      if (msg.participant && !seen.has(msg.participant)) {
        seen.add(msg.participant)
        recentParticipants.push(msg.participant)
      }
      
      // Extract mentions from text content (format: <@username>)
      for (const block of msg.content) {
        if (block.type === 'text') {
          const mentionRegex = /<@(\w+(?:\.\w+)?)>/g
          let match
          while ((match = mentionRegex.exec(block.text)) !== null) {
            const mentionedUser = match[1]!
            if (!seen.has(mentionedUser) && recentParticipants.length < config.recent_participant_count) {
              seen.add(mentionedUser)
              recentParticipants.push(mentionedUser)
            }
          }
        }
      }
    }

    // Add participant names with colon
    for (const participant of recentParticipants) {
      sequences.push(`${participant}:`)
    }

    // Add system message prefixes (bot should never generate these)
    sequences.push('System<[', 'System>[')
    
    // Add conversation boundary marker (prevents hallucinating past context end)
    sequences.push('<<HUMAN_CONVERSATION_END>>')

    // Add message delimiter if configured (for base model completions)
    // This should be the primary stop sequence for base models
    if (config.message_delimiter) {
      sequences.unshift(config.message_delimiter)  // Add at start (highest priority)
    }

    // Add configured stop sequences
    sequences.push(...config.stop_sequences)

    return sequences
  }

  private extractModelConfig(config: BotConfig, botDiscordUsername?: string): ModelConfig {
    return {
      model: config.continuation_model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      top_p: config.top_p,
      mode: config.mode,
      prefill_thinking: config.prefill_thinking,
      botInnerName: config.innerName,
      botDiscordUsername,  // Bot's actual Discord username for chat mode message matching
      chatPersonaPrompt: config.chat_persona_prompt,
      chatPersonaPrefill: config.chat_persona_prefill,
      chatBotAsAssistant: config.chat_bot_as_assistant,
      messageDelimiter: config.message_delimiter,  // For base model completions
      presence_penalty: config.presence_penalty,
      frequency_penalty: config.frequency_penalty,
    }
  }
}

