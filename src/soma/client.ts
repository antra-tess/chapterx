/**
 * Soma Client
 * Lightweight client for the Soma credit management API
 * 
 * This is an optional integration - bots can run without Soma enabled.
 * When enabled, users must have sufficient ichor (credits) to trigger bot responses.
 */

import { SomaConfig, SomaCheckResult } from '../types.js'
import { logger } from '../utils/logger.js'

/**
 * Trigger types that cost ichor
 * - mention: User @mentions the bot
 * - reply: User replies to bot's message  
 * - m_command: User uses "m continue" or similar
 * 
 * Random activations do NOT cost ichor
 */
export type SomaTriggerType = 'mention' | 'reply' | 'm_command'

export interface SomaCheckParams {
  userId: string           // Discord user ID
  serverId: string         // Discord guild ID
  channelId: string        // Discord channel ID (for reactions)
  botId: string            // Bot's Discord ID
  messageId: string        // Triggering message ID
  triggerType: SomaTriggerType
  userRoles: string[]      // User's role IDs for cost multipliers
}

/** 
 * @deprecated Soma bot now handles these reactions
 * Kept for backwards compatibility but no longer used by ChapterX
 */
export const INSUFFICIENT_FUNDS_EMOJI = '💸'

/** 
 * @deprecated Soma bot now handles these reactions
 * Kept for backwards compatibility but no longer used by ChapterX
 */
export const DM_FAILED_EMOJI = '📭'

/**
 * Emoji for bot not configured in Soma
 * ChapterX adds this reaction since Soma can't handle unconfigured bots
 */
export const BOT_NOT_CONFIGURED_EMOJI = '⚙️'

export class SomaClient {
  private baseUrl: string
  private token: string

  constructor(config: SomaConfig) {
    this.baseUrl = config.url.replace(/\/$/, '')  // Remove trailing slash
    this.token = config.token || process.env.SOMA_TOKEN || ''
    
    if (!this.token) {
      logger.warn('Soma client initialized without token - API calls will fail')
    }
  }

  /**
   * Check if user has sufficient credits and deduct if so
   * This is an atomic operation - check and deduction happen together
   */
  async checkAndDeduct(params: SomaCheckParams): Promise<SomaCheckResult> {
    const url = `${this.baseUrl}/check-and-deduct`
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: params.userId,
          serverId: params.serverId,
          channelId: params.channelId,
          botId: params.botId,
          messageId: params.messageId,
          triggerType: params.triggerType,
          userRoles: params.userRoles,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        
        // Try to parse error response
        let errorData: { error?: string } = {}
        try {
          errorData = JSON.parse(errorText)
        } catch {
          // Not JSON, that's fine
        }

        // BOT_NOT_CONFIGURED = block activation, let ChapterX add ⚙️ reaction
        if (errorData.error === 'BOT_NOT_CONFIGURED') {
          logger.warn({ 
            status: response.status, 
            botId: params.botId,
            serverId: params.serverId,
          }, 'Bot not configured in Soma - blocking activation')
          
          return {
            allowed: false,
            cost: 0,
            reason: 'bot_not_configured',
          }
        }

        logger.error({ 
          status: response.status, 
          error: errorText,
          url 
        }, 'Soma API request failed')
        
        // On other API errors, allow the activation (fail open)
        // This prevents Soma outages from blocking all bot usage
        return {
          allowed: true,
          cost: 0,
          balanceAfter: undefined,
          transactionId: undefined,
        }
      }

      const result = await response.json() as SomaCheckResult
      
      logger.debug({
        userId: params.userId,
        allowed: result.allowed,
        cost: result.cost,
        balance: result.allowed ? result.balanceAfter : result.currentBalance,
      }, 'Soma check result')

