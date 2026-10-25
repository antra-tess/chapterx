import type {
  ParticipantMessage,
  ContentBlock,
  DiscordMessage,
} from '../../types.js'
import type { Activation, Completion, MessageContext } from '../../activation/index.js'
import type { ContextInjection } from '../../tools/plugins/types.js'
import { logger } from '../../utils/logger.js'

function stripBridgeOpen(text: string, bridgeOpen?: string): string {
  if (!bridgeOpen) return text
  if (text.startsWith(bridgeOpen)) return text.slice(bridgeOpen.length)

  // Fence reopeners include an info string. Discord fetch normalization can
  // rewrite mentions/emojis in that info string, so match the marker line by
  // fence marker instead of requiring byte-for-byte equality.
  const marker = /^(`{3,}|~{3,}).*\n$/.exec(bridgeOpen)?.[1]
  if (!marker) return text

  const lineEnd = text.indexOf('\n')
  if (lineEnd < 0) return text
  const firstLine = text.slice(0, lineEnd)
  const actualMarker = /^(`{3,}|~{3,})/.exec(firstLine)?.[1]
  if (actualMarker === marker) {
    return text.slice(lineEnd + 1)
  }
  return text
}

function stripBridgeClose(text: string, bridgeClose?: string): string {
  if (!bridgeClose) return text
  if (text.endsWith(bridgeClose)) return text.slice(0, text.length - bridgeClose.length)
  return text
}

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

  const messageContextsMap = new Map<string, MessageContext>()
  const messageToActivationId = new Map<string, string>()
  for (const activation of activations) {
    if (activation.messageContexts) {
      for (const [msgId, context] of Object.entries(activation.messageContexts)) {
        if (typeof context === 'string') {
          messageContextsMap.set(msgId, { prefix: context })
        } else {
          messageContextsMap.set(msgId, context)
        }
        messageToActivationId.set(msgId, activation.id)
      }
    }
  }

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

  // Thinking-only phantoms stay out: shown in context, the model sees "I was
  // activated and only thought, never responded" and repeats it.
  const phantomInsertions = new Map<string, Completion[]>()
  for (const activation of activations) {
    let currentAnchor = activation.trigger.anchorMessageId

    for (const completion of activation.completions) {
      if (completion.sentMessageIds.length === 0) {
        const visibleText = completion.text
          .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
          .trim()

        if (visibleText.length > 0) {
          const existing = phantomInsertions.get(currentAnchor) || []
          existing.push(completion)
          phantomInsertions.set(currentAnchor, existing)
        } else {
          logger.debug({
            activationId: activation.id,
            textPreview: completion.text.substring(0, 80),
          }, 'Skipping thinking-only phantom (no visible content)')
        }
      } else {
        currentAnchor = completion.sentMessageIds[completion.sentMessageIds.length - 1] || currentAnchor
      }
    }
  }

  const botMessages = messages.filter(m => m.participant === botName)
  logger.debug({
    botMessageCount: botMessages.length,
    botMessageIds: botMessages.map(m => m.messageId),
    botName,
  }, 'Bot messages in context')

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!

    if (msg.messageId && msg.participant === botName && messageContextsMap.has(msg.messageId)) {
      const context = messageContextsMap.get(msg.messageId)!

      let existingText = msg.content
        .filter(c => c.type === 'text')
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('')

      existingText = stripBridgeOpen(existingText, context.bridgeOpen)
      existingText = stripBridgeClose(existingText, context.bridgeClose)

      const newText = (context.prefix || '') + existingText + (context.suffix || '')
      msg.content = [{ type: 'text', text: newText }]

      logger.debug({
        messageId: msg.messageId,
        prefixLength: context.prefix?.length ?? 0,
        suffixLength: context.suffix?.length ?? 0,
        hasToolXml: context.prefix?.includes('function_calls') || context.suffix?.includes('function_calls'),
      }, 'Injected prefix/suffix context')
    }
    else if (msg.messageId && msg.participant === botName && completionMap.has(msg.messageId)) {
      const { completion } = completionMap.get(msg.messageId)!
      msg.content = [{ type: 'text', text: completion.text }]
      logger.debug({
        messageId: msg.messageId,
        originalLength: msg.content[0]?.type === 'text' ? (msg.content[0] as any).text?.length : 0,
        newLength: completion.text.length
      }, 'Injected full completion into bot message (legacy)')
    } else if (msg.messageId && msg.participant === botName) {
      const msgId = msg.messageId
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

    if (msg.messageId && phantomInsertions.has(msg.messageId)) {
      const phantoms = phantomInsertions.get(msg.messageId)!
      const phantomMessages: ParticipantMessage[] = phantoms.map(p => ({
        participant: botName,
        content: [{ type: 'text', text: p.text }],
      }))
      messages.splice(i + 1, 0, ...phantomMessages)
      logger.debug({
        afterMessageId: msg.messageId,
        phantomCount: phantomMessages.length
      }, 'Inserted phantom completions')
    }
  }

  const indicesToRemove: number[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!

    if (msg.participant !== botName || !msg.messageId || !messageToActivationId.has(msg.messageId)) {
      i++
      continue
    }

    const activationId = messageToActivationId.get(msg.messageId)!
    let mergedContent = msg.content[0]?.type === 'text' ? (msg.content[0] as any).text : ''
    let mergeCount = 0

    let j = i + 1
    while (j < messages.length) {
      const nextMsg = messages[j]!

      if (nextMsg.participant !== botName ||
          !nextMsg.messageId ||
          messageToActivationId.get(nextMsg.messageId) !== activationId) {
        break
      }

      const nextContent = nextMsg.content[0]?.type === 'text' ? (nextMsg.content[0] as any).text : ''
      if (nextContent) {
        mergedContent += nextContent
      }

      indicesToRemove.push(j)
      mergeCount++
      j++
    }

    if (mergeCount > 0) {
      msg.content = [{ type: 'text', text: mergedContent }]
      logger.debug({
        primaryMessageId: msg.messageId,
        mergedCount: mergeCount,
        totalLength: mergedContent.length,
      }, 'Merged consecutive activation messages')
    }

    i = j
  }

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

export function insertPluginInjections(
  messages: ParticipantMessage[],
  injections: ContextInjection[],
  discordMessages: DiscordMessage[]
): void {
  if (injections.length === 0) return

  const messagePositions = new Map<string, number>()
  for (let i = 0; i < discordMessages.length; i++) {
    messagePositions.set(discordMessages[i]!.id, i)
  }

  const injectionsWithDepth = injections.map(injection => {
    let currentDepth: number
    const isFromEarliest = injection.targetDepth < 0

    if (isFromEarliest) {
      currentDepth = injection.targetDepth
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

  const fromEarliest = injectionsWithDepth.filter(i => i.isFromEarliest)
  const fromLatest = injectionsWithDepth.filter(i => !i.isFromEarliest)

  fromEarliest.sort((a, b) => {
    if (a.currentDepth !== b.currentDepth) return a.currentDepth - b.currentDepth
    return (b.injection.priority || 0) - (a.injection.priority || 0)
  })

  fromLatest.sort((a, b) => {
    if (a.currentDepth !== b.currentDepth) return b.currentDepth - a.currentDepth
    return (b.injection.priority || 0) - (a.injection.priority || 0)
  })

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
