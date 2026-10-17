/**
 * withDiscordIds: the API speaks Discord message ids on both backends.
 *
 * WHAT THESE PROTECT: on the portal backend a fetched message's `id` is the
 * relay's id. The API takes Discord message ids from URLs (its `first` trim
 * compares them) and returns message ids that callers build Discord links from,
 * so it must read portal messages by their snowflakes.
 */

import { describe, it, expect } from 'vitest'
import { withDiscordIds } from './server.js'
import type { DiscordMessage } from '../types.js'

function dm(over: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: '1',
    channelId: 'c',
    guildId: 'g',
    author: { id: 'u', username: 'u', displayName: 'U', bot: false },
    content: 'x',
    timestamp: new Date(0),
    attachments: [],
    reactions: [],
    mentions: [],
    ...over,
  }
}

describe('withDiscordIds', () => {
  it('reads portal messages by their snowflakes, and a reply\'s target too', () => {
    const out = withDiscordIds([
      dm({ id: 'rm_c_100', nativeId: '100' }),
      dm({ id: 'rm_c_101', nativeId: '101', referencedMessage: 'rm_c_100' }),
    ])
    expect(out.map((m) => m.id)).toEqual(['100', '101'])
    expect(out[1]!.referencedMessage).toBe('100')
  })

  it('leaves Discord messages as they are', () => {
    const m = dm({ id: '555', referencedMessage: '444' })
    expect(withDiscordIds([m])[0]).toBe(m)
  })
})
