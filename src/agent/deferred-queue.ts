/**
 * Deferred Activation Queue
 *
 * Handles transient API failures (Anthropic overloaded, rate limits) by
 * queuing retries at the activation level rather than API level.
 * This allows fresh context to be built when retrying.
 *
 * Key features:
 * - One queued activation per channel (prevents buildup)
 * - Exponential backoff (30s → 1m → 2m → 4m → 5m cap), continues for ~24h
 * - 1 hour cooldown period after exhaustion
 * - Fires self_activation events to main EventQueue
 */

import { logger } from '../utils/logger.js'
import type { Event } from '../types.js'
import { LLMError } from '../types.js'

// ============================================================================
// Types
// ============================================================================

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
  /** Maximum retry attempts per activation (default: 300, ~24h at 5min cap) */
  maxRetries?: number
  /** Base delay between retries in ms (default: 30000 = 30s) */
  baseDelayMs?: number
  /** Maximum delay between retries in ms (default: 300000 = 5 min) */
  maxDelayMs?: number
  /** Cooldown period after max retries in ms (default: 3600000 = 1 hour) */
  cooldownMs?: number
  /** Background checker interval in ms (default: 5000 = 5s) */
  checkIntervalMs?: number
}

export interface TransientErrorInfo {
  isTransient: boolean
  errorType: 'server' | 'rate_limit' | 'network' | 'timeout' | null
  retryAfterMs?: number
  message: string
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classify an error to determine if it's transient and should be retried
 */
export function classifyError(error: unknown): TransientErrorInfo {
  // Check for membrane-style errors (has type and retryable fields)
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

  // Check for LLMError wrapping Anthropic/HTTP errors
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

  // Check for network errors by message
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

/**
 * Check if an error is transient and should be retried
 */
export function isTransientError(error: unknown): boolean {
  return classifyError(error).isTransient
}

// ============================================================================
// DeferredQueue Class
// ============================================================================

export class DeferredQueue {
  private queue: Map<string, DeferredActivation> = new Map()
  private cooldowns: Map<string, number> = new Map()
  private checkInterval: NodeJS.Timeout | null = null
  private onFire: ((event: Event) => void) | null = null

  // Configuration
  private maxRetries: number
  private baseDelayMs: number
  private maxDelayMs: number
  private cooldownMs: number
  private checkIntervalMs: number

  constructor(config: DeferredQueueConfig = {}) {
    this.maxRetries = config.maxRetries ?? 300         // ~24h at 5min cap
    this.baseDelayMs = config.baseDelayMs ?? 30_000
    this.maxDelayMs = config.maxDelayMs ?? 300_000     // 5 min cap
    this.cooldownMs = config.cooldownMs ?? 3_600_000   // 1 hour
    this.checkIntervalMs = config.checkIntervalMs ?? 5_000
  }

  /**
   * Initialize the queue with a callback for firing events
   */
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

  /**
   * Queue a deferred activation for a channel
   *
   * Returns false if:
   * - Channel already has a queued activation
   * - Channel is in cooldown period
   * - Error is not transient
   */
  queueActivation(params: {
    botId: string
    channelId: string
    guildId: string
    error: Error
    originalTriggerId?: string
    retryAttempt?: number
  }): boolean {
    const { botId, channelId, guildId, error, originalTriggerId, retryAttempt = 0 } = params

    // Check if already queued
    if (this.queue.has(channelId)) {
      logger.debug({ channelId }, 'Channel already has queued activation')
      return false
    }

    // Check cooldown
    const cooldownUntil = this.cooldowns.get(channelId)
    if (cooldownUntil && Date.now() < cooldownUntil) {
      logger.debug({ channelId, cooldownUntil }, 'Channel is in cooldown')
      return false
    }

    // Classify error
    const errorInfo = classifyError(error)
    if (!errorInfo.isTransient) {
      logger.debug({ channelId, error: errorInfo.message }, 'Error is not transient, not queuing')
      return false
    }

    // Check max retries
    if (retryAttempt >= this.maxRetries) {
      // Enter cooldown
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

    // Calculate delay with exponential backoff
    let delayMs = this.baseDelayMs * Math.pow(2, retryAttempt)

    // Use server-provided retry-after if available and longer
    if (errorInfo.retryAfterMs && errorInfo.retryAfterMs > delayMs) {
      delayMs = errorInfo.retryAfterMs
    }

    // Cap at max delay
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
      createdAt: retryAttempt === 0 ? now : this.queue.get(channelId)?.createdAt ?? now,
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

  /**
   * Cancel pending activation for a channel
   */
  cancelActivation(channelId: string): boolean {
    const had = this.queue.has(channelId)
    if (had) {
      this.queue.delete(channelId)
      logger.info({ channelId }, 'Cancelled deferred activation')
    }
    return had
  }

  /**
   * Check if channel has pending deferred activation
   */
  hasPendingActivation(channelId: string): boolean {
    return this.queue.has(channelId)
  }

  /**
   * Get pending activation for a channel (if any)
   */
  getPendingActivation(channelId: string): DeferredActivation | undefined {
    return this.queue.get(channelId)
  }

  /**
   * Get all queued activations (for debugging/monitoring)
   */
  getQueueState(): DeferredActivation[] {
    return Array.from(this.queue.values())
  }

  /**
   * Get cooldown state (for debugging/monitoring)
   */
  getCooldownState(): { channelId: string; until: Date }[] {
    const now = Date.now()
    return Array.from(this.cooldowns.entries())
      .filter(([_, until]) => until > now)
      .map(([channelId, until]) => ({ channelId, until: new Date(until) }))
  }

  /**
   * Stop the background checker
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    logger.info('DeferredQueue stopped')
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private startChecker(): void {
    this.checkInterval = setInterval(() => {
      this.checkDueActivations()
    }, this.checkIntervalMs)
  }

  private checkDueActivations(): void {
    const now = Date.now()

    for (const [channelId, activation] of this.queue.entries()) {
      if (activation.scheduledAt <= now) {
        // Remove from queue before firing
        this.queue.delete(channelId)

        // Fire the activation
        this.fireActivation(activation)
      }
    }

    // Clean up expired cooldowns
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
