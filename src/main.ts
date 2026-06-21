/**
 * Chapter3 - Discord Bot Framework
 * Main entry point
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { EventQueue } from './agent/event-queue.js'
import { AgentLoop } from './agent/loop.js'
import { ChannelStateManager } from './agent/state-manager.js'
import { DiscordConnector } from './discord/connector.js'
import { PortalConnector } from './connector/portal/portal-connector.js'
import type { IConnector } from './connector/types.js'
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

    // ── Connector bootstrap settings (config-driven, env overrides) ──
    // Read straight from the bot's config.yaml so the whole portal setup lives in
    // one place (EMS: <EMS_PATH>/<BOT_NAME>/config.yaml). Env vars still win for
    // ad-hoc overrides. BOT_NAME is required for config-driven portal mode.
    let botBootstrap: Record<string, any> = {}
    if (botNameOverride) {
      const botCfgPath = emsPath
        ? join(emsPath, botNameOverride, 'config.yaml')
        : join(configPath, 'bots', `${botNameOverride}.yaml`)
      try {
        botBootstrap = parseYaml(readFileSync(botCfgPath, 'utf-8')) || {}
      } catch {
        logger.warn({ botCfgPath }, 'Could not pre-read bot config for connector settings')
      }
    }

    // Backend selection: 'portal' routes through the shared relay; default is the
    // bot's own discord.js gateway.
    const backend =
      (process.env.CONNECTOR_BACKEND || botBootstrap.connector_backend) === 'portal' ? 'portal' : 'discord'

    // Read Discord token from file (discord backend only).
    let discordToken = ''
    if (backend === 'discord') {
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

    // Initialize the connector for the selected backend.
    let connector: IConnector
    if (backend === 'portal') {
      const portalUrl = process.env.PORTAL_URL || botBootstrap.portal_url
      if (!portalUrl) throw new Error('portal backend requires portal_url (config) or PORTAL_URL (env)')
      let personaId = process.env.PORTAL_PERSONA
      let portalToken = process.env.PORTAL_TOKEN
      if (!personaId || !portalToken) {
        // Enroll ONCE and reuse the persona forever. The creds file must live on a
        // path that survives restarts/redeploys — in EMS mode default to the
        // (persistent) bot dir, not the (re-deployable) code/cache dir.
        const credsPath =
          process.env.PORTAL_CREDS_PATH ||
          botBootstrap.portal_creds_path ||
          (emsPath && botNameOverride
            ? join(emsPath, botNameOverride, 'portal-creds.json')
            : join(cachePath, 'portal-creds.json'))
        const { loadOrEnrollCreds } = await import('@animalabs/portal-client')
        const creds = await loadOrEnrollCreds({
          url: portalUrl,
          credsPath,
          invite: process.env.PORTAL_INVITE || botBootstrap.portal_invite,
          desiredName: botNameOverride,
        })
        personaId = creds.personaId
        portalToken = creds.token
        logger.info({ credsPath, personaId }, 'Portal persona credentials ready (enroll-once)')
      }
      // No explicit channel subscriptions: channel access is role/permission-based,
      // tracked relay-side.
      logger.info({ portalUrl, personaId }, 'Using portal backend')
      connector = new PortalConnector(queue, {
        url: portalUrl,
        token: portalToken,
        personaId,
        cacheDir: cachePath + '/images',
        maxBackoffMs: 32000,
      })
    } else {
      connector = new DiscordConnector(queue, {
        token: discordToken,
        cacheDir: cachePath + '/images',
        maxBackoffMs: 32000,
      })
    }

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

    // Initialize steering: probe catalog directory + vendor configs for /v1/encode calls
    const { initCatalogDir } = await import('./steering/index.js')
    initCatalogDir(configPath + '/probes')
    agentLoop.setVendorConfigs(vendorConfigs)
    logger.info({ catalogDir: configPath + '/probes' }, 'Steering probe catalog initialized')

    // Load bot config early to get the display name for membrane
    const botConfigOnly = configSystem.loadBotConfigOnly(botName)
    const membraneAssistantName = botConfigOnly.name || botName

    // Initialize membrane (required for LLM calls)
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
        connector,
        configSystem,
        contextBuilder,
        botName
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

