/**
 * Terminal pipeline stages: stop sequences, model config extraction, and trace info
 */

import type {
  ParticipantMessage,
  BotConfig,
  ModelConfig,
  DiscordContext,
  ToolCall,
} from '../../types.js'
import type {
  ContextBuildInfo,
  ContextMessageInfo,
  MessageTransformation,
} from '../../trace/index.js'
import {
  estimateMessageTokens,
  estimateSystemTokens,
  extractTextContent,
} from '../../trace/tokens.js'

export interface TraceMetadata {
  originalMessageCount: number
  filteredCount: number
  mergedMessageIds: Set<string>
  didTruncate: boolean
  messagesRolledOff: number
  cacheMarker: string | null
  lastCacheMarker: string | null
  stopSequences: string[]
}

/**
 * Build LLM stop sequences from recent participants and config.
 *
 * Priority order:
 * 1. Turn end token / message delimiter (model-specific turn boundaries)
 * 2. Recent participant names (most likely to appear next)
 * 3. Configured stop sequences
 * 4. System prefixes and boundary markers
 */
export function buildStopSequences(
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

  // Add turn end token first (highest priority - stops at end of turn for Gemini etc)
  if (config.turn_end_token) {
    sequences.push(config.turn_end_token)
  }

  // Add message delimiter (for base models)
  if (config.message_delimiter) {
    sequences.push(config.message_delimiter)
  }

  // Add participant names with newline prefix (in priority order - most recent first)
  // Skip numeric-only participants (unresolved Discord user ID mentions like <@123456>)
  // When prefill_thinking is enabled, exclude the bot's own name — the model may
  // legitimately emit "\nBotName:" after </thinking> to start the visible response.
  for (const participant of recentParticipants) {
    if (config.prefill_thinking && participant === config.name) {
      continue
    }
    if (/^\d+$/.test(participant)) {
      continue
    }
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

/**
 * Extract ModelConfig subset from BotConfig for the LLM request.
 */
export function extractModelConfig(config: BotConfig): ModelConfig {
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
    mode: config.mode,
    streaming: config.streaming,
  }
}

/**
 * Build trace info for debugging context assembly.
 */
export function buildTraceInfo(
  finalMessages: ParticipantMessage[],
  _discordContext: DiscordContext,
  toolCacheWithResults: Array<{call: ToolCall, result: any}>,
  config: BotConfig,
  metadata: TraceMetadata
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
