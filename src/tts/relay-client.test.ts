import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeSocket = { readyState: number; emit(event: string, ...args: unknown[]): boolean }

const sockets = vi.hoisted(() => [] as FakeSocket[])

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1
    readyState = 0
    constructor(readonly url: string) {
      super()
      sockets.push(this)
    }
    send(): void {}
    close(): void {}
  }
  return { default: FakeWebSocket }
})

import { TTSRelayClient, type RelayClientConfig } from './relay-client.js'

const base = { url: 'ws://relay.test/bot', botId: 'bot', token: 'token' }

describe('TTS relay reconnect', () => {
  let client: TTSRelayClient | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
  })

  afterEach(() => {
    client?.disconnect()
    client = null
    vi.useRealTimers()
  })

  async function connectThenDropAfter(config: RelayClientConfig, connectedMs: number): Promise<void> {
    client = new TTSRelayClient(config)
    const connected = client.connect()
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]!
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })))
    await connected
    expect(client.isConnected()).toBe(true)

    await vi.advanceTimersByTimeAsync(connectedMs)
    socket.readyState = 3
    socket.emit('close', 1006, Buffer.from(''))
  }

  it.each([
    ['left out', { ...base }],
    ['passed as undefined, as setTTSRelay passes an unset reconnect_interval_ms', { ...base, reconnectIntervalMs: undefined }],
    ['null, as YAML reads an empty value', { ...base, reconnectIntervalMs: null as unknown as number }],
  ])('waits 5000 ms after a dropped connection before reconnecting when the interval is %s', async (_form, config) => {
    await connectThenDropAfter(config, 3000)

    await vi.advanceTimersByTimeAsync(4999)
    expect(sockets).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)
  })

  it('waits the configured interval after a dropped connection before reconnecting', async () => {
    await connectThenDropAfter({ ...base, reconnectIntervalMs: 2000 }, 3000)

    await vi.advanceTimersByTimeAsync(1999)
    expect(sockets).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)
  })
})
