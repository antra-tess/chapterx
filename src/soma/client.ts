import { SomaConfig, SomaCheckResult } from '../types.js'
import { logger } from '../utils/logger.js'

export type SomaTriggerType = 'mention' | 'reply' | 'm_command' | 'reaction'

export interface SomaCheckParams {
  userId: string
  serverId: string
  channelId: string
  botId: string
  messageId: string
  triggerType: SomaTriggerType
  userRoles: string[]
}

/** @deprecated Soma's bot handles these reactions; ChapterX no longer uses it. */
export const INSUFFICIENT_FUNDS_EMOJI = '💸'

/** @deprecated Soma's bot handles these reactions; ChapterX no longer uses it. */
export const DM_FAILED_EMOJI = '📭'

export const BOT_NOT_CONFIGURED_EMOJI = '⚙️'

export class SomaClient {
  private baseUrl: string
  private token: string

  constructor(config: SomaConfig) {
    this.baseUrl = config.url.replace(/\/$/, '')
    this.token = config.token || process.env.SOMA_TOKEN || ''
    
    if (!this.token) {
      logger.warn('Soma client initialized without token - API calls will fail')
    }
  }

  /** Soma checks and deducts in one atomic operation. */
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
        
        let errorData: { error?: string } = {}
        try {
          errorData = JSON.parse(errorText)
        } catch {
        }

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
      
      return {
        allowed: true,
        cost: 0,
        balanceAfter: undefined,
        transactionId: undefined,
      }
    }
  }

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
          ...(params.triggerMessageId && { triggerMessageId: params.triggerMessageId }),
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

  /** @deprecated The Soma Discord bot now handles insufficient funds notifications via DM. */
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

export function shouldChargeTrigger(triggerType: string): triggerType is SomaTriggerType {
  return ['mention', 'reply', 'm_command', 'reaction'].includes(triggerType)
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
  messageId: string
  channelId: string
  serverId: string
  botId: string
  triggerUserId: string
  triggerMessageId?: string
}

export interface SomaTrackMessageResult {
  success: boolean
  expiresAt: string
}

