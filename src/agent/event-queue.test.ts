import { describe, expect, it } from 'vitest'
import type { Event, EventType } from '../types.js'
import { EventQueue } from './event-queue.js'

function makeEvent(
  type: EventType,
  channelId: string,
  id: string,
  guildId = 'guild'
): Event {
  return {
    type,
    channelId,
    guildId,
    data: { id },
    timestamp: new Date('2026-09-01T12:00:00Z'),
  }
}

describe('EventQueue channel isolation', () => {
  it('batches consecutive Discord events from the same channel', () => {
    const queue = new EventQueue()
    const message = makeEvent('message', 'channel-a', 'message')
    const reaction = makeEvent('reaction', 'channel-a', 'reaction')
    queue.push(message)
    queue.push(reaction)

    expect(queue.pollBatch()).toEqual([message, reaction])
  })

  it('never combines Discord events from different channels', () => {
    const queue = new EventQueue()
    const first = makeEvent('message', 'channel-a', 'first')
    const second = makeEvent('message', 'channel-b', 'second')
    queue.push(first)
    queue.push(second)

    expect(queue.pollBatch()).toEqual([first])
    expect(queue.pollBatch()).toEqual([second])
  })

  it('never combines internal events from different channels', () => {
    const queue = new EventQueue()
    const first = makeEvent('self_activation', 'channel-a', 'first')
    const second = makeEvent('timer', 'channel-b', 'second')
    queue.push(first)
    queue.push(second)

    expect(queue.pollBatch()).toEqual([first])
    expect(queue.pollBatch()).toEqual([second])
  })

  it('prepends a deferred batch without reversing it', () => {
    const queue = new EventQueue()
    const deferredFirst = makeEvent('message', 'channel-a', 'deferred-first')
    const deferredSecond = makeEvent('reaction', 'channel-a', 'deferred-second')
    const newer = makeEvent('message', 'channel-b', 'newer')
    queue.push(newer)

    queue.prepend([deferredFirst, deferredSecond])

    expect(queue.pollBatch()).toEqual([deferredFirst, deferredSecond])
    expect(queue.pollBatch()).toEqual([newer])
  })
})
