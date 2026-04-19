/**
 * Context injection stages: activation completions and plugin injections
 */

import type {
  ParticipantMessage,
  ContentBlock,
  DiscordMessage,
} from '../../types.js'
import type { Activation, Completion, MessageContext } from '../../activation/index.js'
import type { ContextInjection } from '../../tools/plugins/types.js'
import { logger } from '../../utils/logger.js'

/**
 * Inject activation completions into participant messages.
 * - Replaces bot message content with full completion text (including thinking)
 * - Inserts phantom completions after their anchor messages
 * - Merges consecutive messages from the same activation
 *
 * Mutates the messages array in place.
 */
export function injectActivationCompletions(
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
  // Skip thinking-only phantoms — injecting them into context creates a feedback loop
  // where the model sees "I was activated and only thought, never responded" and repeats.
  const phantomInsertions = new Map<string, Completion[]>()
  for (const activation of activations) {
    let currentAnchor = activation.trigger.anchorMessageId

    for (const completion of activation.completions) {
      if (completion.sentMessageIds.length === 0) {
        // Phantom — check if it has any visible content beyond thinking tags
        const visibleText = completion.text
          .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
          .trim()

        if (visibleText.length > 0) {
          // Has visible content - insert as phantom
          const existing = phantomInsertions.get(currentAnchor) || []
          existing.push(completion)
          phantomInsertions.set(currentAnchor, existing)
        } else {
          // Thinking-only phantom - skip injection to prevent cascade
          logger.debug({
            activationId: activation.id,
            textPreview: completion.text.substring(0, 80),
          }, 'Skipping thinking-only phantom (no visible content)')
        }
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
 * Insert plugin context injections at calculated depths.
 *
 * Depth 0 = after the most recent message
 * Depth N = N messages from the end
 * Negative depth = from the start (-1 = position 0)
 *
 * Injections age from 0 (when modified) toward their targetDepth.
 * Mutates the messages array in place.
 */
export function insertPluginInjections(
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
  const injectionsWithDepth = injections.map(injection => {
    let currentDepth: number
    const isFromEarliest = injection.targetDepth < 0

    if (isFromEarliest) {
      currentDepth = injection.targetDepth  // Keep negative for sorting
    } else if (!injection.lastModifiedAt) {
      currentDepth = injection.targetDepth
    } else {
      const position = messagePositions.get(injection.lastModifiedAt)
      if (position === undefined) {
        currentDepth = injection.targetDepth
      } else {
        const messagesSince = discordMessages.length - 1 - position
        currentDepth = Math.min(messagesSince, injection.targetDepth)
      }
    }

    return { injection, currentDepth, isFromEarliest }
  })

  // Separate "from earliest" (negative) and "from latest" (positive) injections
  const fromEarliest = injectionsWithDepth.filter(i => i.isFromEarliest)
  const fromLatest = injectionsWithDepth.filter(i => !i.isFromEarliest)

  // Sort "from earliest" by position (most negative first), then by priority
  fromEarliest.sort((a, b) => {
    if (a.currentDepth !== b.currentDepth) return a.currentDepth - b.currentDepth
    return (b.injection.priority || 0) - (a.injection.priority || 0)
  })

  // Sort "from latest" by depth (deepest first), then by priority
  fromLatest.sort((a, b) => {
    if (a.currentDepth !== b.currentDepth) return b.currentDepth - a.currentDepth
    return (b.injection.priority || 0) - (a.injection.priority || 0)
  })

  // Insert "from latest" first (they reference end of array which won't shift)
  for (const { injection, currentDepth } of fromLatest) {
    const insertIndex = Math.max(0, messages.length - currentDepth)

    const content: ContentBlock[] = typeof injection.content === 'string'
      ? [{ type: 'text', text: injection.content }]
      : injection.content

    const injectionMessage: ParticipantMessage = {
      participant: injection.asSystem ? 'System' : 'System>[plugin]',
      content,
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
  for (let i = fromEarliest.length - 1; i >= 0; i--) {
    const { injection, currentDepth } = fromEarliest[i]!

    const insertIndex = Math.min(messages.length, Math.abs(currentDepth) - 1)

    const content: ContentBlock[] = typeof injection.content === 'string'
      ? [{ type: 'text', text: injection.content }]
      : injection.content

    const injectionMessage: ParticipantMessage = {
      participant: injection.asSystem ? 'System' : 'System>[plugin]',
      content,
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
