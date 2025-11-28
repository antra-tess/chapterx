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
      ...channelConfigs.map((yaml) => this.parseChannelConfig(yaml, botName)),
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

  private parseChannelConfig(yamlString: string, botName: string): Partial<BotConfig> {
    try {
      const config = YAML.parse(yamlString) || {}
      
      logger.debug({ 
        yamlString, 
        parsedConfig: config, 
        target: config.target, 
        botName,
        match: config.target === botName
      }, 'Parsing channel config')
      
      // If config has a target field, only apply if it matches this bot
      if (config.target && config.target !== botName) {
        logger.debug({ target: config.target, botName }, 'Skipping config with different target')
        return {}
      }
      
      // Remove target field from config (it's metadata, not a config value)
      delete config.target
      
      return config
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
      prefill_thinking: config.prefill_thinking || false,
      debug_thinking: config.debug_thinking || false,
      preserve_thinking_context: config.preserve_thinking_context || false,
      continuation_model: config.continuation_model || '',
      temperature: config.temperature ?? 1.0,
      max_tokens: config.max_tokens || 4096,
      top_p: config.top_p ?? 1.0,

      // Context config
      recency_window_messages: config.recency_window_messages,
      recency_window_characters: config.recency_window_characters,
      hard_max_characters: config.hard_max_characters,
      rolling_threshold: config.rolling_threshold || 50,
      recent_participant_count: config.recent_participant_count || 10,
      authorized_roles: config.authorized_roles || [],

      // Image config
      include_images: config.include_images ?? true,
      max_images: config.max_images || 5,

      // Tool config
      tools_enabled: config.tools_enabled ?? true,
      tool_output_visible: config.tool_output_visible ?? false,
      max_tool_depth: config.max_tool_depth || 100,
      mcp_servers: config.mcp_servers,
      tool_plugins: config.tool_plugins || [],

      // Stop sequences
      stop_sequences: config.stop_sequences || [],

      // Retries
      llm_retries: config.llm_retries || 3,
      discord_backoff_max: config.discord_backoff_max || 32000,

      // Misc
      system_prompt: config.system_prompt,
      reply_on_random: config.reply_on_random ?? 500,
      reply_on_name: config.reply_on_name ?? false,
      max_queued_replies: config.max_queued_replies || 1,
      
      // Loop prevention
      max_bot_reply_chain_depth: config.max_bot_reply_chain_depth ?? 2,
      bot_reply_chain_depth_emote: config.bot_reply_chain_depth_emote || '🔁',
    }
  }

  private validateConfig(config: BotConfig): void {
    validateBotConfig(config)

    if (!config.continuation_model) {
      throw new ConfigError('continuation_model is required')
    }

    if (config.temperature < 0 || config.temperature > 2) {
      throw new ConfigError('temperature must be between 0 and 2')
    }

    if (config.max_tokens <= 0) {
      throw new ConfigError('max_tokens must be positive')
    }

    if (config.top_p < 0 || config.top_p > 1) {
      throw new ConfigError('top_p must be between 0 and 1')
    }
  }
}

