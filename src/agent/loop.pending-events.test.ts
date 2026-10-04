import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Event } from '../types.js'
import { EventQueue } from './event-queue.js'
import { AgentLoop } from './loop.js'

describe('AgentLoop active-channel event buffering', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requeues events received while the channel is active', async () => {
    const queue = new EventQueue()
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-agent-loop-'))
    temporaryDirectories.push(cacheDirectory)
    const loop = new AgentLoop(
      'bot',
      queue,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cacheDirectory
    )
    const event: Event = {
      type: 'message',
      channelId: 'channel',
      guildId: 'guild',
      data: { id: 'message' },
      timestamp: new Date('2026-09-01T12:00:00Z'),
    }

    ;(loop as any).activeChannels.add('channel')
    await (loop as any).processBatch([event])

    expect(queue.isEmpty()).toBe(true)
    expect((loop as any).pendingChannelEvents.get('channel')).toEqual([event])

    const newerEvent: Event = {
      ...event,
      channelId: 'other-channel',
      data: { id: 'newer-message' },
    }
    queue.push(newerEvent)

    ;(loop as any).completeChannelActivation('channel')

    expect((loop as any).activeChannels.has('channel')).toBe(false)
    expect((loop as any).pendingChannelEvents.has('channel')).toBe(false)
    expect(queue.pollBatch()).toEqual([event])
    expect(queue.pollBatch()).toEqual([newerEvent])
  })
})
