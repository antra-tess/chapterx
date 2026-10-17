/**
 * The go_to_sleep tool when its pin fails.
 *
 * WHAT THIS PROTECTS: sleep takes effect only through the pin. When the pin
 * fails, the tool must say that sleep isn't active, and why, since on the portal
 * backend nothing can pin and the old guess (the channel's 50-pin limit) would
 * be wrong.
 *
 * Run with: npm test -- sleep
 */

import { describe, it, expect, vi } from 'vitest'
import sleepPlugin from './sleep.js'
import type { PluginContext } from './types.js'
import { logger } from '../../utils/logger.js'

describe('go_to_sleep', () => {
  it('says sleep is not active, and why, when the pin fails', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    const context = {
      botId: 'glm52',
      channelId: 'c',
      guildId: 'g',
      currentMessageId: 'm',
      config: { name: 'glm52' },
      sendMessage: vi.fn(async () => ['rm_c_1']),
      pinMessage: vi.fn(async () => {
        throw new Error("Pinning isn't available on the portal backend: the relay has no pin RPC, so the message wasn't pinned")
      }),
      addReaction: vi.fn(async () => undefined),
    } satisfies PluginContext
    const tool = sleepPlugin.tools.find((t) => t.name === 'go_to_sleep')!

    const answer = await tool.handler({ duration: '30m' }, context)

    expect(answer).toBe(
      "Error: .sleep message sent but could not pin it (Pinning isn't available on the portal backend: the relay has no pin RPC, so the message wasn't pinned). Sleep is NOT active.",
    )
    expect(context.addReaction).not.toHaveBeenCalled()
  })
})
