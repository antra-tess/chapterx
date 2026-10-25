import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import * as YAML from 'yaml'
import { BotConfig, VendorConfig, ConfigError } from '../types.js'
import { logger } from '../utils/logger.js'
import { validateBotConfig } from '../utils/validation.js'

export interface LoadConfigParams {
  botName: string
  guildId: string
  channelConfigs: string[]
}

export class ConfigSystem {
  private emsMode: boolean
  
  constructor(private configBasePath: string) {
    this.emsMode = !!process.env.EMS_PATH
  }

  loadConfig(params: LoadConfigParams): BotConfig {
    const { botName, guildId, channelConfigs } = params

    logger.debug({ botName, guildId, emsMode: this.emsMode }, 'Loading config')

    const botConfig = this.loadBotConfig(botName)
    const botDisplayName = botConfig.name

    const configs: Partial<BotConfig>[] = [
      this.loadSharedConfig(),
      this.loadGuildConfig(guildId),
      botConfig,
      this.loadBotGuildConfig(botName, guildId),
      ...channelConfigs.map((yaml) => this.parseChannelConfig(yaml, botName, botDisplayName)),
    ]

    const merged = this.mergeConfigs(configs, botName)

    this.validateConfig(merged)

    logger.debug({ config: merged }, 'Config loaded successfully')

    return merged
  }

