/**
 * Configuration System
 * Loads and merges YAML configs from multiple sources
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as YAML from 'yaml'
import { BotConfig, VendorConfig, ConfigError } from '../types.js'
import { logger } from '../utils/logger.js'
import { validateBotConfig } from '../utils/validation.js'

export interface LoadConfigParams {
  botName: string
  guildId: string
  channelConfigs: string[]  // Raw YAML strings from pinned messages
}

export class ConfigSystem {
  constructor(private configBasePath: string) {}

  /**
   * Load and merge configuration for a specific bot/guild/channel
   */
  loadConfig(params: LoadConfigParams): BotConfig {
    const { botName, guildId, channelConfigs } = params

    logger.debug({ botName, guildId }, 'Loading config')

    // Load configs in priority order (each overrides previous)
    const configs: Partial<BotConfig>[] = [
      this.loadSharedConfig(),
      this.loadGuildConfig(guildId),
      this.loadBotConfig(botName),
      this.loadBotGuildConfig(botName, guildId),
      ...channelConfigs.map((yaml) => this.parseChannelConfig(yaml)),
    ]

    // Merge all configs
    const merged = this.mergeConfigs(configs)

    // Validate final config
    this.validateConfig(merged)

    logger.debug({ config: merged }, 'Config loaded successfully')

    return merged
  }

  /**
   * Load vendors configuration for LLM providers
   */
  loadVendors(): Record<string, VendorConfig> {
    const sharedPath = join(this.configBasePath, 'shared.yaml')
    if (!existsSync(sharedPath)) {
      return {}
    }

    const content = readFileSync(sharedPath, 'utf-8')
    const parsed = YAML.parse(content)
    return parsed?.vendors || {}
  }

  private loadSharedConfig(): Partial<BotConfig> {
    return this.loadYAMLFile(join(this.configBasePath, 'shared.yaml'))
  }

  private loadGuildConfig(guildId: string): Partial<BotConfig> {
    return this.loadYAMLFile(join(this.configBasePath, 'guilds', `${guildId}.yaml`))
  }

  private loadBotConfig(botName: string): Partial<BotConfig> {
    return this.loadYAMLFile(join(this.configBasePath, 'bots', `${botName}.yaml`))
  }

  private loadBotGuildConfig(botName: string, guildId: string): Partial<BotConfig> {
    return this.loadYAMLFile(
      join(this.configBasePath, 'bots', `${botName}-${guildId}.yaml`)
    )
  }

  private parseChannelConfig(yamlString: string): Partial<BotConfig> {
    try {
      return YAML.parse(yamlString) || {}
    } catch (error) {
      logger.warn({ error, yaml: yamlString }, 'Failed to parse channel config')
      return {}
    }
  }

  private loadYAMLFile(path: string): Partial<BotConfig> {
    if (!existsSync(path)) {
      return {}
    }

    try {
      const content = readFileSync(path, 'utf-8')
      return YAML.parse(content) || {}
    } catch (error) {
      logger.warn({ error, path }, 'Failed to load config file')
      return {}
    }
  }

  private mergeConfigs(configs: Partial<BotConfig>[]): BotConfig {
    // Deep merge all configs
    const merged: any = {}

    for (const config of configs) {
      for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
          continue
        }

        if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
          // Deep merge objects
          const existing = merged[key] || {}
          merged[key] = { ...existing, ...(value as Record<string, any>) }
        } else {
          // Override primitives and arrays
          merged[key] = value
        }
      }
    }

    // Apply defaults
    return this.applyDefaults(merged)
  }

  private applyDefaults(config: Partial<BotConfig>): BotConfig {
    return {
      // Identity (required, no defaults)
      name: config.name || '',
      innerName: config.innerName || config.name || '',

      // Model config
      mode: config.mode || 'prefill',
      continuationModel: config.continuationModel || '',
      temperature: config.temperature ?? 1.0,
      maxTokens: config.maxTokens || 4096,
      topP: config.topP ?? 1.0,

      // Context config
      recencyWindowMessages: config.recencyWindowMessages,
      recencyWindowCharacters: config.recencyWindowCharacters,
      rollingThreshold: config.rollingThreshold || 50,
      recentParticipantCount: config.recentParticipantCount || 10,
      authorizedRoles: config.authorizedRoles || [],

      // Image config
      includeImages: config.includeImages ?? true,
      maxImages: config.maxImages || 5,

      // Tool config
      toolsEnabled: config.toolsEnabled ?? true,
      toolOutputVisible: config.toolOutputVisible ?? false,
      maxToolDepth: config.maxToolDepth || 100,
      mcpServers: config.mcpServers,

      // Stop sequences
      stopSequences: config.stopSequences || [],

      // Retries
      llmRetries: config.llmRetries || 3,
      discordBackoffMax: config.discordBackoffMax || 32000,

      // Misc
      systemPrompt: config.systemPrompt,
      replyOnRandom: config.replyOnRandom ?? 500,
      replyOnName: config.replyOnName ?? false,
      maxQueuedReplies: config.maxQueuedReplies || 1,
    }
  }

  private validateConfig(config: BotConfig): void {
    validateBotConfig(config)

    if (!config.continuationModel) {
      throw new ConfigError('continuationModel is required')
    }

    if (config.temperature < 0 || config.temperature > 2) {
      throw new ConfigError('temperature must be between 0 and 2')
    }

    if (config.maxTokens <= 0) {
      throw new ConfigError('maxTokens must be positive')
    }

    if (config.topP < 0 || config.topP > 1) {
      throw new ConfigError('topP must be between 0 and 1')
    }
  }
}

