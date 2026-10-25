import { logger } from '../utils/logger.js'
import type { Event } from '../types.js'
import { LLMError } from '../types.js'

export interface DeferredActivation {
  id: string
  botId: string
  channelId: string
  guildId: string
  originalTriggerId?: string
  retryAttempt: number
  errorType: 'server' | 'rate_limit' | 'network' | 'timeout'
  errorMessage: string
  scheduledAt: number
  createdAt: number
  retryAfterMs?: number
}

export interface DeferredQueueConfig {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  cooldownMs?: number
  checkIntervalMs?: number
}

export interface TransientErrorInfo {
  isTransient: boolean
  errorType: 'server' | 'rate_limit' | 'network' | 'timeout' | null
  retryAfterMs?: number
  message: string
}

export function classifyError(error: unknown): TransientErrorInfo {
  if (error && typeof error === 'object') {
    const memErr = error as { type?: string; retryable?: boolean; retryAfterMs?: number; message?: string }

    if (memErr.retryable === true) {
      const errorType = memErr.type as 'server' | 'rate_limit' | 'network' | 'timeout'
      if (['server', 'rate_limit', 'network', 'timeout'].includes(errorType)) {
        return {
          isTransient: true,
          errorType,
          retryAfterMs: memErr.retryAfterMs,
          message: memErr.message || 'Unknown error',
        }
      }
    }
  }

  if (error instanceof LLMError && error.details) {
    const inner = error.details as { status?: number; statusCode?: number }
    const status = inner?.status || inner?.statusCode

    if (status === 429) {
      return {
        isTransient: true,
        errorType: 'rate_limit',
        message: error.message,
      }
    }

    if (status && status >= 500 && status < 600) {
      return {
        isTransient: true,
        errorType: 'server',
        message: error.message,
      }
    }
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes('econnreset') || msg.includes('socket') || msg.includes('network') || msg.includes('econnrefused')) {
      return {
        isTransient: true,
        errorType: 'network',
        message: error.message,
      }
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return {
        isTransient: true,
        errorType: 'timeout',
        message: error.message,
      }
    }
    // Anthropic overloaded error
    if (msg.includes('overloaded') || msg.includes('529')) {
      return {
        isTransient: true,
        errorType: 'server',
        message: error.message,
      }
    }
  }

  return {
    isTransient: false,
    errorType: null,
    message: error instanceof Error ? error.message : String(error),
  }
}

export function isTransientError(error: unknown): boolean {
  return classifyError(error).isTransient
}

export class DeferredQueue {
  private queue: Map<string, DeferredActivation> = new Map()
  private cooldowns: Map<string, number> = new Map()
  private checkInterval: NodeJS.Timeout | null = null
  private onFire: ((event: Event) => void) | null = null

  private maxRetries: number
  private baseDelayMs: number
  private maxDelayMs: number
  private cooldownMs: number
  private checkIntervalMs: number

  constructor(config: DeferredQueueConfig = {}) {
    this.maxRetries = config.maxRetries ?? 5
    this.baseDelayMs = config.baseDelayMs ?? 30_000
    this.maxDelayMs = config.maxDelayMs ?? 300_000
    this.cooldownMs = config.cooldownMs ?? 3_600_000
    this.checkIntervalMs = config.checkIntervalMs ?? 5_000
  }

  async initialize(botId: string, onFire: (event: Event) => void): Promise<void> {
    this.onFire = onFire
    this.startChecker()
    logger.info({
      botId,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      checkIntervalMs: this.checkIntervalMs,
    }, 'DeferredQueue initialized')
  }

