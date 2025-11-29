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
import { LLMMiddleware } from './llm/middleware.js'
import { AnthropicProvider } from './llm/providers/anthropic.js'
import { OpenAIProvider } from './llm/providers/openai.js'
import { ToolSystem } from './tools/system.js'
import { ApiServer } from './api/server.js'
import { logger } from './utils/logger.js'

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
    const contextBuilder = new ContextBuilder()
    const llmMiddleware = new LLMMiddleware()
    const toolSystem = new ToolSystem(toolsPath)

    // Load vendor configs and register providers
    const vendorConfigs = configSystem.loadVendors()
    llmMiddleware.setVendorConfigs(vendorConfigs)

    // Register Anthropic provider if configured
    // Look for any vendor with anthropic_api_key (chapter2 uses anthropic-steering-preview, etc.)
    const anthropicConfig = Object.values(vendorConfigs).find(v => v.config?.anthropic_api_key)
    if (anthropicConfig?.config.anthropic_api_key) {
      const provider = new AnthropicProvider(anthropicConfig.config.anthropic_api_key)
      llmMiddleware.registerProvider(provider)
      logger.info('Registered Anthropic provider')
    }

    // Register OpenAI provider if configured
    // Look for any vendor with openai_api_key (chapter2 uses openai-4o, openai-grok, etc.)
    const openaiConfig = Object.values(vendorConfigs).find(v => v.config?.openai_api_key)
    if (openaiConfig?.config.openai_api_key) {
      const provider = new OpenAIProvider({
        apiKey: openaiConfig.config.openai_api_key,
        // Support both chapter3's openai_base_url and chapter2's api_base
        baseUrl: openaiConfig.config.openai_base_url || openaiConfig.config.api_base,
      })
      llmMiddleware.registerProvider(provider)
      logger.info('Registered OpenAI provider')
    }

    // TODO: Register other providers (Bedrock, Google)

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

    // Create and start agent loop
    const agentLoop = new AgentLoop(
      botName,  // Bot name from BOT_NAME env var (EMS mode) or Discord username
      queue,
      connector,
      stateManager,
      configSystem,
      contextBuilder,
      llmMiddleware,
      toolSystem
    )

    // Set bot's Discord user ID for mention detection
    agentLoop.setBotUserId(botUserId)

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

