import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiscordConnector } from './connector.js'
import { EventQueue } from '../agent/event-queue.js'

const CHANNEL_ID = '100000000000000001'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function makeConnector() {
  const cacheDir = mkdtempSync(join(tmpdir(), 'connector-typing-test-'))
  const connector = new DiscordConnector(new EventQueue(), {
    token: 'fake',
    cacheDir,
    maxBackoffMs: 100,
  })

  return {
    connector,
    cleanup: () => rmSync(cacheDir, { recursive: true, force: true }),
  }
}

describe('DiscordConnector typing state', () => {
  let harness: ReturnType<typeof makeConnector>

  beforeEach(() => {
    vi.useFakeTimers()
    harness = makeConnector()
  })

  afterEach(() => {
    vi.useRealTimers()
    harness.cleanup()
  })

  it('does not install a refresh interval when stop wins the startup race', async () => {
    const channelFetch = deferred<any>()
    const sendTyping = vi.fn(async () => {})
    ;(harness.connector as any).client = {
      channels: { fetch: vi.fn(() => channelFetch.promise) },
    }

    const starting = harness.connector.startTyping(CHANNEL_ID)
    await harness.connector.stopTyping(CHANNEL_ID)

    channelFetch.resolve({ isTextBased: () => true, sendTyping })
    await starting
    await vi.advanceTimersByTimeAsync(8_000)

    expect(sendTyping).not.toHaveBeenCalled()
  })

  it('keeps only the newest refresh interval after repeated starts', async () => {
    const sendTyping = vi.fn(async () => {})
    const channel = { isTextBased: () => true, sendTyping }
    ;(harness.connector as any).client = {
      channels: { fetch: vi.fn(async () => channel) },
    }

    await harness.connector.startTyping(CHANNEL_ID)
    await harness.connector.startTyping(CHANNEL_ID)

    await vi.advanceTimersByTimeAsync(8_000)
    expect(sendTyping).toHaveBeenCalledTimes(3) // two starts, one refresh

    await harness.connector.stopTyping(CHANNEL_ID)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(sendTyping).toHaveBeenCalledTimes(3)
  })
})
