import { ChannelState, ToolCall } from '../types.js'
import { logger } from '../utils/logger.js'

export class ChannelStateManager {
  private states = new Map<string, ChannelState>()

  async getOrInitialize(
    botId: string,
    channelId: string,
    toolCache: ToolCall[]
  ): Promise<ChannelState> {
    const key = this.makeKey(botId, channelId)

    if (!this.states.has(key)) {
      logger.debug({ botId, channelId }, 'Initializing channel state')

      this.states.set(key, {
        toolCache,
        lastCacheMarker: null,
        messagesSinceRoll: 0,
        cacheOldestMessageId: null,
      })
    }

    return this.states.get(key)!
  }

  updateToolCache(
    botId: string,
    channelId: string,
    newCalls: ToolCall[]
  ): void {
    const state = this.getState(botId, channelId)
    state.toolCache.push(...newCalls)
  }

  pruneToolCache(
    botId: string,
    channelId: string,
    oldestMessageId: string
  ): void {
    const state = this.getState(botId, channelId)

    const before = state.toolCache.length

    state.toolCache = state.toolCache.filter(
      (call) => call.messageId >= oldestMessageId
    )

    const removed = before - state.toolCache.length

    if (removed > 0) {
      logger.debug(
        { botId, channelId, removed, remaining: state.toolCache.length },
        'Pruned tool cache'
      )
    }
  }

  updateCacheMarker(
    botId: string,
    channelId: string,
    marker: string
  ): void {
    const state = this.getState(botId, channelId)
    state.lastCacheMarker = marker
  }

  incrementMessageCount(botId: string, channelId: string): void {
    const state = this.getState(botId, channelId)
    state.messagesSinceRoll++
  }

  resetMessageCount(botId: string, channelId: string): void {
    const state = this.getState(botId, channelId)
    state.messagesSinceRoll = 0
  }

  updateCacheOldestMessageId(botId: string, channelId: string, messageId: string | null): void {
    const state = this.getState(botId, channelId)
    state.cacheOldestMessageId = messageId
  }

  getCacheOldestMessageId(botId: string, channelId: string): string | null {
    const state = this.getState(botId, channelId)
    return state.cacheOldestMessageId
  }

  private getState(botId: string, channelId: string): ChannelState {
    const key = this.makeKey(botId, channelId)
    const state = this.states.get(key)

    if (!state) {
      throw new Error(
        `Channel state not initialized: ${botId}/${channelId}`
      )
    }

    return state
  }

  private makeKey(botId: string, channelId: string): string {
    return `${botId}:${channelId}`
  }
}

