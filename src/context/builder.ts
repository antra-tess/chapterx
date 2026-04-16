/**
 * Context Builder — Thin Orchestrator
 *
 * Transforms Discord messages to normalized participant-based LLM context.
 * Each pipeline stage is implemented in a focused module under ./stages/.
 */

import {
  LLMRequest,
  ContextBuildResult,
  ParticipantMessage,
  DiscordContext,
  ToolCall,
  BotConfig,
} from '../types.js'
import { Activation } from '../activation/index.js'
import { logger } from '../utils/logger.js'
import {
  determineCacheMarker,
  applyChapterXCacheMarker,
} from './rolling.js'
import {
  ContextBuildInfo,
  getCurrentTrace,
} from '../trace/index.js'
import { ContextInjection } from '../tools/plugins/types.js'

// Pipeline stages
import {
  mergeConsecutiveBotMessages,
  filterDotMessages,
  mergeConsecutiveParticipantMessages,
} from './stages/message-filtering.js'
import { formatMessages } from './stages/format-messages.js'
import {
  formatToolUseWithResults,
  interleaveToolMessages,
  limitMcpImages,
} from './stages/tool-interleave.js'
import {
  injectActivationCompletions,
  insertPluginInjections,
} from './stages/injections.js'
import {
  applyLimits,
  determineCacheMarkerFromMessages,
  recoverOrphanedCacheMarker,
} from './stages/cache-and-limits.js'
import {
  buildStopSequences,
  extractModelConfig,
  buildTraceInfo,
} from './stages/finalize.js'

export interface BuildContextParams {
  discordContext: DiscordContext
  toolCacheWithResults: Array<{call: ToolCall, result: any}>
  lastCacheMarker: string | null
  messagesSinceRoll: number
  config: BotConfig
  botDiscordUsername?: string
  activations?: Activation[]
  pluginInjections?: ContextInjection[]
}

export interface ContextBuildResultWithTrace extends ContextBuildResult {
  traceInfo?: ContextBuildInfo
}

export class ContextBuilder {
  async buildContext(params: BuildContextParams): Promise<ContextBuildResultWithTrace> {
    const { discordContext, toolCacheWithResults, lastCacheMarker, messagesSinceRoll, config, botDiscordUsername, activations, pluginInjections } = params
    const originalMessageCount = discordContext.messages.length

    let messages = discordContext.messages
    const mergedMessageIds = new Set<string>()

    // 1. Merge consecutive bot messages
    const botDisplayName = botDiscordUsername || config.name
    if (!config.preserve_thinking_context) {
      const beforeMerge = messages.length
      messages = mergeConsecutiveBotMessages(messages, botDisplayName)
      if (messages.length < beforeMerge) {
        const afterIds = new Set(messages.map(m => m.id))
        discordContext.messages.forEach(m => {
          if (!afterIds.has(m.id)) mergedMessageIds.add(m.id)
        })
      }
    }

    // 2. Filter dot messages
    const beforeFilter = messages.length
    messages = filterDotMessages(messages, config.steer_visible === true)
    const filteredCount = beforeFilter - messages.length

    logger.debug({
      lastMessageIds: messages.slice(-5).map(m => m.id),
      totalAfterFilter: messages.length,
    }, 'Messages after dot filtering')

    // 2.5. Pre-determine cache marker for image selection
    let imageSelectionMarker = lastCacheMarker
    if (!imageSelectionMarker && messages.length > 0) {
      const buffer = 20
      const messageIds = messages.map(m => m.id)
      const botIds = new Set<string>()
      for (const m of messages) {
        if (m.author.displayName === botDisplayName) {
          botIds.add(m.id)
        }
      }
      imageSelectionMarker = determineCacheMarker(messageIds, null, true, buffer, botIds.size > 0 ? botIds : undefined)
      logger.debug({
        calculatedMarker: imageSelectionMarker,
        messagesLength: messages.length,
      }, 'Pre-calculated cache marker for image selection (first activation)')
    }

    // 3. Convert to participant messages
    let participantMessages = await formatMessages(
      messages,
      discordContext.images,
      discordContext.documents,
      config,
      botDiscordUsername,
      imageSelectionMarker
    )

    logger.debug({
      lastParticipantIds: participantMessages.slice(-5).map(m => m.messageId),
      totalParticipants: participantMessages.length,
    }, 'Participant messages after formatMessages')

    // 4. Interleave historical tool use from cache
    if (!config.preserve_thinking_context) {
      const toolMessages = formatToolUseWithResults(toolCacheWithResults, config.name)
      const interleavedMessages = interleaveToolMessages(participantMessages, toolMessages)

      logger.debug({
        discordMessages: messages.length,
        toolCallsWithResults: toolCacheWithResults.length,
        toolMessages: toolMessages.length,
        interleavedTotal: interleavedMessages.length
      }, 'Context assembly complete with interleaved tools')

      participantMessages.length = 0
      participantMessages.push(...interleavedMessages)

      if (config.max_mcp_images >= 0) {
        limitMcpImages(participantMessages, config.max_mcp_images)
      }
    } else {
      logger.debug({
        discordMessages: messages.length,
        toolCallsWithResults: toolCacheWithResults.length,
      }, 'Skipping tool cache interleaving (preserve_thinking_context enabled)')
    }

    // 5. Inject activation completions
    if (config.preserve_thinking_context && activations && activations.length > 0) {
      injectActivationCompletions(participantMessages, activations, config.name)
    }

    // 6. Inject plugin context injections
    if (pluginInjections && pluginInjections.length > 0) {
      insertPluginInjections(participantMessages, pluginInjections, messages)
    }

    // 7. Merge consecutive messages from the same participant
    participantMessages = mergeConsecutiveParticipantMessages(participantMessages)

    // 8. Apply limits
    const { messages: finalMessages, didTruncate, messagesRemoved } = applyLimits(
      participantMessages,
      messagesSinceRoll,
      config
    )
    if (finalMessages !== participantMessages) {
      participantMessages.length = 0
      participantMessages.push(...finalMessages)
    }

    // 9. Determine and apply cache marker
    let cacheMarker = determineCacheMarkerFromMessages(messages, lastCacheMarker, didTruncate, botDisplayName)
    if (cacheMarker) {
      cacheMarker = recoverOrphanedCacheMarker(cacheMarker, participantMessages, config.name)
      if (cacheMarker) {
        participantMessages = applyChapterXCacheMarker(participantMessages, cacheMarker)
      }
    }

    // 10. Add empty completion message
    participantMessages.push({
      participant: config.name,
      content: [{ type: 'text', text: '' }],
    })

    // 11. Build stop sequences and model config
    const stop_sequences = buildStopSequences(participantMessages, config)
    logger.debug({ stop_sequences, participantCount: participantMessages.length }, 'Built stop sequences')

    const request: LLMRequest = {
      messages: participantMessages,
      system_prompt: config.system_prompt,
      context_prefix: config.context_prefix,
      prefill_user_message: config.prefill_user_message,
      config: extractModelConfig(config),
      tools: config.tools_enabled ? undefined : undefined,  // Tools added by Agent Loop
      stop_sequences,
    }

    // 12. Build trace info
    const traceInfo = buildTraceInfo(
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
}

// Re-export mention helpers for backward compatibility (used by display-names.test.ts)
export { rewriteMentionsForDisplayNames, stripReplyTags } from './stages/mentions.js'