  loadBotConfigOnly(botName: string): Partial<BotConfig> & { tts_relay?: import('../types.js').TTSRelayConfig } {
    const configs = [
      this.loadSharedConfig(),
      this.loadBotConfig(botName),
    ]

    const merged: any = {}
    for (const config of configs) {
      for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) continue
        if (typeof value === 'object' && !Array.isArray(value)) {
          merged[key] = { ...(merged[key] || {}), ...value }
        } else {
          merged[key] = value
        }
      }
    }

    return merged
  }

  loadVendors(): Record<string, VendorConfig> {
    const sharedPath = this.emsMode
      ? join(this.configBasePath, 'config.yaml')
      : join(this.configBasePath, 'shared.yaml')
      
    if (!existsSync(sharedPath)) {
      logger.warn({ sharedPath, emsMode: this.emsMode }, 'Shared config not found')
      return {}
    }

    const content = readFileSync(sharedPath, 'utf-8')
    const parsed = YAML.parse(content)
    return parsed?.vendors || {}
  }

  private loadSharedConfig(): Partial<BotConfig> {
    const path = this.emsMode
      ? join(this.configBasePath, 'config.yaml')
      : join(this.configBasePath, 'shared.yaml')
    return this.loadYAMLFile(path)
  }

  private loadGuildConfig(guildId: string): Partial<BotConfig> {
    return this.loadYAMLFile(join(this.configBasePath, 'guilds', `${guildId}.yaml`))
  }

  private loadBotConfig(botName: string): Partial<BotConfig> {
    const path = this.emsMode
      ? join(this.configBasePath, botName, 'config.yaml')
      : join(this.configBasePath, 'bots', `${botName}.yaml`)
    return this.loadYAMLFile(path)
  }

  private loadBotGuildConfig(botName: string, guildId: string): Partial<BotConfig> {
    const path = this.emsMode
      ? join(this.configBasePath, botName, 'guilds', `${guildId}.yaml`)
      : join(this.configBasePath, 'bots', `${botName}-${guildId}.yaml`)
    return this.loadYAMLFile(path)
  }

  private parseChannelConfig(yamlString: string, botName: string, botDisplayName?: string): Partial<BotConfig> {
    try {
      const config = YAML.parse(yamlString) || {}

      const rawTarget = config.target ? String(config.target).replace(/^<@!?([^>]+)>$/, '$1') : undefined
      const target = rawTarget?.toLowerCase()
      const matchesBotId = target === botName.toLowerCase()
      const matchesDisplayName = botDisplayName && target === botDisplayName.toLowerCase()
      const targetMatches = !config.target || matchesBotId || matchesDisplayName

      logger.debug({
        yamlString,
        parsedConfig: config,
        target: config.target,
        botName,
        botDisplayName,
        match: targetMatches
      }, 'Parsing channel config')

      if (!targetMatches) {
        logger.debug({ target: config.target, botName, botDisplayName }, 'Skipping config with different target')
        return {}
      }
      
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
    const merged: any = {}

    for (const config of configs) {
      for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
          continue
        }

        if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
          const existing = merged[key] || {}
          merged[key] = { ...existing, ...(value as Record<string, any>) }
        } else {
          merged[key] = value
        }
      }
    }

    return this.applyDefaults(merged, botName)
  }

  private applyDefaults(config: Partial<BotConfig>, botName: string): BotConfig {
    const resolveBotFilePath = (filename: string): string => {
      return this.emsMode
        ? join(this.configBasePath, botName, filename)
        : join(this.configBasePath, 'bots', filename)
    }

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

    let prefillUserMessage = config.prefill_user_message
    if (config.prefill_user_message_file && !prefillUserMessage) {
      const prefillPath = resolveBotFilePath(config.prefill_user_message_file)
      if (existsSync(prefillPath)) {
        prefillUserMessage = readFileSync(prefillPath, 'utf-8')
        logger.info({ path: prefillPath, length: prefillUserMessage.length }, 'Loaded prefill user message from file')
      } else {
        logger.warn({ path: prefillPath }, 'Prefill user message file not found')
      }
    }

    return {
      name: config.name || '',

      prefill_thinking: config.prefill_thinking || false,
      debug_thinking: config.debug_thinking || false,
      thinking_budget: config.thinking_budget,
      thinking_type: config.thinking_type,
      preserve_thinking_context: config.preserve_thinking_context || false,
      preserve_thinking_blocks: config.preserve_thinking_blocks !== false,
      continuation_model: config.continuation_model || '',
      temperature: config.temperature ?? 1.0,
      max_tokens: config.max_tokens || 4096,
      top_p: config.top_p,
      presence_penalty: config.presence_penalty,
      frequency_penalty: config.frequency_penalty,
      repetition_penalty: config.repetition_penalty,

      recency_window_messages: config.recency_window_messages,
      recency_window_characters: config.recency_window_characters,
      hard_max_characters: config.hard_max_characters,
      rolling_threshold: config.rolling_threshold || 50,
      recent_participant_count: config.recent_participant_count || 10,
      authorized_roles: config.authorized_roles || [],
      steer_roles: config.steer_roles,
      steer_visible: config.steer_visible === true,
      steer_readout: config.steer_readout === true,
      prompt_caching: config.prompt_caching !== false,
      cache_ttl: config.cache_ttl,

      include_images: config.include_images ?? true,
      max_images: config.max_images || 5,
      generate_images: config.generate_images,
      provider_params: config.provider_params,

      include_text_attachments: config.include_text_attachments ?? true,
      max_text_attachment_kb: config.max_text_attachment_kb || 100,

      include_reply_tags: config.include_reply_tags ?? false,

      tools_enabled: config.tools_enabled ?? true,
      tool_output_visible: config.tool_output_visible ?? false,
      max_tool_depth: config.max_tool_depth || 100,
      max_mcp_images: config.max_mcp_images ?? 3,
      mcp_servers: config.mcp_servers,
      tool_plugins: config.tool_plugins || [],
      plugin_config: config.plugin_config,

      stop_sequences: config.stop_sequences || [],
      message_delimiter: config.message_delimiter,
      turn_end_token: config.turn_end_token,

      llm_retries: config.llm_retries ?? 0,
      discord_backoff_max: config.discord_backoff_max || 32000,
      deferred_retries: config.deferred_retries ?? false,
      supports_continuation: config.supports_continuation !== false,

      system_prompt: systemPrompt,
      system_prompt_file: config.system_prompt_file,
      context_prefix: contextPrefix,
      context_prefix_file: config.context_prefix_file,
      prefill_user_message: prefillUserMessage,
      prefill_user_message_file: config.prefill_user_message_file,
      reply_on_random: config.reply_on_random ?? 500,
      reply_on_name: config.reply_on_name ?? false,
      may_speak: config.may_speak,
      max_queued_replies: config.max_queued_replies || 1,
      
      max_bot_reply_chain_depth: config.max_bot_reply_chain_depth ?? 2,
      bot_reply_chain_depth_emote: config.bot_reply_chain_depth_emote || '🔁',

      ignore_dotted_messages: config.ignore_dotted_messages !== false,

      continuation_emoji: config.continuation_emoji ?? '▶️',
      
      soma: config.soma ? {
        enabled: config.soma.enabled ?? false,
        url: config.soma.url || '',
        token: config.soma.token,
      } : undefined,

      use_display_names: config.use_display_names ?? false,

      use_display_names_bots: config.use_display_names_bots ?? config.use_display_names ?? true,
      use_display_names_humans: config.use_display_names_humans ?? config.use_display_names ?? false,

      mention_format: config.mention_format,

      participant_stop_sequences: config.participant_stop_sequences ?? false,

      mode: config.mode,

      streaming: config.streaming,

      tts_relay: config.tts_relay,
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

    if (config.top_p !== undefined && (config.top_p < 0 || config.top_p > 1)) {
      throw new ConfigError('top_p must be between 0 and 1')
    }

    if (config.streaming === false && config.tts_relay?.enabled) {
      logger.warn(
        { botName: config.name },
        'streaming:false with tts_relay.enabled — TTS will receive synthesized callbacks from membrane.complete(), not real-time per-token delivery'
      )
    }
  }
}

