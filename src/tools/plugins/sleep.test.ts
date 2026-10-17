/**
 * What go_to_sleep and set_config answer when their pin fails.
 *
 * WHAT THESE PROTECT: each tool takes effect only through the pin. When the pin
 * fails, its answer must say the message was sent but the change isn't in
 * effect, why, and that calling again sends another copy, since on the portal
 * backend the bot can't pin at all and the old guess (the channel's 50-pin
 * limit) would be wrong.
 *
 * Run with: npm test -- sleep
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import sleepPlugin from './sleep.js'
import configPlugin from './config.js'
import type { PluginContext } from './types.js'
import { logger } from '../../utils/logger.js'

const PORTAL_REFUSAL = "A bot on the portal backend can't pin messages; someone in the channel can pin the message in Discord instead"

function context(): PluginContext & { addReaction: ReturnType<typeof vi.fn> } {
  return {
    botId: 'glm52',
    channelId: 'c',
    guildId: 'g',
    currentMessageId: 'm',
    config: { name: 'glm52' },
    sendMessage: vi.fn(async () => ['rm_c_1']),
    pinMessage: vi.fn(async () => {
      throw new Error(PORTAL_REFUSAL)
    }),
    addReaction: vi.fn(async () => undefined),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('a tool whose pin fails', () => {
  it('go_to_sleep says sleep is not active, why, and that calling again sends another message', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    const ctx = context()
    const tool = sleepPlugin.tools.find((t) => t.name === 'go_to_sleep')!

    const answer = await tool.handler({ duration: '30m' }, ctx)

    expect(answer).toBe(
      `Error: the .sleep message was sent, but pinning it failed, so sleep is NOT active. ${PORTAL_REFUSAL}. Calling go_to_sleep again would send another .sleep message.`,
    )
    expect(ctx.addReaction).not.toHaveBeenCalled()
  })

  it('set_config says the setting is unchanged, why, and that calling again sends another message', async () => {
    const tool = configPlugin.tools.find((t) => t.name === 'set_config')!

    const answer = await tool.handler({ key: 'temperature', value: '0.7' }, context())

    expect(answer).toBe(
      `Error: the .config message was sent, but pinning it failed, so temperature is unchanged. ${PORTAL_REFUSAL}. Calling set_config again would send another .config message.`,
    )
  })
})
