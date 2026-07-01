import { describe, it, expect } from 'vitest'
import type { PortalMessage } from '@animalabs/portal-protocol'
import { portalMessageToDiscordMessage } from './context.js'

function pm(over: Partial<PortalMessage> = {}): PortalMessage {
  return {
    id: 'rm_chan_100',
    nativeId: '100',
    channelId: 'chan',
    guildId: 'guild',
    author: { kind: 'user', userId: 'u1', username: 'alice', displayName: 'Alice', bot: false },
    content: 'hi',
    cleanContent: 'hi',
    attachments: [],
    mentions: { personas: [], roles: [], users: [], everyone: false },
    reactions: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    ...over,
  }
}
const noMap = new Map<string, PortalMessage>()

describe('portalMessageToDiscordMessage — strip portal- role prefix', () => {
  it('strips the portal- prefix from a resolved role mention', () => {
    const d = portalMessageToDiscordMessage(pm({ cleanContent: '@portal-glm52 hey' }), noMap, 'bot')
    expect(d.content).toBe('@glm52 hey')
  })

  it('strips every portal- mention and preserves the rest', () => {
    const d = portalMessageToDiscordMessage(
      pm({ cleanContent: 'ping @portal-nemotron-3-ultra and @portal-Fugu, cc @alice' }),
      noMap,
      'bot',
    )
    expect(d.content).toBe('ping @nemotron-3-ultra and @Fugu, cc @alice')
  })

  it('leaves ordinary (non-portal) mentions untouched', () => {
    const d = portalMessageToDiscordMessage(pm({ cleanContent: 'hey @alice and @bob' }), noMap, 'bot')
    expect(d.content).toBe('hey @alice and @bob')
  })

  it('is a no-op on raw <@&id> content (no cleanContent)', () => {
    const d = portalMessageToDiscordMessage(pm({ cleanContent: '', content: '<@&123> hi' }), noMap, 'bot')
    expect(d.content).toBe('<@&123> hi')
  })
})
