import type {
  ParticipantMessage,
  ContentBlock,
  ImageContent,
  ToolCall,
  DiscordMessage,
} from '../../types.js'
import { logger } from '../../utils/logger.js'
import { toolOutputText } from '../../tools/output-text.js'

export function collectCoveredToolMessageIds(
  toolCacheWithResults: Array<{ call: ToolCall; result: any }>,
  discordMessages: DiscordMessage[]
): Set<string> {
  const covered = new Set<string>()
  const messagesById = new Map(discordMessages.map(message => [message.id, message]))

  for (const entry of toolCacheWithResults) {
    if (!messagesById.has(entry.call.messageId)) continue

    const botMessageIds = new Set(entry.call.botMessageIds || [])
    for (const id of entry.call.coveredMessageIds ?? botMessageIds) {
      if (botMessageIds.has(id) && messagesById.has(id)) covered.add(id)
    }
  }

  return covered
}

export function formatToolUseWithResults(
  toolCacheWithResults: Array<{call: ToolCall, result: any, resultOmitted?: boolean}>,
  botName: string
): ParticipantMessage[] {
  const messages: ParticipantMessage[] = []
  let previousCompletionKey: string | undefined

  for (const entry of toolCacheWithResults) {
    const completionText = entry.call.originalCompletionText || ''
    const coveredMessageIds = entry.call.coveredMessageIds
    const completionKey = coveredMessageIds !== undefined && coveredMessageIds.length > 0
      ? `covers\0${coveredMessageIds.join('\0')}`
      : `${entry.call.messageId}\0${completionText}`
    if (completionText && completionKey !== previousCompletionKey) {
      messages.push({
        participant: botName,
        content: [{ type: 'text', text: completionText }],
        timestamp: entry.call.timestamp,
        messageId: entry.call.messageId,
      })
    }
    previousCompletionKey = completionKey
    if (entry.resultOmitted) continue

    const resultContent: ContentBlock[] = []

    if (typeof entry.result === 'string') {
      resultContent.push({ type: 'text', text: entry.result })
    } else if (entry.result && typeof entry.result === 'object') {
      const output = entry.result.output
      const outputText = entry.result.error
        ? `Error executing ${entry.call.name}: ${entry.result.error}`
        : toolOutputText(output)
      resultContent.push({ type: 'text', text: outputText })

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

export function interleaveToolMessages(
  participantMessages: ParticipantMessage[],
  toolMessages: ParticipantMessage[]
): ParticipantMessage[] {
  const toolsByMessageId = new Map<string, ParticipantMessage[]>()
  for (const toolMessage of toolMessages) {
    const messageId = toolMessage.messageId || ''
    if (!toolsByMessageId.has(messageId)) {
      toolsByMessageId.set(messageId, [])
    }
    toolsByMessageId.get(messageId)!.push(toolMessage)
  }

  const interleavedMessages: ParticipantMessage[] = []
  for (const msg of participantMessages) {
    interleavedMessages.push(msg)
    if (msg.messageId && toolsByMessageId.has(msg.messageId)) {
      interleavedMessages.push(...toolsByMessageId.get(msg.messageId)!)
    }
  }

  return interleavedMessages
}

export function limitMcpImages(messages: ParticipantMessage[], maxMcpImages: number): void {
  const mcpImagePositions: Array<{ msgIndex: number; contentIndex: number }> = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (!msg.participant.startsWith('System<[')) continue

    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j]!.type === 'image') {
        mcpImagePositions.push({ msgIndex: i, contentIndex: j })
      }
    }
  }

  if (mcpImagePositions.length <= maxMcpImages) {
    return
  }

  const toRemove = mcpImagePositions.length - maxMcpImages

  const removalsByMsg = new Map<number, number[]>()
  for (let i = 0; i < toRemove; i++) {
    const pos = mcpImagePositions[i]!
    if (!removalsByMsg.has(pos.msgIndex)) {
      removalsByMsg.set(pos.msgIndex, [])
    }
    removalsByMsg.get(pos.msgIndex)!.push(pos.contentIndex)
  }

  for (const [msgIndex, contentIndices] of removalsByMsg) {
    contentIndices.sort((a, b) => b - a)
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
