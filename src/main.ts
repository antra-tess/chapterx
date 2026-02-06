/**
 * Chapter3 - Discord Bot Framework
 * Main entry point
 */

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

    // Support chapter2 EMS layout: EMS_PATH + BOT_NAME
    // e.g., EMS_PATH=/opt/chapter2/ems BOT_NAME=StrangeSonnet4.5
    // This loads:
    //   - Shared config from <EMS_PATH>/config.yaml
    //   - Bot config from <EMS_PATH>/<BOT_NAME>/config.yaml
    //   - Discord token from <EMS_PATH>/<BOT_NAME>/discord_token
    const emsPath = process.env.EMS_PATH
    const botNameOverride = process.env.BOT_NAME

    // Get configuration paths
    let configPath: string
    let tokenFilePath: string
    
    if (emsPath && botNameOverride) {
      // Chapter2 EMS layout
      configPath = emsPath  // ConfigSystem will handle the structure
      tokenFilePath = join(emsPath, botNameOverride, 'discord_token')
      logger.info({ emsPath, botName: botNameOverride }, 'Using chapter2 EMS layout')
    } else if (botNameOverride) {
      // Local dev with BOT_NAME override
      configPath = process.env.CONFIG_PATH || './config'
      tokenFilePath = process.env.DISCORD_TOKEN_FILE 
        ? join(process.cwd(), process.env.DISCORD_TOKEN_FILE)
        : join(configPath, 'bots', `${botNameOverride}_discord_token`)
      logger.info({ botName: botNameOverride }, 'Using local dev layout with BOT_NAME')
    } else {
      // Default chapterx layout
      configPath = process.env.CONFIG_PATH || './config'
      tokenFilePath = process.env.DISCORD_TOKEN_FILE 
        ? join(process.cwd(), process.env.DISCORD_TOKEN_FILE)
        : join(process.cwd(), 'discord_token')
    }
    
    const toolsPath = process.env.TOOLS_PATH || './tools'
    const cachePath = process.env.CACHE_PATH || './cache'

    // Read Discord token from file
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

    // Initialize components
    const queue = new EventQueue()
    const stateManager = new ChannelStateManager()
    const configSystem = new ConfigSystem(configPath)

    // Initialize timer scheduler (for self-activation)
    const timerScheduler = createTimerScheduler(cachePath)
    await timerScheduler.initialize((event) => {
      // Push timer events to the queue for processing
      queue.push(event)
      logger.info({
        type: event.type,
        channelId: event.channelId,
        timerId: event.data?.timerId,
      }, 'Timer event pushed to queue')
    })
    const contextBuilder = new ContextBuilder()
    const toolSystem = new ToolSystem(toolsPath)

    // Load vendor configs for membrane initialization
    const vendorConfigs = configSystem.loadVendors()

    // Note: MCP servers are initialized on first bot activation
    // They are configured in bot config and can be overridden per-guild/channel

    // Initialize Discord connector
    const connector = new DiscordConnector(queue, {
      token: discordToken,
      cacheDir: cachePath + '/images',
      maxBackoffMs: 32000,
    })

    await connector.start()

    // Get bot's Discord identity
    const botUserId = connector.getBotUserId()
    const botUsername = connector.getBotUsername()
    
    if (!botUserId || !botUsername) {
      throw new Error('Failed to get bot identity from Discord')
    }

    // Use BOT_NAME override (for EMS mode) or Discord username for config loading
    const botName = botNameOverride || botUsername
    logger.info({ botUsername, botUserId, botName, emsMode: !!emsPath }, 'Bot identity established')

    // Generate and log the bot invite URL
    const inviteUrl = connector.generateInviteUrl()
    if (inviteUrl) {
      logger.info({ inviteUrl }, 'Bot invite URL (add to server)')
    }

    // Create and start agent loop
    const agentLoop = new AgentLoop(
      botName,  // Bot name from BOT_NAME env var (EMS mode) or Discord username
      queue,
      connector,
      stateManager,
      configSystem,
      contextBuilder,
      toolSystem
    )

    // Set bot's Discord user ID for mention detection
    agentLoop.setBotUserId(botUserId)

    // Load bot config early to get the display name for membrane
    const botConfigOnly = configSystem.loadBotConfigOnly(botName)
    const membraneAssistantName = botConfigOnly.name || botName

    // Initialize membrane (required for LLM calls)
    if (process.env.MOCK_LLM) {
      const { MockMembrane } = await import('./llm/membrane/mock.js')
      agentLoop.setMembrane(new MockMembrane() as any)
      logger.info('Using MockMembrane (MOCK_LLM=1) - no real LLM calls')
    } else {
      const membrane = createMembraneFromVendorConfigs(vendorConfigs, membraneAssistantName)
      agentLoop.setMembrane(membrane)
      logger.info({ assistantName: membraneAssistantName }, 'Membrane initialized for agent loop')
    }

    // Initialize TTS relay if configured in bot config
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

    // Start API server if configured
    let apiServer: ApiServer | null = null
    const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT) : 3000
    const apiBearerToken = process.env.API_BEARER_TOKEN
    
    if (apiBearerToken) {
      apiServer = new ApiServer(
        { port: apiPort, bearerToken: apiBearerToken },
        connector
      )
      await apiServer.start()
    } else {
      logger.info('API server disabled (no API_BEARER_TOKEN set)')
    }

    // Handle shutdown
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

    // Start the loop
    await agentLoop.run()

  } catch (error) {
    logger.fatal({ error }, 'Fatal error')
    process.exit(1)
  }
}

// Run
main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})

