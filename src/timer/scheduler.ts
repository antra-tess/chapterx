/**
 * Timer Scheduler
 *
 * Core component that manages scheduled wake timers.
 * - Persists timers to disk (survives restarts)
 * - Runs background check for due timers
 * - Fires self_activation events when timers trigger
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { logger } from '../utils/logger.js'
import { Event } from '../types.js'

export interface ScheduledTimer {
  id: string
  botId: string
  channelId: string
  guildId: string
  triggerAt: number  // Unix timestamp ms
  contextNote: string  // What the bot wanted to remember
  createdAt: number
  createdByMessageId: string
}

interface TimerStore {
  timers: ScheduledTimer[]
  version: number
}

export class TimerScheduler {
  private timers: Map<string, ScheduledTimer> = new Map()
  private checkInterval: NodeJS.Timeout | null = null
  private storePath: string
  private onTimerFire: ((event: Event) => void) | null = null

  // Check interval in ms (3 seconds for responsive short timers)
  private static readonly CHECK_INTERVAL_MS = 3_000

  constructor(cacheDir: string = './cache') {
    this.storePath = join(cacheDir, 'timers.json')
  }

  /**
   * Initialize the scheduler - load timers and start background checker
   */
  async initialize(onTimerFire: (event: Event) => void): Promise<void> {
    this.onTimerFire = onTimerFire

    // Load persisted timers
    await this.loadTimers()

    // Start background check
    this.startChecker()

    logger.info({
      timerCount: this.timers.size,
      checkIntervalMs: TimerScheduler.CHECK_INTERVAL_MS,
    }, 'Timer scheduler initialized')
  }

  /**
   * Schedule a wake timer
   */
  async scheduleTimer(params: {
    botId: string
    channelId: string
    guildId: string
    delayMinutes: number
    contextNote: string
    messageId: string
  }): Promise<ScheduledTimer> {
    const timer: ScheduledTimer = {
      id: `timer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      botId: params.botId,
      channelId: params.channelId,
      guildId: params.guildId,
      triggerAt: Date.now() + (params.delayMinutes * 60 * 1000),
      contextNote: params.contextNote,
      createdAt: Date.now(),
      createdByMessageId: params.messageId,
    }

    this.timers.set(timer.id, timer)
    await this.saveTimers()

    const triggerDate = new Date(timer.triggerAt)
    logger.info({
      timerId: timer.id,
      botId: timer.botId,
      channelId: timer.channelId,
      delayMinutes: params.delayMinutes,
      triggerAt: triggerDate.toISOString(),
    }, 'Timer scheduled')

    return timer
  }

  /**
   * Cancel a timer by ID
   */
  async cancelTimer(timerId: string): Promise<boolean> {
    const timer = this.timers.get(timerId)
    if (!timer) {
      return false
    }

    this.timers.delete(timerId)
    await this.saveTimers()

    logger.info({ timerId }, 'Timer cancelled')
    return true
  }

  /**
   * Get all timers for a bot/channel
   */
  getTimers(botId: string, channelId?: string): ScheduledTimer[] {
    const timers: ScheduledTimer[] = []
    for (const timer of this.timers.values()) {
      if (timer.botId === botId) {
        if (!channelId || timer.channelId === channelId) {
          timers.push(timer)
        }
      }
    }
    return timers.sort((a, b) => a.triggerAt - b.triggerAt)
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    logger.info('Timer scheduler stopped')
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private startChecker(): void {
    this.checkInterval = setInterval(() => {
      this.checkDueTimers()
    }, TimerScheduler.CHECK_INTERVAL_MS)
  }

  private async checkDueTimers(): Promise<void> {
    const now = Date.now()
    const dueTimers: ScheduledTimer[] = []

    for (const timer of this.timers.values()) {
      if (timer.triggerAt <= now) {
        dueTimers.push(timer)
      }
    }

    if (dueTimers.length === 0) {
      return
    }

    logger.debug({ dueCount: dueTimers.length }, 'Found due timers')

    // Fire events for each due timer
    for (const timer of dueTimers) {
      this.fireTimer(timer)
      this.timers.delete(timer.id)
    }

    // Save after removing fired timers
    await this.saveTimers()
  }

  private fireTimer(timer: ScheduledTimer): void {
    if (!this.onTimerFire) {
      logger.warn({ timerId: timer.id }, 'Timer fired but no handler registered')
      return
    }

    const event: Event = {
      type: 'self_activation',
      channelId: timer.channelId,
      guildId: timer.guildId,
      timestamp: new Date(),
      data: {
        timerId: timer.id,
        botId: timer.botId,
        contextNote: timer.contextNote,
        scheduledAt: timer.createdAt,
        originalMessageId: timer.createdByMessageId,
      },
    }

    logger.info({
      timerId: timer.id,
      botId: timer.botId,
      channelId: timer.channelId,
      contextNote: timer.contextNote.slice(0, 100),
    }, 'Timer fired - sending self_activation event')

    this.onTimerFire(event)
  }

  private async loadTimers(): Promise<void> {
    try {
      if (!existsSync(this.storePath)) {
        logger.debug('No timer store found, starting fresh')
        return
      }

      const data = await readFile(this.storePath, 'utf-8')
      const store: TimerStore = JSON.parse(data)

      // Filter out expired timers on load
      const now = Date.now()
      let expiredCount = 0

      for (const timer of store.timers) {
        if (timer.triggerAt > now) {
          this.timers.set(timer.id, timer)
        } else {
          expiredCount++
          // Fire expired timers that were missed (e.g., during downtime)
          logger.info({
            timerId: timer.id,
            missedBy: Math.round((now - timer.triggerAt) / 1000),
          }, 'Firing missed timer from downtime')
          this.fireTimer(timer)
        }
      }

      logger.info({
        loaded: this.timers.size,
        expired: expiredCount,
      }, 'Loaded timers from disk')

    } catch (error) {
      logger.error({ error }, 'Failed to load timers')
    }
  }

  private async saveTimers(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = dirname(this.storePath)
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }

      const store: TimerStore = {
        timers: Array.from(this.timers.values()),
        version: 1,
      }

      await writeFile(this.storePath, JSON.stringify(store, null, 2))
      logger.debug({ timerCount: store.timers.length }, 'Saved timers to disk')

    } catch (error) {
      logger.error({ error }, 'Failed to save timers')
    }
  }
}

// Singleton instance
let schedulerInstance: TimerScheduler | null = null

export function getTimerScheduler(): TimerScheduler | null {
  return schedulerInstance
}

export function createTimerScheduler(cacheDir?: string): TimerScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new TimerScheduler(cacheDir)
  }
  return schedulerInstance
}
