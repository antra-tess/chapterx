import { readFileSync } from 'fs'
import { join } from 'path'
import { EventQueue } from './agent/event-queue.js'
import { AgentLoop } from './agent/loop.js'
import { ChannelStateManager } from './agent/state-manager.js'
import { DiscordConnector } from './discord/connector.js'
import { ConfigSystem } from './config/system.js'
import { ContextBuilder } from './context/builder.js'
import { ToolSystem } from './tools/system.js'
import { ApiServer } from './api/server.js'
import { logger } from './utils/logger.js'
import { createMembraneFromVendorConfigs } from './llm/membrane/index.js'
import { createTimerScheduler } from './timer/index.js'

async function main() {
  try {
    logger.info('Starting Chapter3 bot framework')

    const emsPath = process.env.EMS_PATH
    const botNameOverride = process.env.BOT_NAME

    let configPath: string
    let tokenFilePath: string
    
    if (emsPath && botNameOverride) {
      configPath = emsPath
      tokenFilePath = join(emsPath, botNameOverride, 'discord_token')
      logger.info({ emsPath, botName: botNameOverride }, 'Using chapter2 EMS layout')
    } else if (botNameOverride) {
      configPath = process.env.CONFIG_PATH || './config'
      tokenFilePath = process.env.DISCORD_TOKEN_FILE 
        ? join(process.cwd(), process.env.DISCORD_TOKEN_FILE)
        : join(configPath, 'bots', `${botNameOverride}_discord_token`)
      logger.info({ botName: botNameOverride }, 'Using local dev layout with BOT_NAME')
    } else {
      configPath = process.env.CONFIG_PATH || './config'
      tokenFilePath = process.env.DISCORD_TOKEN_FILE 
        ? join(process.cwd(), process.env.DISCORD_TOKEN_FILE)
        : join(process.cwd(), 'discord_token')
    }
    
    const toolsPath = process.env.TOOLS_PATH || './tools'
    const cachePath = process.env.CACHE_PATH || './cache'

    let discordToken: string
    
    try {
      discordToken = readFileSync(tokenFilePath, 'utf-8').trim()
      logger.info({ tokenFile: tokenFilePath }, 'Discord token loaded from file')
    } catch (error) {
      logger.error({ error, tokenFile: tokenFilePath }, 'Failed to read discord_token file')
      throw new Error(`Could not read token file: ${tokenFilePath}. Please create it with your bot token.`)
    }

    if (!discordToken) {
      throw new Error('discord_token file is empty')
    }

    logger.info({ configPath, toolsPath, cachePath, emsMode: !!emsPath }, 'Configuration loaded')

    const queue = new EventQueue()
    const stateManager = new ChannelStateManager()
    const configSystem = new ConfigSystem(configPath)

    const timerScheduler = createTimerScheduler(cachePath)
    await timerScheduler.initialize((event) => {
      queue.push(event)
      logger.info({
        type: event.type,
        channelId: event.channelId,
        timerId: event.data?.timerId,
      }, 'Timer event pushed to queue')
    })
    const contextBuilder = new ContextBuilder()
    const toolSystem = new ToolSystem(toolsPath)

    const vendorConfigs = configSystem.loadVendors()

    const connector = new DiscordConnector(queue, {
      token: discordToken,
      cacheDir: cachePath + '/images',
      maxBackoffMs: 32000,
    })

    await connector.start()

    const botUserId = connector.getBotUserId()
    const botUsername = connector.getBotUsername()
    
    if (!botUserId || !botUsername) {
      throw new Error('Failed to get bot identity from Discord')
    }

    const botName = botNameOverride || botUsername
    logger.info({ botUsername, botUserId, botName, emsMode: !!emsPath }, 'Bot identity established')

    const inviteUrl = connector.generateInviteUrl()
    if (inviteUrl) {
      logger.info({ inviteUrl }, 'Bot invite URL (add to server)')
    }

    const agentLoop = new AgentLoop(
      botName,
      queue,
      connector,
      stateManager,
      configSystem,
      contextBuilder,
      toolSystem
    )

    agentLoop.setBotUserId(botUserId)

    const { initCatalogDir } = await import('./steering/index.js')
    initCatalogDir(configPath + '/probes')
    agentLoop.setVendorConfigs(vendorConfigs)
    logger.info({ catalogDir: configPath + '/probes' }, 'Steering probe catalog initialized')

    const botConfigOnly = configSystem.loadBotConfigOnly(botName)
    const membraneAssistantName = botConfigOnly.name || botName

    if (process.env.MOCK_LLM) {
      const { MockMembrane } = await import('./llm/membrane/mock.js')
      agentLoop.setMembrane(new MockMembrane() as any)
      logger.info('Using MockMembrane (MOCK_LLM=1) - no real LLM calls')
    } else {
      const membrane = createMembraneFromVendorConfigs(vendorConfigs, membraneAssistantName, {
        retries: botConfigOnly.llm_retries,
      })
      agentLoop.setMembrane(membrane)
      logger.info({ assistantName: membraneAssistantName }, 'Membrane initialized for agent loop')
    }

    if (botConfigOnly.tts_relay?.enabled) {
      try {
        await agentLoop.setTTSRelay({
          url: botConfigOnly.tts_relay.url,
          token: botConfigOnly.tts_relay.token,
          reconnectIntervalMs: botConfigOnly.tts_relay.reconnect_interval_ms,
        })
        logger.info({
          url: botConfigOnly.tts_relay.url,
          botName
        }, 'TTS relay initialized')
      } catch (error) {
        logger.error({ error }, 'Failed to initialize TTS relay')
      }
    }

    let apiServer: ApiServer | null = null
    const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT) : 3000
    const apiBearerToken = process.env.API_BEARER_TOKEN
    
    if (apiBearerToken) {
      apiServer = new ApiServer(
        { port: apiPort, bearerToken: apiBearerToken },
        connector,
        configSystem,
        contextBuilder,
        botName
      )
      await apiServer.start()
    } else {
      logger.info('API server disabled (no API_BEARER_TOKEN set)')
    }

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down')

      agentLoop.stop()
      timerScheduler.stop()
      if (apiServer) {
        await apiServer.stop()
      }
      await connector.close()
      await toolSystem.close()

      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    await agentLoop.run()

  } catch (error) {
    logger.fatal({ err: error }, 'Fatal error')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})