  queueActivation(params: {
    botId: string
    channelId: string
    guildId: string
    error: Error
    originalTriggerId?: string
    retryAttempt?: number
    originalCreatedAt?: number
  }): boolean {
    const { botId, channelId, guildId, error, originalTriggerId, retryAttempt = 0, originalCreatedAt } = params

    if (this.queue.has(channelId)) {
      logger.debug({ channelId }, 'Channel already has queued activation')
      return false
    }

    const cooldownUntil = this.cooldowns.get(channelId)
    if (cooldownUntil && Date.now() < cooldownUntil) {
      logger.debug({ channelId, cooldownUntil }, 'Channel is in cooldown')
      return false
    }

    const errorInfo = classifyError(error)
    if (!errorInfo.isTransient) {
      logger.debug({ channelId, error: errorInfo.message }, 'Error is not transient, not queuing')
      return false
    }

    if (retryAttempt >= this.maxRetries) {
      const cooldownUntil = Date.now() + this.cooldownMs
      this.cooldowns.set(channelId, cooldownUntil)
      logger.warn({
        channelId,
        retryAttempt,
        maxRetries: this.maxRetries,
        cooldownMs: this.cooldownMs,
      }, 'Max retries reached, entering cooldown')
      return false
    }

    let delayMs = this.baseDelayMs * Math.pow(2, retryAttempt)

    if (errorInfo.retryAfterMs && errorInfo.retryAfterMs > delayMs) {
      delayMs = errorInfo.retryAfterMs
    }

    delayMs = Math.min(delayMs, this.maxDelayMs)

    const now = Date.now()
    const activation: DeferredActivation = {
      id: `deferred_${now}_${Math.random().toString(36).slice(2, 8)}`,
      botId,
      channelId,
      guildId,
      originalTriggerId,
      retryAttempt: retryAttempt + 1,
      errorType: errorInfo.errorType!,
      errorMessage: errorInfo.message,
      scheduledAt: now + delayMs,
      createdAt: retryAttempt === 0 ? now : (originalCreatedAt ?? now),
      retryAfterMs: errorInfo.retryAfterMs,
    }

    this.queue.set(channelId, activation)

    logger.info({
      channelId,
      retryAttempt: activation.retryAttempt,
      errorType: activation.errorType,
      delayMs,
      scheduledAt: new Date(activation.scheduledAt).toISOString(),
    }, 'Queued deferred activation')

    return true
  }

  cancelActivation(channelId: string): boolean {
    const had = this.queue.has(channelId)
    if (had) {
      this.queue.delete(channelId)
      logger.info({ channelId }, 'Cancelled deferred activation')
    }
    return had
  }

  hasPendingActivation(channelId: string): boolean {
    return this.queue.has(channelId)
  }

  getPendingActivation(channelId: string): DeferredActivation | undefined {
    return this.queue.get(channelId)
  }

  getQueueState(): DeferredActivation[] {
    return Array.from(this.queue.values())
  }

  getCooldownState(): { channelId: string; until: Date }[] {
    const now = Date.now()
    return Array.from(this.cooldowns.entries())
      .filter(([_, until]) => until > now)
      .map(([channelId, until]) => ({ channelId, until: new Date(until) }))
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    logger.info('DeferredQueue stopped')
  }

  private startChecker(): void {
    this.checkInterval = setInterval(() => {
      this.checkDueActivations()
    }, this.checkIntervalMs)
  }

  private checkDueActivations(): void {
    const now = Date.now()

    for (const [channelId, activation] of this.queue.entries()) {
      if (activation.scheduledAt <= now) {
        this.queue.delete(channelId)

        this.fireActivation(activation)
      }
    }

    for (const [channelId, until] of this.cooldowns.entries()) {
      if (until <= now) {
        this.cooldowns.delete(channelId)
      }
    }
  }

  private fireActivation(activation: DeferredActivation): void {
    if (!this.onFire) {
      logger.error({ activation }, 'Cannot fire activation - no callback registered')
      return
    }

    const event: Event = {
      type: 'self_activation',
      channelId: activation.channelId,
      guildId: activation.guildId,
      timestamp: new Date(),
      data: {
        type: 'deferred_retry',
        botId: activation.botId,
        originalTriggerId: activation.originalTriggerId,
        retryAttempt: activation.retryAttempt,
        errorType: activation.errorType,
        errorMessage: activation.errorMessage,
        scheduledAt: activation.scheduledAt,
        createdAt: activation.createdAt,
      },
    }

    logger.info({
      channelId: activation.channelId,
      retryAttempt: activation.retryAttempt,
      errorType: activation.errorType,
    }, 'Firing deferred activation')

    this.onFire(event)
  }
}
