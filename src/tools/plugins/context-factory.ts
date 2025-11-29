/**
 * Plugin Context Factory
 * 
 * Creates PluginStateContext instances for plugins to use.
 */

import { PluginContext, PluginStateContext } from './types.js'
import { PluginStateManager, StateScope } from './state.js'
import { logger } from '../../utils/logger.js'

export interface PluginContextFactoryParams {
  cacheDir: string
  messageIds: string[]  // Ordered list of message IDs in context (oldest to newest)
}

/**
 * Factory for creating plugin contexts with state management.
 * 
 * A single factory instance is used per agent loop execution,
 * and creates contexts for each plugin as needed.
 */
export class PluginContextFactory {
  private stateManagers = new Map<string, PluginStateManager>()
  private cacheDir: string
  private messageIds: string[]
  private messageIdSet: Set<string>
  private messagePositions: Map<string, number>
  
  constructor(params: PluginContextFactoryParams) {
    this.cacheDir = params.cacheDir
    this.messageIds = params.messageIds
    this.messageIdSet = new Set(params.messageIds)
    
    // Build position map for fast lookups
    this.messagePositions = new Map()
    for (let i = 0; i < params.messageIds.length; i++) {
      this.messagePositions.set(params.messageIds[i]!, i)
    }
  }
  
  /**
   * Get or create state manager for a plugin
   */
  private getStateManager(pluginId: string): PluginStateManager {
    if (!this.stateManagers.has(pluginId)) {
      this.stateManagers.set(pluginId, new PluginStateManager(this.cacheDir, pluginId))
    }
    return this.stateManagers.get(pluginId)!
  }
  
  /**
   * Create a full PluginStateContext for a plugin
   */
  createStateContext(
    pluginId: string,
    baseContext: PluginContext,
    inheritanceInfo?: {
      parentChannelId?: string
      historyOriginChannelId?: string
    },
    epicReducer?: (state: any, delta: any) => any,
    pluginConfig?: { state_scope?: 'global' | 'channel' | 'epic'; [key: string]: any }
  ): PluginStateContext {
    const stateManager = this.getStateManager(pluginId)
    const { channelId, currentMessageId } = baseContext
    
    // Capture these for use in closures
    const messageIdSet = this.messageIdSet
    const messagePositions = this.messagePositions
    const messageIds = this.messageIds
    
    // Determine configured scope (default to 'channel')
    const configuredScope = pluginConfig?.state_scope || 'channel'
    
    const messagesSinceId = (messageId: string | null): number => {
      if (!messageId) return Infinity
      
      const position = messagePositions.get(messageId)
      if (position === undefined) return Infinity
      
      // Distance from end of array
      return messageIds.length - 1 - position
    }
    
    return {
      ...baseContext,
      contextMessageIds: messageIdSet,
      inheritanceInfo,
      pluginConfig,
      configuredScope,
      
      messagesSinceId,
      
      async getState<T>(scope: StateScope): Promise<T | null> {
        switch (scope) {
          case 'global':
            return stateManager.getGlobalState<T>()
          
          case 'channel':
            const result = await stateManager.getChannelState<T>(channelId, inheritanceInfo)
            return result.state
          
          case 'epic':
            if (!epicReducer) {
              logger.warn({ pluginId }, 'Epic reducer not provided, falling back to channel state')
              const channelResult = await stateManager.getChannelState<T>(channelId, inheritanceInfo)
              return channelResult.state
            }
            return stateManager.getEpicState<T>(
              channelId,
              null,  // Get latest state
              messageIdSet,  // Captured from outer scope
              epicReducer
            )
          
          default:
            logger.error({ scope }, 'Unknown state scope')
            return null
        }
      },
      
      async setState<T>(scope: StateScope, state: T): Promise<void> {
        switch (scope) {
          case 'global':
            await stateManager.setGlobalState<T>(state)
            break
          
          case 'channel':
            await stateManager.setChannelState<T>(channelId, state, currentMessageId)
            break
          
          case 'epic':
            // For epic, record as an event
            await stateManager.recordEpicEvent(channelId, currentMessageId, state)
            break
          
          default:
            logger.error({ scope }, 'Unknown state scope')
        }
      },
      
      async getStateAtMessage<T>(messageId: string): Promise<T | null> {
        if (!epicReducer) {
          logger.warn({ pluginId }, 'getStateAtMessage requires epic scope with reducer')
          return null
        }
        
        return stateManager.getEpicState<T>(
          channelId,
          messageId,
          messageIdSet,  // Captured from outer scope
          epicReducer
        )
      },
    }
  }
  
  /**
   * Calculate current depth for an injection based on when it was modified
   */
  calculateCurrentDepth(
    lastModifiedAt: string | null,
    targetDepth: number
  ): number {
    if (!lastModifiedAt) {
      return targetDepth  // Settled at target
    }
    
    const position = this.messagePositions.get(lastModifiedAt)
    if (position === undefined) {
      return targetDepth  // Message not in context, assume settled
    }
    
    // Calculate messages since modification
    const messagesSince = this.messageIds.length - 1 - position
    
    // Depth is min of messagesSince and targetDepth
    return Math.min(messagesSince, targetDepth)
  }
  
  /**
   * Update message IDs (call when context changes during execution)
   */
  updateMessageIds(messageIds: string[]): void {
    this.messageIds = messageIds
    this.messageIdSet = new Set(messageIds)
    this.messagePositions.clear()
    for (let i = 0; i < messageIds.length; i++) {
      this.messagePositions.set(messageIds[i]!, i)
    }
  }
}

