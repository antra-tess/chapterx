/**
 * Tool cache interleaving and MCP image limiting
 */

import type {
  ParticipantMessage,
  ContentBlock,
  ImageContent,
  ToolCall,
} from '../../types.js'
import { logger } from '../../utils/logger.js'

/**
 * Format tool cache entries as paired bot-completion + system-result messages.
 * Each entry produces two ParticipantMessages: the bot's original completion text
 * and the system tool result.
 */
export function formatToolUseWithResults(
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
 * Interleave tool messages with participant messages based on messageId.
 * Tool call/result pairs are inserted after the message that triggered them.
 */
export function interleaveToolMessages(
  participantMessages: ParticipantMessage[],
  toolMessages: ParticipantMessage[]
): ParticipantMessage[] {
  // Create a map of triggering message ID -> tool messages
  const toolsByMessageId = new Map<string, ParticipantMessage[]>()
  for (let i = 0; i < toolMessages.length; i += 2) {
    const toolCall = toolMessages[i]
    const toolResult = toolMessages[i + 1]
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

  return interleavedMessages
}

/**
 * Limit MCP images (from tool results) — keeps the LATEST images.
 * MCP tool results have participant names like "System<[tool_name]".
 * Mutates the messages array in place.
 */
export function limitMcpImages(messages: ParticipantMessage[], maxMcpImages: number): void {
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
  const toRemove = mcpImagePositions.length - maxMcpImages

  // Remove in reverse order of contentIndex within each message to preserve indices
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
