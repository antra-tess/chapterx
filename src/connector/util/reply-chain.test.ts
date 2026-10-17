/**
 * replyChainDepth: the rule behind max_bot_reply_chain_depth.
 *
 * WHAT THESE PROTECT: the limit stops bots answering each other without end, and
 * must never refuse a human. These pin where the walk starts (the message
 * itself), where it stops (a human, no reply, a link it can't find) and how a
 * run of one bot's messages counts (once).
 */

import { describe, it, expect } from 'vitest'
import { replyChainDepth, type ChainLink } from './reply-chain.js'

function chain(links: Record<string, ChainLink>) {
  return async (id: string) => links[id] ?? null
}

const human = (replyTo?: string): ChainLink => ({ authorId: 'h', bot: false, replyTo })
const bot = (id: string, replyTo?: string): ChainLink => ({ authorId: id, bot: true, replyTo })

describe('replyChainDepth', () => {
  it('scores a human\'s message 0, whatever it replies to', async () => {
    const lookup = chain({ m2: bot('p', 'm1'), m1: bot('a') })
    expect(await replyChainDepth(human('m2'), lookup)).toBe(0)
  })

  it('counts each bot turn back to the first human', async () => {
    const lookup = chain({ m3: bot('p', 'm2'), m2: bot('a', 'm1'), m1: human() })
    expect(await replyChainDepth(bot('a', 'm3'), lookup)).toBe(3)
  })

  it('counts a run of one bot\'s messages once', async () => {
    const lookup = chain({ m3: bot('a', 'm2'), m2: bot('a', 'm1'), m1: human() })
    expect(await replyChainDepth(bot('a', 'm3'), lookup)).toBe(1)
  })

  it('stops at a message that replies to nothing, without a lookup', async () => {
    const lookup = async (id: string): Promise<ChainLink | null> => {
      throw new Error(`looked up ${id}`)
    }
    expect(await replyChainDepth(bot('a'), lookup)).toBe(1)
  })

  it('stops at a link it can\'t find', async () => {
    const lookup = chain({ m2: bot('p', 'gone') })
    expect(await replyChainDepth(bot('a', 'm2'), lookup)).toBe(2)
  })
})
