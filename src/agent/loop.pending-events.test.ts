import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '../types.js'
import { logger } from '../utils/logger.js'
import { EventQueue } from './event-queue.js'
import { AgentLoop } from './loop.js'

const BOT_USER = 'bot-user'

function message(
  channelId: string,
  id: string,
  options: { author?: string; content?: string; mentionsBot?: boolean } = {}
): Event {
  const author = options.author ?? 'person'
  return {
    type: 'message',
    channelId,
    guildId: 'guild',
    data: {
      id,
      content: options.content ?? 'hello',
      author: { id: author, username: author, bot: author === BOT_USER },
      mentions: { has: (userId: string) => options.mentionsBot === true && userId === BOT_USER },
    },
    timestamp: new Date('2026-09-01T12:00:00Z'),
  }
}

function timer(channelId: string, id: string): Event {
  return {
    type: 'self_activation',
    channelId,
    guildId: 'guild',
    data: { id, timerId: id },
    timestamp: new Date('2026-09-01T12:00:00Z'),
  }
}

type SomaCall = { channelId: string; reason: string; triggeringMessageId?: string }

describe('AgentLoop active-channel event buffering', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function makeLoop(
    somaAnswers: Array<'allowed' | 'blocked'> = [],
    configOverrides: Record<string, unknown> = {},
    availableTools: unknown[] = [],
  ) {
    const queue = new EventQueue()
    const cacheDirectory = mkdtempSync(join(tmpdir(), 'chapterx-agent-loop-'))
    temporaryDirectories.push(cacheDirectory)
    const deleted: string[] = []
    let fetchContext: (params: any) => Promise<any> = async () => ({ messages: [] })
    const connector = {
      getCachedPinnedConfigs: () => null,
      getBotReplyChainDepth: async () => 0,
      deleteMessage: async (_channelId: string, messageId: string) => { deleted.push(messageId) },
      fetchPinnedConfigs: async () => [],
      addReaction: async () => {},
      startTyping: async () => {},
      stopTyping: async () => {},
      fetchContext: (params: any) => fetchContext(params),
      fetchPinnedSteerMessages: async () => [],
      getBotUsername: () => 'bot',
      getOwnRoleIds: () => [],
    }
    const configSystem = {
      loadConfig: () => ({
        continuation_emoji: '⏩',
        continuation_model: 'test-model',
        max_bot_reply_chain_depth: 5,
        bot_reply_chain_depth_emote: '⛓️',
        reply_on_random: 0,
        supports_continuation: true,
        prompt_caching: false,
        ...configOverrides,
      }),
    }
    const removedForDeletes: string[] = []
    const toolSystem = {
      getAvailableTools: () => availableTools,
      loadCacheWithResults: async () => [],
      setPluginContext: () => {},
      getPluginContext: () => ({}),
      getLoadedPluginObjects: () => [],
      setPluginContextFactory: () => {},
      removeEntriesByBotMessageId: async (_botId: string, _channelId: string, messageId: string) => {
        removedForDeletes.push(messageId)
      },
    }
    const stateManager = { getOrInitialize: async () => ({}), pruneToolCache: () => {} }
    const contextBuilder = { buildContext: async () => ({ request: { messages: [] } }) }
    const loop = new AgentLoop(
      'bot',
      queue,
      connector as any,
      stateManager as any,
      configSystem as any,
      contextBuilder as any,
      toolSystem as any,
      cacheDirectory
    )
    const internals = loop as any
    internals.botUserId = BOT_USER
    const sleepObservations: string[] = []
    internals.sleepState = {
      sleepPinsForBot: () => ['pin'],
      isSleeping: () => false,
      observeMessage: (channelId: string) => { sleepObservations.push(channelId) },
    }
    internals.collectPinnedConfigsWithInheritance = async () => []
    internals.collectPinnedSteersWithInheritance = async () => []
    const answered = { count: 0 }
    const requests: Array<{ path: 'native' | 'inline'; request: any }> = []
    const modelAnswer = (path: 'native' | 'inline') => async (request: any) => {
      requests.push({ path, request })
      answered.count++
      return { completion: { content: [{ type: 'text', text: 'Hi.' }], stopReason: 'end_turn' }, toolCallIds: [], preambleMessageIds: [], sentMessageIds: ['reply'], messageContexts: {} }
    }
    internals.executeWithNativeTools = modelAnswer('native')
    internals.executeWithInlineTools = modelAnswer('inline')
    const soma: SomaCall[] = []
    const somaEvents: string[][] = []
    internals.checkSomaCredits = async (
      events: Event[],
      channelId: string,
      _guildId: string,
      reason: string,
      triggeringMessageId?: string
    ) => {
      soma.push({ channelId, reason, triggeringMessageId })
      somaEvents.push(events.map((event) => event.data?.id))
      return { status: somaAnswers.shift() ?? 'blocked' }
    }
    return {
      loop: internals,
      queue,
      deleted,
      removedForDeletes,
      soma,
      somaEvents,
      sleepObservations,
      answered,
      requests,
      setFetchContext: (fetch: (params: any) => Promise<any>) => { fetchContext = fetch },
    }
  }

  it('holds an active channel\'s events while its activation runs, and requeues them ahead of newer events when it ends', async () => {
    const { loop, queue } = makeLoop(['allowed'])
    let release!: () => void
    loop.handleActivation = () => new Promise<void>((resolve) => { release = resolve })

    await loop.processBatch([timer('channel', 'timer')])
    expect(loop.activeChannels.has('channel')).toBe(true)

    const first = message('channel', '101')
    const second = message('channel', '102')
    await loop.processBatch([first])
    await loop.processBatch([second])
    const newer = message('other-channel', '103')
    queue.push(newer)

    release()
    await vi.waitFor(() => expect(loop.activeChannels.has('channel')).toBe(false))
    expect(queue.pollBatch()).toEqual([first, second])
    expect(queue.pollBatch()).toEqual([newer])
  })

  it('decides a replayed batch by the event that decides it, and requeues the events after it', async () => {
    const { loop, queue, soma, somaEvents } = makeLoop()
    const botChunk = message('channel', '201', { author: BOT_USER })
    const elsewhere = message('channel', '202', { content: 'm continue <@other-bot>' })
    const mention = message('channel', '203', { content: '<@bot-user> hi', mentionsBot: true })
    const laterMention = message('channel', '204', { content: '<@bot-user> also', mentionsBot: true })

    await loop.processBatch([botChunk, elsewhere, mention, laterMention])

    expect(soma).toEqual([{ channelId: 'channel', reason: 'mention', triggeringMessageId: '203' }])
    expect(somaEvents).toEqual([['203']])
    expect(queue.pollBatch()).toEqual([laterMention])
    expect(loop.activeChannels.has('channel')).toBe(false)
  })

  it('takes no trigger from this bot\'s own message when a reaction decides', async () => {
    const { loop, soma } = makeLoop()
    const botChunk = message('channel', '221', { author: BOT_USER })
    const reaction: Event = {
      type: 'reaction',
      channelId: 'channel',
      guildId: 'guild',
      data: { emoji: '⏩', userId: 'person', messageId: '221', messageAuthorId: BOT_USER },
      timestamp: new Date('2026-09-01T12:00:00Z'),
    }

    await loop.processBatch([botChunk, reaction])

    expect(soma).toEqual([{ channelId: 'channel', reason: 'reaction', triggeringMessageId: undefined }])
  })

  it('removes a deleted bot message\'s tool-cache entries once, in the pass that consumes the delete', async () => {
    const { loop, queue, removedForDeletes } = makeLoop()
    const mention = message('channel', '231', { content: '<@bot-user> hi', mentionsBot: true })
    const deleteOwn: Event = {
      type: 'delete',
      channelId: 'channel',
      guildId: 'guild',
      data: { id: '230', author: { id: BOT_USER } },
      timestamp: new Date('2026-09-01T12:00:00Z'),
    }

    await loop.processBatch([mention, deleteOwn])
    expect(removedForDeletes).toEqual([])

    await loop.processBatch(queue.pollBatch())
    expect(removedForDeletes).toEqual(['230'])
  })

  it('takes the reason and the trigger from an m command that decides, ahead of a later mention', async () => {
    const { loop, queue, soma, deleted } = makeLoop()
    const command = message('channel', '211', { content: 'm continue <@bot-user>', mentionsBot: true })
    const mention = message('channel', '212', { content: '<@bot-user> hi', mentionsBot: true })

    await loop.processBatch([command, mention])

    expect(soma).toEqual([{ channelId: 'channel', reason: 'm_command', triggeringMessageId: '211' }])
    expect(deleted).toEqual(['211'])
    expect(queue.pollBatch()).toEqual([mention])
  })

  it('requeues a mention behind an m get_context, which is answered without an activation', async () => {
    const { loop, queue, soma, deleted } = makeLoop()
    const dumped: string[] = []
    loop.handleGetContext = async (_channelId: string, _guildId: string, _count: number | undefined, messageId: string) => {
      dumped.push(messageId)
    }
    const command = message('channel', '241', { content: 'm get_context <@bot-user>', mentionsBot: true })
    const mention = message('channel', '242', { content: '<@bot-user> hi', mentionsBot: true })

    await loop.processBatch([command, mention])

    expect(dumped).toEqual(['241'])
    expect(deleted).toEqual(['241'])
    expect(soma).toEqual([])
    expect(queue.pollBatch()).toEqual([mention])
  })

  it('requeues a mention behind a continuation reaction the bot rejects', async () => {
    const { loop, queue, soma } = makeLoop()
    const config = loop.configSystem.loadConfig()
    loop.configSystem = { loadConfig: () => ({ ...config, supports_continuation: false }) }
    const reaction: Event = {
      type: 'reaction',
      channelId: 'channel',
      guildId: 'guild',
      data: { emoji: '⏩', userId: 'person', messageId: '251', messageAuthorId: BOT_USER },
      timestamp: new Date('2026-09-01T12:00:00Z'),
    }
    const mention = message('channel', '252', { content: '<@bot-user> hi', mentionsBot: true })

    await loop.processBatch([reaction, mention])

    expect(soma).toEqual([])
    expect(queue.pollBatch()).toEqual([mention])
  })

  it('holds an m command sent during a generation, and deletes and runs it only at its replay', async () => {
    const { loop, queue, soma, deleted } = makeLoop()
    loop.activeChannels.add('channel')
    const command = message('channel', '301', { content: 'm continue <@bot-user>', mentionsBot: true })

    await loop.processBatch([command])
    expect(deleted).toEqual([])
    expect(soma).toEqual([])

    loop.completeChannelActivation('channel')
    await loop.processBatch(queue.pollBatch())

    expect(deleted).toEqual(['301'])
    expect(soma.map((call) => call.reason)).toEqual(['m_command'])
  })

  async function activationHolding(harness: ReturnType<typeof makeLoop>, held: Event[]) {
    const { loop, queue, setFetchContext } = harness
    let openFetch!: () => void
    const fetchStarted = new Promise<void>((started) => {
      setFetchContext(() => new Promise((resolve) => {
        openFetch = () => resolve({ messages: [{ id: '98' }, { id: '100' }], images: [] })
        started()
      }))
    })
    await loop.processBatch([timer('channel', 'timer')])
    for (const event of held) await loop.processBatch([event])
    await fetchStarted
    openFetch()
    await vi.waitFor(() => expect(loop.activeChannels.has('channel')).toBe(false))
    return queue.pollBatch()
  }

  it('lets a held message the answered context already had count for sleep but not trigger, and a newer one trigger', async () => {
    const harness = makeLoop(['allowed'])
    const { loop, soma, sleepObservations, answered } = harness
    const inContext = message('channel', '99', { content: '<@bot-user> hi', mentionsBot: true })
    const newer = message('channel', '101', { content: '<@bot-user> again', mentionsBot: true })

    const replay = await activationHolding(harness, [inContext, newer])
    expect(answered.count).toBe(1)
    sleepObservations.length = 0
    await loop.processBatch(replay)

    expect(sleepObservations).toEqual(['channel', 'channel'])
    expect(soma.slice(1)).toEqual([{ channelId: 'channel', reason: 'mention', triggeringMessageId: '101' }])
  })

  it('marks nothing when the activation fails before its model answers', async () => {
    const harness = makeLoop(['allowed'])
    const { loop, soma } = harness
    loop.executeWithNativeTools = async () => { throw new Error('provider error') }
    loop.executeWithInlineTools = loop.executeWithNativeTools
    const inContext = message('channel', '99', { content: '<@bot-user> hi', mentionsBot: true })

    await loop.processBatch(await activationHolding(harness, [inContext]))

    expect(soma.slice(1)).toEqual([{ channelId: 'channel', reason: 'mention', triggeringMessageId: '99' }])
  })

  it('marks the context of a generation the model refuses, as of any it answers', async () => {
    const harness = makeLoop(['allowed'])
    const { loop, soma } = harness
    const refusal = async () => ({
      completion: { content: [], stopReason: 'refusal' },
      toolCallIds: [],
      preambleMessageIds: [],
      sentMessageIds: [],
      messageContexts: {},
    })
    loop.executeWithNativeTools = refusal
    loop.executeWithInlineTools = refusal
    const inContext = message('channel', '99', { content: '<@bot-user> hi', mentionsBot: true })

    await loop.processBatch(await activationHolding(harness, [inContext]))

    expect(soma.slice(1)).toEqual([])
  })

  it('marks nothing when the activation\'s fetch fails', async () => {
    const { loop, queue, soma, setFetchContext } = makeLoop(['allowed'])
    let failFetch!: () => void
    const fetchStarted = new Promise<void>((started) => {
      setFetchContext(() => new Promise((_resolve, reject) => {
        failFetch = () => reject(new Error('fetch failed'))
        started()
      }))
    })

    await loop.processBatch([timer('channel', 'timer')])
    const deferred = message('channel', '99', { content: '<@bot-user> hi', mentionsBot: true })
    await loop.processBatch([deferred])

    await fetchStarted
    failFetch()
    await vi.waitFor(() => expect(loop.activeChannels.has('channel')).toBe(false))
    await loop.processBatch(queue.pollBatch())

    expect(soma.slice(1)).toEqual([{ channelId: 'channel', reason: 'mention', triggeringMessageId: '99' }])
  })

  it('keeps an answered context\'s messages from triggering when they are polled later, its newest included', async () => {
    const { loop, soma } = makeLoop()
    loop.recordAnsweredContext('channel', '100')

    await loop.processBatch([message('channel', '99', { content: '<@bot-user> hi', mentionsBot: true })])
    await loop.processBatch([message('channel', '100', { content: '<@bot-user> hi', mentionsBot: true })])

    expect(soma).toEqual([])
  })

  it('still runs an m command an answered context already had', async () => {
    const { loop, soma, deleted } = makeLoop()
    loop.recordAnsweredContext('channel', '100')

    await loop.processBatch([message('channel', '99', { content: 'm continue <@bot-user>', mentionsBot: true })])

    expect(deleted).toEqual(['99'])
    expect(soma.map((call) => call.reason)).toEqual(['m_command'])
  })

  it('leaves this bot\'s own messages out of the trace\'s trigger events', () => {
    const { loop } = makeLoop()
    const botChunk = message('channel', '601', { author: BOT_USER })
    const mention = message('channel', '602', { content: '<@bot-user> hi', mentionsBot: true })

    const traced = loop.determineActivationReason([botChunk, mention])

    expect(traced.reason).toBe('mention')
    expect(traced.events.map((event: any) => event.messageId)).toEqual(['602'])
  })

  it('lets a message whose id is not a snowflake string decide as usual', async () => {
    const { loop, soma } = makeLoop()
    loop.recordAnsweredContext('channel', '100')
    const oddId = message('channel', 'ignored', { content: '<@bot-user> hi', mentionsBot: true })
    oddId.data.id = 42

    await loop.processBatch([oddId])

    expect(soma).toEqual([{ channelId: 'channel', reason: 'mention', triggeringMessageId: 42 }])
  })

  it('keeps the newest 500 events of an active channel, logging the first drop and each further hundred', async () => {
    const { loop } = makeLoop()
    const warn = vi.spyOn(logger, 'warn')
    loop.activeChannels.add('channel')
    const events = Array.from({ length: 600 }, (_, index) => message('channel', String(1000 + index)))

    for (const event of events) await loop.processBatch([event])

    expect(loop.pendingChannelEvents.get('channel').events).toEqual(events.slice(100))
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      { channelId: 'channel', dropped: 1, droppedTypes: ['message'], kept: 500 },
      { channelId: 'channel', dropped: 100, droppedTypes: ['message'], kept: 500 },
    ])
  })

  it('decides each channel\'s events with that channel, polled from one queue', async () => {
    const { loop, queue, soma } = makeLoop()
    queue.push(message('channel-a', '401'))
    queue.push(message('channel-b', '402', { content: '<@bot-user> hi', mentionsBot: true }))

    for (let batch = queue.pollBatch(); batch.length > 0; batch = queue.pollBatch()) {
      await loop.processBatch(batch)
    }

    expect(soma).toEqual([{ channelId: 'channel-b', reason: 'mention', triggeringMessageId: '402' }])
  })

  // With streaming off, membrane runs no tool calls on the native tool path:
  // 0.5.47 returns the model's calls unexecuted, so the bot announced a call and
  // stopped, and 0.5.81 to 0.6.0 refuse the request.
  it('sends a bot with streaming off on the native tool path no tools, and warns while it has tools to withhold', async () => {
    const tool = { name: 'lookup', description: 'Look something up', inputSchema: { type: 'object', properties: {} } }
    const message = 'Tools not sent: with streaming off, membrane runs no tool calls on the native tool path. Set tools_enabled: false to stop this warning.'
    const cases = [
      { config: { streaming: false }, available: [tool], path: 'native', tools: undefined, warned: true },
      { config: { streaming: false, continuation_model: 'claude-sonnet-4-5', mode: 'chat' }, available: [tool], path: 'native', tools: undefined, warned: true },
      { config: { streaming: false }, available: [], path: 'native', tools: undefined, warned: false },
      { config: { streaming: false, tools_enabled: false }, available: [tool], path: 'native', tools: undefined, warned: false },
      { config: {}, available: [tool], path: 'native', tools: [tool], warned: false },
      { config: { streaming: true }, available: [tool], path: 'native', tools: [tool], warned: false },
      { config: { streaming: false, continuation_model: 'claude-sonnet-4-5' }, available: [tool], path: 'inline', tools: [tool], warned: false },
    ]
    for (const { config, available, path, tools, warned } of cases) {
      const warn = vi.spyOn(logger, 'warn')
      const harness = makeLoop(['allowed'], { tools_enabled: true, ...config }, available)
      harness.setFetchContext(async () => ({ messages: [{ id: '100' }], images: [] }))

      await harness.loop.processBatch([timer('channel', 'timer')])
      await vi.waitFor(() => expect(harness.answered.count).toBe(1))

      expect(harness.requests.map((r) => r.path)).toEqual([path])
      expect(harness.requests[0].request.tools).toEqual(tools)
      const toolWarnings = warn.mock.calls.filter((call) => String(call[1]).startsWith('Tools not sent'))
      expect(toolWarnings).toEqual(warned
        ? [[{ channelId: 'channel', model: (config as { continuation_model?: string }).continuation_model ?? 'test-model', toolCount: 1 }, message]]
        : [])
      warn.mockRestore()
    }
  })
})