      return result
    } catch (error) {
      logger.error({ error, url }, 'Soma API request failed')
      
      // On network error, allow the activation (fail open)
      return {
        allowed: true,
        cost: 0,
        balanceAfter: undefined,
        transactionId: undefined,
      }
    }
  }

  /**
   * Refund a previous transaction (e.g., when inference fails)
   * Returns the credits to the user
   */
  async refund(params: SomaRefundParams): Promise<SomaRefundResult | null> {
    const url = `${this.baseUrl}/refund`
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transactionId: params.transactionId,
          reason: params.reason,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ 
          status: response.status, 
          error: errorText,
          transactionId: params.transactionId,
          url 
        }, 'Soma refund request failed')
        return null
      }

      const result = await response.json() as SomaRefundResult
      
      logger.info({
        transactionId: params.transactionId,
        refundTransactionId: result.refundTransactionId,
        amount: result.amount,
        reason: params.reason,
      }, 'Soma refund successful')

      return result
    } catch (error) {
      logger.error({ error, url, transactionId: params.transactionId }, 'Soma refund request failed')
      return null
    }
  }

  /**
   * Track a bot response message for reaction rewards/tips
   * Call this after sending a bot response to enable rewards on that message
   */
  async trackMessage(params: SomaTrackMessageParams): Promise<SomaTrackMessageResult | null> {
    const url = `${this.baseUrl}/track-message`
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messageId: params.messageId,
          channelId: params.channelId,
          serverId: params.serverId,
          botId: params.botId,
          triggerUserId: params.triggerUserId,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ 
          status: response.status, 
          error: errorText,
          messageId: params.messageId,
          url 
        }, 'Soma track-message request failed')
        return null
      }

      const result = await response.json() as SomaTrackMessageResult
      
      logger.debug({
        messageId: params.messageId,
        expiresAt: result.expiresAt,
      }, 'Soma message tracked for reactions')

      return result
    } catch (error) {
      logger.error({ error, url, messageId: params.messageId }, 'Soma track-message request failed')
      return null
    }
  }

  /**
   * Format an insufficient funds message for the user
   * 
   * @deprecated The Soma Discord bot now handles insufficient funds notifications via DM.
   * ChapterX should just add the 💸 reaction to the trigger message instead.
   */
  formatInsufficientFundsMessage(
    result: SomaCheckResult,
    botName: string
  ): string {
    const lines: string[] = [
      `💫 **Insufficient Ichor**`,
      ``,
      `You need **${result.cost} ichor** to summon ${botName}, but you only have **${result.currentBalance?.toFixed(1) ?? 0} ichor**.`,
    ]

    if (result.regenRate && result.timeToAfford) {
      lines.push(``)
      lines.push(`Your regeneration rate: **${result.regenRate} ichor/hour**`)
      
      if (result.timeToAfford < 60) {
        lines.push(`Time until you can afford this: **~${result.timeToAfford} minutes**`)
      } else {
        const hours = Math.ceil(result.timeToAfford / 60)
        lines.push(`Time until you can afford this: **~${hours} hour${hours > 1 ? 's' : ''}**`)
      }
    }

    if (result.cheaperAlternatives && result.cheaperAlternatives.length > 0) {
      lines.push(``)
      lines.push(`💡 **Alternatives:**`)
      for (const alt of result.cheaperAlternatives.slice(0, 3)) {
        const canAfford = (result.currentBalance ?? 0) >= alt.cost
        lines.push(`• ${alt.name} (${alt.cost} ichor)${canAfford ? ' - You can afford this!' : ''}`)
      }
    }

    return lines.join('\n')
  }
}

/**
 * Check if a trigger type should be charged
 * Random activations are free, direct triggers cost ichor
 */
export function shouldChargeTrigger(triggerType: string): triggerType is SomaTriggerType {
  return ['mention', 'reply', 'm_command'].includes(triggerType)
}

export interface SomaRefundParams {
  transactionId: string
  reason?: string
}

export interface SomaRefundResult {
  success: boolean
  refundTransactionId: string
  amount: number
  balanceAfter: number
}

export interface SomaTrackMessageParams {
  messageId: string      // Discord message ID (bot's response)
  channelId: string      // Discord channel ID
  serverId: string       // Discord guild ID
  botId: string          // Bot's Discord ID
  triggerUserId: string  // Discord user ID who triggered the bot
}

export interface SomaTrackMessageResult {
  success: boolean
  expiresAt: string      // ISO timestamp when tracking expires
}

