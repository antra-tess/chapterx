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
  private emsMode: boolean
  
  constructor(private configBasePath: string) {
    // Detect EMS mode: if EMS_PATH is set, use chapter2 layout
    this.emsMode = !!process.env.EMS_PATH
  }

  /**
   * Load and merge configuration for a specific bot/guild/channel
   */
  loadConfig(params: LoadConfigParams): BotConfig {
    const { botName, guildId, channelConfigs } = params

    logger.debug({ botName, guildId, emsMode: this.emsMode }, 'Loading config')

    // Load configs in priority order (each overrides previous)
    const configs: Partial<BotConfig>[] = [
      this.loadSharedConfig(),
      this.loadGuildConfig(guildId),
      this.loadBotConfig(botName),
      this.loadBotGuildConfig(botName, guildId),
      ...channelConfigs.map((yaml) => this.parseChannelConfig(yaml, botName)),
    ]

    // Merge all configs
    const merged = this.mergeConfigs(configs, botName)

    // Validate final config
    this.validateConfig(merged)

    logger.debug({ config: merged }, 'Config loaded successfully')

    return merged
  }

  /**
   * Load vendors configuration for LLM providers
   * In EMS mode: <EMS_PATH>/config.yaml (vendors section)
   * In default mode: <CONFIG_PATH>/shared.yaml (vendors section)
   */
  loadVendors(): Record<string, VendorConfig> {
    const sharedPath = this.emsMode
      ? join(this.configBasePath, 'config.yaml')  // EMS: /opt/chapter2/ems/config.yaml
      : join(this.configBasePath, 'shared.yaml')  // Default: ./config/shared.yaml
      
    if (!existsSync(sharedPath)) {
      logger.warn({ sharedPath, emsMode: this.emsMode }, 'Shared config not found')
      return {}
    }

    const content = readFileSync(sharedPath, 'utf-8')
    const parsed = YAML.parse(content)
    return parsed?.vendors || {}
  }

  private loadSharedConfig(): Partial<BotConfig> {
    // In EMS mode, shared config is at <EMS_PATH>/config.yaml
    // In default mode, it's at <CONFIG_PATH>/shared.yaml
    const path = this.emsMode
      ? join(this.configBasePath, 'config.yaml')
      : join(this.configBasePath, 'shared.yaml')
    return this.loadYAMLFile(path)
  }

  private loadGuildConfig(guildId: string): Partial<BotConfig> {
    // Guild configs: same structure in both modes
    // EMS: <EMS_PATH>/guilds/<guildId>.yaml (if exists)
    // Default: <CONFIG_PATH>/guilds/<guildId>.yaml
    return this.loadYAMLFile(join(this.configBasePath, 'guilds', `${guildId}.yaml`))
  }

  private loadBotConfig(botName: string): Partial<BotConfig> {
    // In EMS mode: <EMS_PATH>/<botName>/config.yaml
    // In default mode: <CONFIG_PATH>/bots/<botName>.yaml
    const path = this.emsMode
      ? join(this.configBasePath, botName, 'config.yaml')
      : join(this.configBasePath, 'bots', `${botName}.yaml`)
    return this.loadYAMLFile(path)
  }

  private loadBotGuildConfig(botName: string, guildId: string): Partial<BotConfig> {
    // In EMS mode: <EMS_PATH>/<botName>/guilds/<guildId>.yaml
    // In default mode: <CONFIG_PATH>/bots/<botName>-<guildId>.yaml
    const path = this.emsMode
      ? join(this.configBasePath, botName, 'guilds', `${guildId}.yaml`)
      : join(this.configBasePath, 'bots', `${botName}-${guildId}.yaml`)
    return this.loadYAMLFile(path)
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

  private mergeConfigs(configs: Partial<BotConfig>[], botName: string): BotConfig {
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
    return this.applyDefaults(merged, botName)
  }

  private applyDefaults(config: Partial<BotConfig>, botName: string): BotConfig {
    // Resolve path for bot-specific files (system_prompt_file, context_prefix_file)
    // EMS mode: <EMS_PATH>/<botName>/<file>
    // Default mode: <CONFIG_PATH>/bots/<file>
    const resolveBotFilePath = (filename: string): string => {
      return this.emsMode
        ? join(this.configBasePath, botName, filename)
        : join(this.configBasePath, 'bots', filename)
    }

    // Load system prompt from file if specified
    let systemPrompt = config.system_prompt
    if (config.system_prompt_file && !systemPrompt) {
      const promptPath = resolveBotFilePath(config.system_prompt_file)
      if (existsSync(promptPath)) {
        systemPrompt = readFileSync(promptPath, 'utf-8')
        logger.info({ path: promptPath, length: systemPrompt.length }, 'Loaded system prompt from file')
      } else {
        logger.warn({ path: promptPath }, 'System prompt file not found')
      }
    }

    // Load context prefix from file if specified (inserted as first cached assistant message)
    let contextPrefix = config.context_prefix
    if (config.context_prefix_file && !contextPrefix) {
      const prefixPath = resolveBotFilePath(config.context_prefix_file)
      if (existsSync(prefixPath)) {
        contextPrefix = readFileSync(prefixPath, 'utf-8')
        logger.info({ path: prefixPath, length: contextPrefix.length }, 'Loaded context prefix from file')
      } else {
        logger.warn({ path: prefixPath }, 'Context prefix file not found')
      }
    }

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
      presence_penalty: config.presence_penalty,
      frequency_penalty: config.frequency_penalty,

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
      plugin_config: config.plugin_config,

      // Stop sequences
      stop_sequences: config.stop_sequences || [],
      message_delimiter: config.message_delimiter,  // Optional: e.g., '</s>' for base models

      // Chat mode persona
      chat_persona_prompt: config.chat_persona_prompt ?? true,
      chat_persona_prefill: config.chat_persona_prefill ?? true,
      chat_bot_as_assistant: config.chat_bot_as_assistant ?? true,

      // Retries
      llm_retries: config.llm_retries || 3,
      discord_backoff_max: config.discord_backoff_max || 32000,

      // Misc
      system_prompt: systemPrompt,
      system_prompt_file: config.system_prompt_file,
      context_prefix: contextPrefix,
      context_prefix_file: config.context_prefix_file,
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

