/**
 * Sleep Plugin
 *
 * Exposes a tool that lets the bot put itself to sleep in a channel.
 * The tool sends a visible `.sleep` dot-command message, pins it, and
 * reacts with a sleep emoji — reusing the existing pinned-sleep machinery.
 */

import type { ToolPlugin, PluginContext } from './types.js'
import { logger } from '../../utils/logger.js'

/**
 * Parse a human-friendly duration string into seconds.
 * Accepts: "30m", "2h", "1h30m", "90s", "1d", "45", plain number (minutes).
 */
function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase()

  // Compound: "1h30m", "2h15m"
  const compound = s.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (compound && (compound[1] || compound[2] || compound[3] || compound[4])) {
    const days = parseInt(compound[1] || '0')
    const hours = parseInt(compound[2] || '0')
    const minutes = parseInt(compound[3] || '0')
    const seconds = parseInt(compound[4] || '0')
    return days * 86400 + hours * 3600 + minutes * 60 + seconds
  }

  // Plain number → treat as minutes
  if (/^\d+(\.\d+)?$/.test(s)) {
    const num = parseFloat(s)
    if (num > 0) return Math.round(num * 60)
  }

  return null
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

const MAX_DURATION_SECONDS = 7 * 24 * 3600  // 1 week

const sleepPlugin: ToolPlugin = {
  name: 'sleep',
  description: 'Put the bot to sleep in a channel via visible .sleep command',

  tools: [
    {
      name: 'go_to_sleep',
      description: 'Stop responding in this channel for a specified duration. Sends a visible .sleep command, pins it, and reacts. Other users can unpin to wake you early.',
      inputSchema: {
        type: 'object',
        properties: {
          duration: {
            type: 'string',
            description: 'How long to sleep. Examples: "30m", "2h", "1h30m", "6h", "1d". Plain number is treated as minutes.',
          },
          reason: {
            type: 'string',
            description: 'Optional: why you are going to sleep (shown in the pin).',
          },
        },
        required: ['duration'],
      },
      handler: async (
        input: { duration: string; reason?: string },
        context: PluginContext
      ) => {
        const seconds = parseDuration(input.duration)
        if (seconds === null || seconds <= 0) {
          return `Error: Could not parse duration "${input.duration}". Use formats like "30m", "2h", "1h30m", "1d".`
        }
        if (seconds > MAX_DURATION_SECONDS) {
          return `Error: Maximum sleep duration is 7 days.`
        }

        const now = new Date()
        const wakeAt = new Date(now.getTime() + seconds * 1000)

        // Build the .sleep message
        const yamlLines = [
          `started_at: ${now.toISOString()}`,
          `duration_seconds: ${seconds}`,
        ]
        if (input.reason) {
          const sanitized = input.reason.replace(/[\n\r]/g, ' ').trim()
          yamlLines.push(`reason: ${JSON.stringify(sanitized)}`)
        }

        const botName = context.config?.name || context.botId
        const message = `.sleep ${botName}\n---\n${yamlLines.join('\n')}`

        // Send the .sleep message
        let messageIds: string[]
        try {
          messageIds = await context.sendMessage(message)
        } catch (error) {
          logger.error({ error }, 'Failed to send .sleep message')
          return `Error: Could not send .sleep message: ${error}`
        }
        if (!messageIds || messageIds.length === 0) {
          return 'Error: Failed to send .sleep message (no message ID returned)'
        }

        const sleepMsgId = messageIds[0]!

        // Pin it — this is what activates the sleep machinery
        try {
          await context.pinMessage(sleepMsgId)
        } catch (error) {
          logger.error({ error, messageId: sleepMsgId }, 'Failed to pin .sleep message')
          return `Error: .sleep message sent but could not pin it (channel may have hit the 50-pin limit). Sleep is NOT active.`
        }

        // React — purely cosmetic, don't fail the whole operation
        try {
          await context.addReaction(sleepMsgId, '😴')
        } catch (error) {
          logger.warn({ error, messageId: sleepMsgId }, 'Failed to react to .sleep message')
        }

        logger.info({
          botId: context.botId,
          channelId: context.channelId,
          durationSeconds: seconds,
          wakeAt: wakeAt.toISOString(),
          reason: input.reason,
        }, 'Bot self-sleep activated')

        return `Going to sleep for ${formatDuration(seconds)}. Will wake at ${wakeAt.toISOString()}. Unpin the .sleep message to wake early.`
      },
    },
  ],
}

export default sleepPlugin
