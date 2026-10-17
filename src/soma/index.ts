/**
 * Soma Integration Module
 * 
 * Provides optional credit system integration for ChapterX bots.
 * When enabled, users must have sufficient ichor (credits) to trigger bot responses.
 */

export { SomaClient, shouldChargeTrigger, INSUFFICIENT_FUNDS_EMOJI, DM_FAILED_EMOJI } from './client.js'
export type { 
  SomaTriggerType, 
  SomaCheckParams, 
  SomaRefundParams, 
  SomaRefundResult,
  SomaTrackMessageParams,
  SomaTrackMessageResult,
} from './client.js'

