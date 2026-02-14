/**
 * Context Builder
 * Transforms Discord messages to normalized participant-based format
 */

import {
  LLMRequest,
  ContextBuildResult,
  ParticipantMessage,
  ContentBlock,
  ImageContent,
  DiscordMessage,
  DiscordContext,
  CachedImage,
  CachedDocument,
  ToolCall,
  BotConfig,
  ModelConfig,
} from '../types.js'
import { Activation, Completion, MessageContext } from '../activation/index.js'
import { logger } from '../utils/logger.js'
import sharp from 'sharp'
import {
  shouldRoll,
  calculateCharacters,
  truncateToCharacterLimit,
  truncateToMessageLimit,
  determineCacheMarker,
  findFallbackCacheMarker,
  applyChapterXCacheMarker,
} from './rolling.js'

// Anthropic's per-image base64 limit is 5MB
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
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
  async buildContext(params: BuildContextParams): Promise<ContextBuildResultWithTrace> {
    const { discordContext, toolCacheWithResults, lastCacheMarker, messagesSinceRoll, config, botDiscordUsername, activations, pluginInjections } = params
    const originalMessageCount = discordContext.messages.length

    let messages = discordContext.messages

    // Track which messages were merged (for tracing)
    const mergedMessageIds = new Set<string>()

    // 1. Merge consecutive bot messages (skip when preserve_thinking_context to keep IDs for injection)
    // Use Discord username for matching (what appears in msg.author.displayName from Discord)
    const botDisplayName = botDiscordUsername || config.name
    if (!config.preserve_thinking_context) {
      const beforeMerge = messages.length
    messages = this.mergeConsecutiveBotMessages(messages, botDisplayName)
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
    
    // Debug: log last few message IDs after filtering
    logger.debug({
      lastMessageIds: messages.slice(-5).map(m => m.id),
      totalAfterFilter: messages.length,
    }, 'Messages after dot filtering')

    // 2.5. Pre-determine cache marker for image selection
    // IMPORTANT: We need to know where the cache boundary WILL BE before selecting images.
    // If we wait until after image selection, images might be selected from the prefix
    // and break caching. This calculates the marker that determineCacheMarker will use.
    let imageSelectionMarker = lastCacheMarker
    if (!imageSelectionMarker && messages.length > 0) {
      // On first activation (no existing marker), calculate where new marker will be
      // This mirrors the logic in determineCacheMarker for new markers
      const buffer = 20
      const markerIndex = Math.max(0, messages.length - buffer)
      imageSelectionMarker = messages[markerIndex]?.id ?? null
      logger.debug({
        calculatedMarker: imageSelectionMarker,
        markerIndex,
        messagesLength: messages.length,
      }, 'Pre-calculated cache marker for image selection (first activation)')
    }

    // 3. Convert to participant messages (limits applied later on final context)
    // Pass botDiscordUsername so we can normalize bot's own messages to use config.name
    // Pass imageSelectionMarker to anchor image selection for cache stability
    let participantMessages = await this.formatMessages(
      messages,
      discordContext.images,
      discordContext.documents,
      config,
      botDiscordUsername,
      imageSelectionMarker  // Use pre-calculated marker, not just lastCacheMarker
    )
    
    // Debug: log last few participant message IDs
    logger.debug({
      lastParticipantIds: participantMessages.slice(-5).map(m => m.messageId),
      totalParticipants: participantMessages.length,
    }, 'Participant messages after formatMessages')

    // 5. Interleave historical tool use from cache (limited to last 5 calls with results)
    // Skip when preserve_thinking_context is enabled - activation store injection handles tool content
    if (!config.preserve_thinking_context) {
      // Tools are inserted chronologically where they occurred, not at the end
      // Use config.name for bot's participant name (consistent with formatMessages normalization)
      const toolMessagesByTrigger = this.formatToolUseWithResults(toolCacheWithResults, config.name)
      
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
      
      // Limit MCP images (from tool results) - keep the latest ones
      if (config.max_mcp_images >= 0) {
        this.limitMcpImages(participantMessages, config.max_mcp_images)
      }
    } else {
      logger.debug({ 
        discordMessages: messages.length,
        toolCallsWithResults: toolCacheWithResults.length,
      }, 'Skipping tool cache interleaving (preserve_thinking_context enabled)')
    }

    // 4.5. Inject activation completions if preserve_thinking_context is enabled
    // Use config.name for bot's participant name (consistent with formatMessages normalization)
    if (config.preserve_thinking_context && activations && activations.length > 0) {
      this.injectActivationCompletions(participantMessages, activations, config.name)
    }

    // 4.6. Inject plugin context injections at calculated depths
    if (pluginInjections && pluginInjections.length > 0) {
      this.insertPluginInjections(participantMessages, pluginInjections, messages)
    }

    // 4.7. Merge consecutive messages from the same participant
    // This handles "m continue" scenarios where bot has multiple sequential messages
    // Done AFTER injection so that message IDs are available for activation lookup
    participantMessages = this.mergeConsecutiveParticipantMessages(participantMessages)

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

    // 6. Determine cache marker using membrane's pattern
    let cacheMarker = this.determineCacheMarkerFromMessages(messages, lastCacheMarker, didTruncate)

    // Apply cache marker using membrane's function (sets cacheBreakpoint)
    // IMPORTANT: The marker was selected from raw messages, but some messages may have been
    // merged or filtered during transformation to participantMessages. If the marker message
    // no longer exists, we need to find a valid fallback.
    if (cacheMarker) {
      // Check if marker exists in participant messages
      const markerExists = participantMessages.some(m => m.messageId === cacheMarker);
      
      if (!markerExists) {
        // Marker message was merged/filtered - find a valid fallback using helper
        const fallbackMarker = findFallbackCacheMarker(participantMessages, config.name)
        
        if (fallbackMarker) {
          logger.warn({
            originalMarker: cacheMarker,
            fallbackMarker,
            totalMessages: participantMessages.length,
          }, 'Cache marker orphaned - using fallback')
          cacheMarker = fallbackMarker
        } else {
          logger.warn({
            originalMarker: cacheMarker,
            totalMessages: participantMessages.length,
          }, 'Cache marker orphaned, no fallback - caching disabled')
          cacheMarker = null
        }
      }
      
      // Apply cache marker using membrane's logic
      if (cacheMarker) {
        participantMessages = applyChapterXCacheMarker(participantMessages, cacheMarker)
      }
    }

    // 7. Add empty message for bot to complete
    // Always use config.name - bot's historical messages are also normalized to config.name
    participantMessages.push({
      participant: config.name,
      content: [{ type: 'text', text: '' }],
    })

    // 8. Build stop sequences (from recent participants only)
    const stop_sequences = this.buildStopSequences(participantMessages, config)

    logger.debug({ stop_sequences, participantCount: participantMessages.length }, 'Built stop sequences')

    const request: LLMRequest = {
      messages: participantMessages,
      system_prompt: config.system_prompt,
      context_prefix: config.context_prefix,
      prefill_user_message: config.prefill_user_message,
      config: this.extractModelConfig(config),
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
          // Add image detail with actual token estimate
          const imgBlock = block as any
          imageDetails.push({
            discordMessageId: msg.messageId || '',
            url: 'embedded',  // Base64 embedded
            tokenEstimate: imgBlock.tokenEstimate || 1000,  // Use actual or fallback
          })
        }
      }
      if (imageCount > 0) {
        transformations.push('image_extracted')
      }
      
      // Check for cache control (prefer cacheBreakpoint, fall back to deprecated cacheControl)
      const hasCacheControl = !!msg.cacheBreakpoint || !!msg.cacheControl
      
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
        // Check for images and use actual token estimates
        for (const block of msg.content) {
          if (block.type === 'image') {
            const imgBlock = block as any
            const estimate = imgBlock.tokenEstimate || 1000  // Fallback to 1000 if no estimate
            imageTokens += estimate
          }
        }
        // Subtract image tokens from message tokens (they're counted separately)
        const imgTokensInMsg = msg.content
          .filter(b => b.type === 'image')
          .reduce((sum, b) => sum + ((b as any).tokenEstimate || 1000), 0)
        messageTokens += msgTokens - imgTokensInMsg
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
      // Strip reply prefix before checking (replies look like "<reply:@user> .test")
      const contentWithoutReply = msg.content.trim().replace(/^<reply:@[^>]+>\s*/, '')
      const lastContentWithoutReply = lastMsg?.content.trim().replace(/^<reply:@[^>]+>\s*/, '') || ''
      const isDotMessage = contentWithoutReply.startsWith('.')
      const lastIsDotMessage = lastContentWithoutReply.startsWith('.')

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

  /**
   * Merge consecutive ParticipantMessages from the same participant.
   * This handles "m continue" scenarios where bot has multiple sequential messages
   * that should appear as one turn in the LLM context.
   */
  private mergeConsecutiveParticipantMessages(
    messages: ParticipantMessage[]
  ): ParticipantMessage[] {
    const merged: ParticipantMessage[] = []

    for (const msg of messages) {
      const lastMsg = merged[merged.length - 1]
      
      // Check if we should merge with previous message
      if (lastMsg && lastMsg.participant === msg.participant) {
        // Merge content arrays
        // For text blocks, we join with space; for other types, just append
        const lastTextBlockIndex = lastMsg.content.map(c => c.type).lastIndexOf('text')
        const lastTextBlock = lastTextBlockIndex >= 0 ? lastMsg.content[lastTextBlockIndex] : null
        const firstContentBlock = msg.content[0]
        
        if (lastTextBlock && lastTextBlock.type === 'text' && firstContentBlock?.type === 'text') {
          // Join text with space
          lastTextBlock.text = `${lastTextBlock.text} ${firstContentBlock.text}`
          // Append remaining content blocks
          lastMsg.content.push(...msg.content.slice(1))
        } else {
          // Just append all content blocks
          lastMsg.content.push(...msg.content)
        }
        
        // Keep the cache breakpoint if either message had it
        if (msg.cacheBreakpoint) {
          lastMsg.cacheBreakpoint = msg.cacheBreakpoint
        }
      } else {
        // Different participant - start new message
        merged.push({ ...msg, content: [...msg.content] })
      }
    }

    return merged
  }

  private filterDotMessages(messages: DiscordMessage[]): DiscordMessage[] {
    return messages.filter((msg) => {
      // Filter messages starting with period (after stripping reply prefix)
      // Replies look like "<reply:@username> .test" so we need to strip the prefix
      const contentWithoutReply = msg.content.trim().replace(/^<reply:@[^>]+>\s*/, '')
      if (contentWithoutReply.startsWith('.')) {
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
   * 
   * Uses membrane's rolling logic pattern via ./rolling.ts helpers.
   */
  private applyLimits(
    messages: ParticipantMessage[],
    messagesSinceRoll: number,
    config: BotConfig
  ): { messages: ParticipantMessage[], didTruncate: boolean, messagesRemoved?: number } {
    // Calculate total characters (excludes images - they have separate limits)
    const totalChars = calculateCharacters(messages)
    
    // Use membrane's rolling decision logic
    const rollDecision = shouldRoll(messagesSinceRoll, totalChars, config)
    
    const normalLimit = config.recency_window_characters || 100000
    const messageLimit = config.recency_window_messages || Infinity
    
    // Hard limit exceeded - force truncation to normal limit
    if (rollDecision.hardLimitExceeded) {
      logger.warn({
        totalChars,
        hardMax: config.hard_max_characters || 500000,
        normalLimit,
        messageCount: messages.length
      }, 'HARD LIMIT EXCEEDED - Truncating to normal limit and forcing roll')
      
      const result = truncateToCharacterLimit(messages, normalLimit)
      return { 
        messages: result.messages, 
        didTruncate: true, 
        messagesRemoved: result.removed 
      }
    }
    
    // Not rolling yet - keep all messages for cache efficiency
    // Exception: if prompt_caching is disabled, always apply character limit
    if (!rollDecision.shouldRoll) {
      const cachingEnabled = config.prompt_caching !== false;
      if (cachingEnabled || totalChars <= normalLimit) {
        logger.debug({
          messagesSinceRoll,
          threshold: config.rolling_threshold,
          messageCount: messages.length,
          totalChars,
          totalMB: (totalChars / 1024 / 1024).toFixed(2),
          cachingEnabled,
        }, 'Not rolling yet - keeping all messages for cache')
        return { messages, didTruncate: false, messagesRemoved: 0 }
      }
      // Caching disabled and over limit - truncate anyway
      logger.info({
        totalChars,
        limit: normalLimit,
        messageCount: messages.length,
      }, 'Caching disabled - applying character limit without rolling')
    }
    
    // Time to roll - apply limits
    // Character limit
    if (totalChars > normalLimit) {
      logger.info({
        totalChars,
        limit: normalLimit,
        messageCount: messages.length,
        reason: rollDecision.reason
      }, 'Rolling: Character limit exceeded, truncating final context')
      
      const result = truncateToCharacterLimit(messages, normalLimit)
      return { 
        messages: result.messages, 
        didTruncate: true, 
        messagesRemoved: result.removed 
      }
    }
    
    // Message count limit
    if (messages.length > messageLimit) {
      logger.info({
        messageCount: messages.length,
        limit: messageLimit,
        keptChars: totalChars,
        reason: rollDecision.reason
      }, 'Rolling: Message count limit exceeded, truncating')
      
      const result = truncateToMessageLimit(messages, messageLimit)
      return { 
        messages: result.messages, 
        didTruncate: true, 
        messagesRemoved: result.removed 
      }
    }
    
    return { messages, didTruncate: false, messagesRemoved: 0 }
  }

  /**
   * Determine cache marker position using membrane's pattern.
   * Delegates to ./rolling.ts helpers.
   */
  private determineCacheMarkerFromMessages(
    messages: DiscordMessage[],
    lastMarker: string | null,
    didRoll: boolean
  ): string | null {
    // Extract message IDs and delegate to helper
    const messageIds = messages.map(m => m.id)
    return determineCacheMarker(messageIds, lastMarker, didRoll)
  }

  private async formatMessages(
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
    
    // Track image count and total base64 payload size to stay under API limits
    // Anthropic has ~10MB total request limit, we allow up to 8MB for images
    // TODO: Add deterministic image resampling for oversized images.
    //       CACHE IMPLICATION: Resampling MUST be deterministic (same input → same output)
    //       otherwise cached prefix will change on each call, invalidating the cache.
    //       Consider resampling only for ephemeral images where cache stability doesn't matter.
    const max_images = config.max_images || 5
    const maxTotalBase64Bytes = 15 * 1024 * 1024  // 15 MB total base64 data for images
    
    // Find cache marker position for image selection anchoring
    const cacheMarkerIndex = cacheMarkerMessageId 
      ? messages.findIndex(m => m.id === cacheMarkerMessageId)
      : -1
    
    // Image caching strategy:
    // - cache_images: false (DEFAULT) → Images only in rolling window (ephemeral)
    //   Simpler, guarantees cache stability since prefix is pure text
    // - cache_images: true → Two-tier: images in both prefix and rolling window
    //   Requires careful handling to maintain cache stability (future: deterministic resampling)
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
      // When enabled, select up to max_images from at/before cache marker
      // These are stable across calls - must be handled carefully for cache stability
      if (cacheImages) {
        const prefixEndIndex = cacheMarkerIndex >= 0 ? cacheMarkerIndex + 1 : messages.length
        for (let i = prefixEndIndex - 1; i >= 0 && prefixImageCount < max_images; i--) {
          const msg = messages[i]!
          for (const attachment of msg.attachments) {
            if (prefixImageCount >= max_images) break
            
            if (attachment.contentType?.startsWith('image/')) {
              const cached = imageMap.get(attachment.url)
              if (cached) {
                // Use post-resample target size for budget check if image exceeds per-image limit,
                // since the inclusion stage will resample it down to fit
                const rawBase64Size = Math.ceil(cached.data.length * 4 / 3)
                const base64Size = rawBase64Size > MAX_IMAGE_BASE64_BYTES
                  ? MAX_IMAGE_BASE64_BYTES  // will be resampled to fit this limit
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
      // Select up to maxEphemeralImages AFTER the cache marker
      // These don't affect caching since they're in the ephemeral portion
      // Select newest first (iterate backwards from end) so oldest ephemeral images drop first
      const ephemeralStartIndex = cacheMarkerIndex >= 0 ? cacheMarkerIndex + 1 : 0
      for (let i = messages.length - 1; i >= ephemeralStartIndex && ephemeralImageCount < maxEphemeralImages; i--) {
        const msg = messages[i]!

        // Skip if already selected in TIER 1 (avoid double-counting when ranges overlap)
        // This happens when cache_images=true and cacheMarkerIndex=-1 (no marker yet)
        if (messagesWithImages.has(msg.id)) continue

        for (const attachment of msg.attachments) {
          if (ephemeralImageCount >= maxEphemeralImages) break

          if (attachment.contentType?.startsWith('image/')) {
            const cached = imageMap.get(attachment.url)
            if (cached) {
              // Use post-resample target size for budget check if image exceeds per-image limit
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

              // Normalize image through sharp to strip problematic metadata/encoding
              // that can cause "Could not process image" errors from providers
              try {
                const normalized = await this.normalizeImage(imageData, mediaType)
                imageData = normalized.data
                mediaType = normalized.mediaType
              } catch (error) {
                logger.warn({ error, messageId: msg.id }, 'Failed to normalize image, using original')
              }

              const originalBase64Size = imageData.length * 4 / 3  // Approximate base64 size

              if (originalBase64Size > MAX_IMAGE_BASE64_BYTES) {
                try {
                  const resampled = await this.resampleImage(imageData, MAX_IMAGE_BASE64_BYTES)
                  imageData = resampled.data
                  mediaType = resampled.mediaType
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
              
              // Use cached token estimate, or calculate from dimensions
              const tokenEstimate = cached.tokenEstimate || 
                Math.ceil((cached.width || 1024) * (cached.height || 1024) / 750)
              
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  data: base64Data,
                  media_type: mediaType,  // Anthropic API uses snake_case
                },
                tokenEstimate,  // For accurate context size calculation
              } as any)
              
              logger.debug({ 
                messageId: msg.id, 
                url: attachment.url,
                sizeMB: (base64Data.length / 1024 / 1024).toFixed(2),
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
            // Wrap in XML block with filename
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
      // For other participants, use their Discord display name
      const isBotMessage = botDiscordUsername && msg.author.displayName === botDiscordUsername
      const participant = isBotMessage ? config.name : msg.author.displayName
      
      // Normalize mentions and replies to this bot to use config.name
      // Discord mentions: <@username>, replies: <reply:@username>
      if (botDiscordUsername && botDiscordUsername !== config.name) {
        // Escape special regex characters in the username (e.g., dots in "Opus 4.5")
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

      // Strip reply tags from context if configured
      if (!config.include_reply_tags) {
        for (const block of content) {
          if (block.type === 'text') {
            block.text = block.text.replace(/^<reply:@[^>]+>\s*/, '')
          }
        }
      }

      participantMessages.push({
        participant,
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

  /**
   * Limit MCP images (from tool results) - keeps the LATEST images
   * MCP tool results have participant names like "System<[tool_name]"
   */
  private limitMcpImages(messages: ParticipantMessage[], maxMcpImages: number): void {
    // Collect MCP image positions (from tool result messages)
    const mcpImagePositions: Array<{ msgIndex: number; contentIndex: number }> = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      // MCP tool results have participant like "System<[tool_name]"
      if (!msg.participant.startsWith('System<[')) continue
      
      for (let j = 0; j < msg.content.length; j++) {
        if (msg.content[j]!.type === 'image') {
          mcpImagePositions.push({ msgIndex: i, contentIndex: j })
        }
      }
    }

    if (mcpImagePositions.length <= maxMcpImages) {
      return // Under limit, nothing to do
    }

    // Remove OLDEST images (keep the latest ones at the end)
    // Images are in chronological order, so remove from the beginning
    const toRemove = mcpImagePositions.length - maxMcpImages
    
    // Remove in reverse order of contentIndex within each message to preserve indices
    // Group by msgIndex first
    const removalsByMsg = new Map<number, number[]>()
    for (let i = 0; i < toRemove; i++) {
      const pos = mcpImagePositions[i]!
      if (!removalsByMsg.has(pos.msgIndex)) {
        removalsByMsg.set(pos.msgIndex, [])
      }
      removalsByMsg.get(pos.msgIndex)!.push(pos.contentIndex)
    }

    // Remove in reverse contentIndex order within each message
    for (const [msgIndex, contentIndices] of removalsByMsg) {
      contentIndices.sort((a, b) => b - a) // Descending order
      for (const contentIndex of contentIndices) {
        messages[msgIndex]!.content.splice(contentIndex, 1)
      }
    }

    logger.debug({
      totalMcpImages: mcpImagePositions.length,
      removed: toRemove,
      kept: maxMcpImages,
    }, 'Limited MCP images in context (kept latest)')
  }

  /**
   * Normalize an image by re-encoding through sharp to strip problematic
   * metadata (EXIF, ICC profiles, XMP) that can cause provider-side
   * "Could not process image" errors. Preserves dimensions and quality.
   */
  private async normalizeImage(
    data: Buffer,
    mediaType: string
  ): Promise<{ data: Buffer; mediaType: string }> {
    const image = sharp(data)
    const metadata = await image.metadata()

    if (metadata.hasAlpha || mediaType === 'image/png') {
      const output = await sharp(data).png({ compressionLevel: 6 }).toBuffer()
      return { data: output, mediaType: 'image/png' }
    }

    const output = await sharp(data).jpeg({ quality: 95, mozjpeg: true }).toBuffer()
    return { data: output, mediaType: 'image/jpeg' }
  }

  /**
   * Resample an image to fit within the target base64 size limit.
   * Uses progressive quality reduction and resizing.
   */
  private async resampleImage(
    data: Buffer,
    maxBase64Bytes: number
  ): Promise<{ data: Buffer; mediaType: string }> {
    // Target raw bytes (base64 adds ~33% overhead)
    const targetBytes = Math.floor(maxBase64Bytes * 0.75)
    
    let image = sharp(data)
    const metadata = await image.metadata()
    
    // Start with original dimensions
    let width = metadata.width || 1920
    let height = metadata.height || 1080
    let quality = 85
    
    // Convert to JPEG for better compression (unless it's a PNG with transparency)
    const hasAlpha = metadata.hasAlpha
    const outputFormat = hasAlpha ? 'png' : 'jpeg'
    
    // Iteratively reduce size until under limit
    for (let attempt = 0; attempt < 5; attempt++) {
      image = sharp(data).resize(width, height, { fit: 'inside', withoutEnlargement: true })
      
      let output: Buffer
      if (outputFormat === 'jpeg') {
        output = await image.jpeg({ quality, mozjpeg: true }).toBuffer()
      } else {
        output = await image.png({ compressionLevel: 9 }).toBuffer()
      }
      
      // Check if under limit
      if (output.length <= targetBytes) {
        return { 
          data: output, 
          mediaType: outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png' 
        }
      }
      
      // Reduce quality or dimensions for next attempt
      if (quality > 50) {
        quality -= 15
      } else {
        // Reduce dimensions by 20%
        width = Math.floor(width * 0.8)
        height = Math.floor(height * 0.8)
        quality = 75  // Reset quality when reducing size
      }
    }
    
    // Final attempt: aggressive resize
    const finalImage = sharp(data)
      .resize(Math.floor(width * 0.5), Math.floor(height * 0.5), { fit: 'inside' })
    
    const finalOutput = outputFormat === 'jpeg' 
      ? await finalImage.jpeg({ quality: 60 }).toBuffer()
      : await finalImage.png({ compressionLevel: 9 }).toBuffer()
    
    return { 
      data: finalOutput, 
      mediaType: outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png' 
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
      // Result can be: string (legacy), { output, images } (new format), or other object
      const resultContent: ContentBlock[] = []
      
      if (typeof entry.result === 'string') {
        // Legacy string result
        resultContent.push({ type: 'text', text: entry.result })
      } else if (entry.result && typeof entry.result === 'object') {
        // New format with output and optional images
        const output = entry.result.output
        const outputText = typeof output === 'string' ? output : JSON.stringify(output)
        resultContent.push({ type: 'text', text: outputText })
        
        // Add MCP images to context
        if (entry.result.images && Array.isArray(entry.result.images)) {
          for (const img of entry.result.images) {
            if (img.data && img.mimeType) {
              resultContent.push({
                type: 'image',
                source: {
                  type: 'base64',
                  data: img.data,
                  media_type: img.mimeType,
                },
              } as ImageContent)
            }
          }
        }
      } else {
        resultContent.push({ type: 'text', text: String(entry.result) })
      }
      
      messages.push({
        participant: `System<[${entry.call.name}]`,
        content: resultContent,
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
    
    // Build unified messageContexts map from all activations (prefix/suffix per message)
    const messageContextsMap = new Map<string, MessageContext>()
    // Also track which activation each message belongs to (for consecutive merging)
    const messageToActivationId = new Map<string, string>()
    for (const activation of activations) {
      if (activation.messageContexts) {
        for (const [msgId, context] of Object.entries(activation.messageContexts)) {
          // Handle legacy format: string -> { prefix: string }
          if (typeof context === 'string') {
            messageContextsMap.set(msgId, { prefix: context })
          } else {
            messageContextsMap.set(msgId, context)
          }
          messageToActivationId.set(msgId, activation.id)
        }
      }
    }
    
    // Build a map of messageId -> completion (legacy fallback for activations without messageContexts)
    const completionMap = new Map<string, { activation: Activation; completion: Completion }>()
    for (const activation of activations) {
      for (const completion of activation.completions) {
        for (const msgId of completion.sentMessageIds) {
          completionMap.set(msgId, { activation, completion })
        }
      }
    }
    
    logger.debug({
      messageContextsCount: messageContextsMap.size,
      completionMapSize: completionMap.size,
      completionMapKeys: Array.from(completionMap.keys()),
    }, 'Built context maps')
    
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
      
      // Check if this message has prefix/suffix to inject (new per-message system)
      if (msg.messageId && msg.participant === botName && messageContextsMap.has(msg.messageId)) {
        const context = messageContextsMap.get(msg.messageId)!
        
        // Prepend prefix and append suffix to existing content
        // This preserves the Discord message content while wrapping with invisible context
        const existingText = msg.content
          .filter(c => c.type === 'text')
          .map(c => (c as { type: 'text'; text: string }).text)
          .join('')
        
        const newText = (context.prefix || '') + existingText + (context.suffix || '')
        msg.content = [{ type: 'text', text: newText }]
        
        logger.debug({ 
          messageId: msg.messageId, 
          prefixLength: context.prefix?.length ?? 0,
          suffixLength: context.suffix?.length ?? 0,
          hasToolXml: context.prefix?.includes('function_calls') || context.suffix?.includes('function_calls'),
        }, 'Injected prefix/suffix context')
      }
      // Fallback: check legacy completion map (for activations without messageContexts)
      else if (msg.messageId && msg.participant === botName && completionMap.has(msg.messageId)) {
        const { completion } = completionMap.get(msg.messageId)!
        // Replace content with full completion text (legacy behavior)
        msg.content = [{ type: 'text', text: completion.text }]
        logger.debug({ 
          messageId: msg.messageId, 
          originalLength: msg.content[0]?.type === 'text' ? (msg.content[0] as any).text?.length : 0,
          newLength: completion.text.length 
        }, 'Injected full completion into bot message (legacy)')
      } else if (msg.messageId && msg.participant === botName) {
        // Log why we didn't inject with more detail
        const msgId = msg.messageId  // Narrow type for TypeScript
        const mapKeys = Array.from(completionMap.keys())
        const exactMatch = mapKeys.find(k => k === msgId)
        const includesMatch = mapKeys.find(k => k.includes(msgId) || msgId.includes(k))
        logger.debug({
          messageId: msg.messageId,
          messageIdType: typeof msg.messageId,
          participant: msg.participant,
          inMessageContexts: messageContextsMap.has(msg.messageId),
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
    
    // MERGE CONSECUTIVE MESSAGES from same activation to avoid spurious prefixes
    // Forward pass: merge consecutive bot messages that belong to the same activation
    const indicesToRemove: number[] = []
    let i = 0
    while (i < messages.length) {
      const msg = messages[i]!
      
      // Only process bot messages with messageContexts entries
      if (msg.participant !== botName || !msg.messageId || !messageToActivationId.has(msg.messageId)) {
        i++
        continue
      }
      
      const activationId = messageToActivationId.get(msg.messageId)!
      let mergedContent = msg.content[0]?.type === 'text' ? (msg.content[0] as any).text : ''
      let mergeCount = 0
      
      // Look ahead for consecutive messages from same activation
      let j = i + 1
      while (j < messages.length) {
        const nextMsg = messages[j]!
        
        // Must be same participant and same activation
        if (nextMsg.participant !== botName || 
            !nextMsg.messageId || 
            messageToActivationId.get(nextMsg.messageId) !== activationId) {
          break
        }
        
        // Merge this message's content (context chunk) into the first
        const nextContent = nextMsg.content[0]?.type === 'text' ? (nextMsg.content[0] as any).text : ''
        if (nextContent) {
          mergedContent += nextContent  // Concatenate context chunks
        }
        
        // Mark for removal
        indicesToRemove.push(j)
        mergeCount++
        j++
      }
      
      // If we merged anything, update the first message's content
      if (mergeCount > 0) {
        msg.content = [{ type: 'text', text: mergedContent }]
        logger.debug({
          primaryMessageId: msg.messageId,
          mergedCount: mergeCount,
          totalLength: mergedContent.length,
        }, 'Merged consecutive activation messages')
      }
      
      i = j  // Skip past merged messages
    }
    
    // Remove merged messages (in reverse order to avoid index shifting)
    for (let k = indicesToRemove.length - 1; k >= 0; k--) {
      messages.splice(indicesToRemove[k]!, 1)
    }
    
    if (indicesToRemove.length > 0) {
      logger.debug({
        removedCount: indicesToRemove.length,
        remainingMessages: messages.length,
      }, 'Removed merged secondary messages')
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
    // Collect at least 10 for stop sequences (post-hoc truncation catches ALL participants anyway)
    const recentParticipants: string[] = []
    const seen = new Set<string>()
    const minParticipants = Math.max(config.recent_participant_count, 10)

    // Iterate backwards to get most recent participants and their mentions
    for (let i = participantMessages.length - 1; i >= 0 && recentParticipants.length < minParticipants; i--) {
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
            if (!seen.has(mentionedUser) && recentParticipants.length < minParticipants) {
              seen.add(mentionedUser)
              recentParticipants.push(mentionedUser)
            }
          }
        }
      }
    }

    // Priority order for stop sequences:
    // 1. Turn end token / message delimiter (if configured - for model-specific turn boundaries)
    // 2. Recent participant names (most likely to appear next)
    // 3. Configured stop sequences
    // 4. System prefixes and boundary markers (less critical)
    // Note: APIs with limits (OpenAI: 4) will truncate, but post-hoc truncation catches all participants
    
    // Add turn end token first (highest priority - stops at end of turn for Gemini etc)
    if (config.turn_end_token) {
      sequences.push(config.turn_end_token)
    }
    
    // Add message delimiter (for base models)
    if (config.message_delimiter) {
      sequences.push(config.message_delimiter)
    }

    // Add participant names with newline prefix (in priority order - most recent first)
    // Use all collected participants - post-hoc truncation catches everyone anyway
    for (const participant of recentParticipants) {
      sequences.push(`\n${participant}:`)
    }

    // Add configured stop sequences (user-defined are important)
    sequences.push(...config.stop_sequences)
    
    // Add system message prefixes (lower priority)
    sequences.push('\nSystem:')
    
    // Add conversation boundary marker (lowest priority)
    sequences.push('<<HUMAN_CONVERSATION_END>>')

    return sequences
  }

  private extractModelConfig(config: BotConfig): ModelConfig {
    return {
      model: config.continuation_model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      top_p: config.top_p,
      prefill_thinking: config.prefill_thinking,
      botName: config.name,
      messageDelimiter: config.message_delimiter,
      turnEndToken: config.turn_end_token,
      presence_penalty: config.presence_penalty,
      frequency_penalty: config.frequency_penalty,
      prompt_caching: config.prompt_caching,
      cache_ttl: config.cache_ttl,
      participant_stop_sequences: config.participant_stop_sequences,
      generate_images: config.generate_images,
      provider_params: config.provider_params,
    }
  }
}

