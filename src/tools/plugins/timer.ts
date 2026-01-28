/**
 * Timer Plugin
 *
 * Allows the bot to schedule wake-up timers for self-activation.
 * The bot can set a timer to be reminded about something later.
 *
 * Uses the core TimerScheduler for persistence and event firing.
 */

import { ToolPlugin, PluginContext, PluginStateContext, ContextInjection } from './types.js'
import { getTimerScheduler, ScheduledTimer } from '../../timer/scheduler.js'
import { logger } from '../../utils/logger.js'

// Max delay in minutes (default: 24 hours)
const MAX_DELAY_MINUTES = 24 * 60

// Max timers per channel
const MAX_TIMERS_PER_CHANNEL = 5

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60

  if (hours > 0) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`
  }
  if (minutes > 0) {
    return seconds > 0
      ? `${minutes}m ${seconds}s`
      : `${minutes}m`
  }
  return `${seconds}s`
}

function formatTimerList(timers: ScheduledTimer[]): string {
  if (timers.length === 0) {
    return 'No active timers.'
  }

  const now = Date.now()
  const lines = timers.map((t, i) => {
    const remaining = t.triggerAt - now
    const timeStr = remaining > 0
      ? `in ${formatDuration(remaining)}`
      : 'due now'
    return `${i + 1}. [${t.id}] ${timeStr} - "${t.contextNote.slice(0, 50)}${t.contextNote.length > 50 ? '...' : ''}"`
  })

  return lines.join('\n')
}

const plugin: ToolPlugin = {
  name: 'timer',
  description: 'Schedule wake-up timers for self-activation',

  tools: [
    {
      name: 'schedule_wake',
      description: 'Schedule a timer to wake yourself up later. When the timer fires, you will be activated with the context note you provide. Use this to continue work, check on something, or remind yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          delay_minutes: {
            type: 'number',
            description: 'How many minutes from now to wake up. Accepts decimals for finer control (e.g., 0.5 = 30 seconds, 0.1 = 6 seconds). Range: 0.05-1440 (3 seconds to 24 hours)',
          },
          context_note: {
            type: 'string',
            description: 'What you want to remember when you wake up. Be specific about what you were doing or need to check.',
          },
        },
        required: ['delay_minutes', 'context_note'],
      },
      handler: async (
        input: { delay_minutes: number; context_note: string },
        context: PluginContext
      ) => {
        const scheduler = getTimerScheduler()
        if (!scheduler) {
          return 'Error: Timer scheduler not initialized'
        }

        // Validate delay (minimum ~3 seconds = 0.05 minutes)
        if (input.delay_minutes < 0.05) {
          return 'Error: Delay must be at least 0.05 minutes (3 seconds)'
        }
        if (input.delay_minutes > MAX_DELAY_MINUTES) {
          return `Error: Delay cannot exceed ${MAX_DELAY_MINUTES} minutes (24 hours)`
        }

        // Check timer limit for this channel
        const existingTimers = scheduler.getTimers(context.botId, context.channelId)
        if (existingTimers.length >= MAX_TIMERS_PER_CHANNEL) {
          return `Error: Maximum ${MAX_TIMERS_PER_CHANNEL} timers per channel. Cancel one first with cancel_wake.`
        }

        // Validate context note
        if (!input.context_note || input.context_note.trim().length < 5) {
          return 'Error: Please provide a meaningful context note (at least 5 characters)'
        }
        if (input.context_note.length > 500) {
          return 'Error: Context note too long (max 500 characters)'
        }

        try {
          const timer = await scheduler.scheduleTimer({
            botId: context.botId,
            channelId: context.channelId,
            guildId: context.guildId,
            delayMinutes: input.delay_minutes,
            contextNote: input.context_note.trim(),
            messageId: context.currentMessageId,
          })

          const triggerTime = new Date(timer.triggerAt)
          return `Timer scheduled! I will wake up in ${formatDuration(input.delay_minutes * 60000)} (at ${triggerTime.toLocaleTimeString()}).\n\nTimer ID: ${timer.id}\nContext: "${input.context_note}"`

        } catch (error) {
          logger.error({ error }, 'Failed to schedule timer')
          return `Error scheduling timer: ${error}`
        }
      },
    },

    {
      name: 'list_timers',
      description: 'List all active wake timers for this channel',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_input: any, context: PluginContext) => {
        const scheduler = getTimerScheduler()
        if (!scheduler) {
          return 'Error: Timer scheduler not initialized'
        }

        const timers = scheduler.getTimers(context.botId, context.channelId)
        return formatTimerList(timers)
      },
    },

    {
      name: 'cancel_wake',
      description: 'Cancel a scheduled wake timer by ID',
      inputSchema: {
        type: 'object',
        properties: {
          timer_id: {
            type: 'string',
            description: 'The timer ID to cancel (e.g., timer_abc123)',
          },
        },
        required: ['timer_id'],
      },
      handler: async (input: { timer_id: string }, context: PluginContext) => {
        const scheduler = getTimerScheduler()
        if (!scheduler) {
          return 'Error: Timer scheduler not initialized'
        }

        // Verify timer belongs to this bot/channel
        const timers = scheduler.getTimers(context.botId, context.channelId)
        const timer = timers.find(t => t.id === input.timer_id)

        if (!timer) {
          return `Timer not found: ${input.timer_id}. Use list_timers to see active timers.`
        }

        const cancelled = await scheduler.cancelTimer(input.timer_id)
        if (cancelled) {
          return `Timer cancelled: ${input.timer_id}`
        } else {
          return `Failed to cancel timer: ${input.timer_id}`
        }
      },
    },
  ],

  /**
   * Show pending timers in context
   */
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const scheduler = getTimerScheduler()
    if (!scheduler) {
      return []
    }

    const timers = scheduler.getTimers(context.botId, context.channelId)
    if (timers.length === 0) {
      return []
    }

    const now = Date.now()
    const timerLines = timers.map(t => {
      const remaining = t.triggerAt - now
      const timeStr = remaining > 0 ? formatDuration(remaining) : 'due'
      return `- [${t.id}] ${timeStr}: "${t.contextNote.slice(0, 80)}${t.contextNote.length > 80 ? '...' : ''}"`
    })

    const content = [
      '## ⏰ Active Timers',
      '',
      ...timerLines,
      '',
      '_Use schedule_wake/cancel_wake to manage timers._',
    ].join('\n')

    return [{
      id: 'timer-display',
      content,
      targetDepth: 8,  // Show near other status info
      priority: 90,
    }]
  },
}

export default plugin
