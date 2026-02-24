/**
 * Membrane Factory
 * 
 * Factory function for creating a Membrane instance configured for chapterx.
 * Handles:
 * - Provider adapter creation (Anthropic, OpenRouter, OpenAI, OpenAI-Compatible)
 * - Model routing (based on model name patterns)
 * - Tracing hook integration
 */

import {
  Membrane,
  AnthropicAdapter,
  OpenRouterAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  OpenAICompletionsAdapter,
  BedrockAdapter,
  GeminiAdapter,
  OpenAIResponsesAdapter,
  AnthropicXmlFormatter,
  NativeFormatter,
  CompletionsFormatter,
} from '@animalabs/membrane';
import type { ProviderAdapter, MembraneConfig, PrefillFormatter } from '@animalabs/membrane';
import { createTracingHooks } from './hooks.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Configuration Types
// ============================================================================

export interface OpenAICompatibleConfig {
  /** API key for the compatible endpoint */
  apiKey: string;
  /** Base URL (required, e.g., "http://localhost:8080/v1") */
  baseUrl: string;
  /** Provider name for logging (default: 'openai-compatible') */
  name?: string;
  /** Model patterns this provider serves (e.g., ["local:llama3.*", "local:k3"]) */
  provides?: string[];
}

export interface OpenAICompletionsConfig {
  /** API key for the completions endpoint */
  apiKey: string;
  /** Base URL (required, e.g., "http://localhost:8000/v1") */
  baseUrl: string;
  /** Provider name for logging (default: 'openai-completions') */
  name?: string;
  /** Model patterns this provider serves (e.g., ["base:llama3.*"]) */
  provides?: string[];
  /** Extra stop sequences beyond auto-generated participant-based ones */
  defaultStopSequences?: string[];
  /** Warn when images are stripped from context (default: true) */
  warnOnImageStrip?: boolean;
  /** End-of-turn token appended after each message (default: '<|eot|>', null to disable) */
  eotToken?: string | null;
}

export interface BedrockConfig {
  /** AWS access key ID */
  accessKeyId?: string;
  /** AWS secret access key */
  secretAccessKey?: string;
  /** AWS region (defaults to us-west-2) */
  region?: string;
  /** AWS session token (for temporary credentials) */
  sessionToken?: string;
  /** Model patterns this provider serves (e.g., ["bedrock:*", "anthropic.claude*"]) */
  provides?: string[];
}

export interface AnthropicProviderConfig {
  /** Anthropic API key */
  apiKey: string;
  /** Vendor/provider name (e.g., "anthropic-anima") */
  name: string;
  /** Model patterns this provider serves (e.g., ["claude-3-opus-20240229"]) */
  provides?: string[];
}

export interface OpenAIProviderConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Vendor/provider name (e.g., "openai-o1") */
  name: string;
  /** Base URL (optional, defaults to api.openai.com) */
  baseUrl?: string;
  /** Model patterns this provider serves (e.g., ["o1-*", "o1"]) */
  provides?: string[];
}

export interface GeminiConfig {
  /** Google AI API key */
  apiKey?: string;
  /** Model patterns this provider serves (e.g., ["gemini-2.5-*"]) */
  provides?: string[];
}

export interface OpenAIResponsesConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Vendor/provider name (e.g., "openai-responses-gpt-image") */
  name: string;
  /** Base URL (optional, defaults to api.openai.com) */
  baseUrl?: string;
  /** Model patterns this provider serves (e.g., ["gpt-image-*"]) */
  provides?: string[];
  /** Allow image editing via /v1/images/edits when images in context (default: true) */
  allowImageEditing?: boolean;
}

export type FormatterType = 'anthropic-xml' | 'native' | 'completions';

export interface MembraneFactoryConfig {
  /**
   * Anthropic API key (used as the default/fallback anthropic adapter)
   * If not provided, falls back to ANTHROPIC_API_KEY env var
   */
  anthropicApiKey?: string;

  /**
   * Multiple Anthropic providers with different API keys
   * Each can have its own key and model patterns (provides)
   * Used when different API keys have access to different models
   * (e.g., one key for modern Claude, another for legacy Claude 3 Opus)
   */
  anthropicProviders?: AnthropicProviderConfig[];

  /**
   * OpenRouter API key
   * If not provided, falls back to OPENROUTER_API_KEY env var
   */
  openrouterApiKey?: string;

  /**
   * OpenAI API key (used as the default/fallback OpenAI adapter)
   * If not provided, falls back to OPENAI_API_KEY env var
   */
  openaiApiKey?: string;

  /**
   * OpenAI base URL (optional, for Azure or custom endpoints)
   */
  openaiBaseUrl?: string;

  /**
   * Multiple OpenAI providers with different API keys
   * Each can have its own key, base URL, and model patterns (provides)
   * Used when different API keys have access to different models or rate limits
   */
  openaiProviders?: OpenAIProviderConfig[];

  /**
   * Single OpenAI-compatible provider (legacy - use openaiCompatibleProviders for multiple)
   * For local inference servers or third-party OpenAI-compatible APIs
   */
  openaiCompatible?: OpenAICompatibleConfig;

  /**
   * Multiple OpenAI-compatible providers
   * Each can have its own base URL and model patterns
   * Used when you need to route different local:* models to different endpoints
   */
  openaiCompatibleProviders?: OpenAICompatibleConfig[];

  /**
   * OpenAI Completions providers (for base models using /v1/completions)
   * Each can have its own base URL and model patterns
   * Uses Human:/Assistant: format, no image support
   */
  openaiCompletionsProviders?: OpenAICompletionsConfig[];

  /**
   * AWS Bedrock configuration for Claude models via AWS
   * Uses AWS credentials for authentication
   */
  bedrock?: BedrockConfig;

  /**
   * Google Gemini configuration
   * Uses Google AI API key for authentication
   */
  gemini?: GeminiConfig;

  /**
   * Multiple OpenAI Responses API providers (for gpt-image-1 and similar models)
   * Uses /v1/responses endpoint instead of /v1/chat/completions
   */
  openaiResponsesProviders?: OpenAIResponsesConfig[];

  /**
   * Bot/assistant name for prefill mode
   * This determines which participant is treated as the assistant
   */
  assistantName: string;

  /**
   * Maximum participants for auto-generated stop sequences in prefill mode.
   * Set to 0 to disable participant-based stop sequences (allows frags/quotes).
   * Default: 10
   */
  maxParticipantsForStop?: number;

  /**
   * Formatter type to use:
   * - 'anthropic-xml': Prefill mode with XML tools (default for Claude)
   * - 'native': Native API tools (for OpenAI-style APIs)
   * - 'completions': For base models using /v1/completions
   * Default: 'anthropic-xml'
   */
  formatter?: FormatterType;

  /**
   * Completions formatter config (when formatter='completions')
   */
  completionsConfig?: {
    eotToken?: string;
    nameFormat?: string;
    messageSeparator?: string;
  };

  /**
   * Maximum retry attempts for LLM calls (default: 0 = no retries).
   * Rate limit (429) errors always retry regardless of this setting.
   */
  retries?: number;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

// ============================================================================
// Model Routing
// ============================================================================

/**
 * Pattern matcher for model names
 * Supports simple glob patterns: * matches any characters
 */
function matchesPattern(modelName: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
    .replace(/\*/g, '.*'); // Convert * to .*
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(modelName);
}

/**
 * Track adapter-to-pattern routing
 */
interface AdapterRouting {
  adapterKey: string;
  patterns: string[];
}

// Module-level storage for routing patterns
// These are set during factory initialization and used by getAdapterForModel
let patternRoutes: AdapterRouting[] = [];

/**
 * Track model pattern to formatter mapping
 * Used to determine which formatter to use for a given model
 */
interface FormatterRouting {
  patterns: string[];
  formatter: FormatterType;
}

// Module-level storage for formatter routing
let formatterRoutes: FormatterRouting[] = [];

/**
 * Get the formatter type for a given model name
 * Returns undefined if no specific formatter is configured (use default)
 */
export function getFormatterForModel(modelName: string): FormatterType | undefined {
  for (const route of formatterRoutes) {
    for (const pattern of route.patterns) {
      if (matchesPattern(modelName, pattern)) {
        logger.debug({ modelName, formatter: route.formatter }, 'Found formatter for model');
        return route.formatter;
      }
    }
  }
  return undefined;
}

/**
 * Determine which adapter supports a given model
 *
 * Routing order:
 * 1. Check explicit pattern routes (from vendor config `provides` lists)
 * 2. Use adapter's built-in `supportsModel()` method as fallback
 * 3. Apply smart defaults based on model name format
 */
function getAdapterForModel(
  modelName: string,
  adapters: Map<string, ProviderAdapter>
): ProviderAdapter | undefined {
  // 1. Check explicit pattern routes first
  for (const route of patternRoutes) {
    for (const pattern of route.patterns) {
      if (matchesPattern(modelName, pattern)) {
        const adapter = adapters.get(route.adapterKey);
        if (adapter) {
          logger.debug({ modelName, adapterKey: route.adapterKey }, 'Routed model via pattern match');
          return adapter;
        }
      }
    }
  }

  // 2. Smart routing based on model name format
  // OpenRouter models have a provider prefix (e.g., "anthropic/claude-3-opus", "openai/o3")
  if (modelName.includes('/')) {
    const openrouterAdapter = adapters.get('openrouter');
    if (openrouterAdapter) {
      logger.debug({ modelName, adapterKey: 'openrouter' }, 'Routed model to OpenRouter (provider/model format)');
      return openrouterAdapter;
    }
  }

  // Bedrock models (anthropic.* prefix or bedrock:* prefix)
  if (modelName.startsWith('anthropic.') || modelName.startsWith('bedrock:')) {
    const bedrockAdapter = adapters.get('bedrock');
    if (bedrockAdapter) {
      logger.debug({ modelName, adapterKey: 'bedrock' }, 'Routed model to Bedrock (anthropic.*/bedrock:* pattern)');
      return bedrockAdapter;
    }
  }

  // Gemini models go to Gemini adapter
  if (modelName.startsWith('gemini-') || modelName.startsWith('gemini_')) {
    const geminiAdapter = adapters.get('gemini');
    if (geminiAdapter) {
      logger.debug({ modelName, adapterKey: 'gemini' }, 'Routed model to Gemini (gemini-* pattern)');
      return geminiAdapter;
    }
  }

  // Direct Claude models go to Anthropic
  if (modelName.startsWith('claude-')) {
    const anthropicAdapter = adapters.get('anthropic');
    if (anthropicAdapter) {
      logger.debug({ modelName, adapterKey: 'anthropic' }, 'Routed model to Anthropic (claude-* pattern)');
      return anthropicAdapter;
    }
  }

  // OpenAI models go to OpenAI
  if (modelName.startsWith('gpt-') || 
      modelName.startsWith('o1') ||   // o1, o1-mini, o1-preview
      modelName.startsWith('o3') ||   // o3, o3-mini, o3-mini-high
      modelName.startsWith('o4') ||   // o4, o4-mini
      modelName.startsWith('gpt5') ||
      modelName.startsWith('chatgpt-')) {
    const openaiAdapter = adapters.get('openai');
    if (openaiAdapter) {
      logger.debug({ modelName, adapterKey: 'openai' }, 'Routed model to OpenAI (gpt/o1/o3/o4 pattern)');
      return openaiAdapter;
    }
  }

  // Local models (local:* prefix) - find matching OpenAI-compatible adapter
  if (modelName.startsWith('local:') || modelName.startsWith('openai-compatible:')) {
    // Already checked in pattern routes above, but try any openai-compatible adapter
    for (const [key, adapter] of adapters) {
      if (key.startsWith('openai-compatible-') || key === 'openai-compatible') {
        logger.debug({ modelName, adapterKey: key }, 'Routed local model to OpenAI-compatible adapter');
        return adapter;
      }
    }
  }

  // 3. Fallback: ask each adapter if it supports the model
  for (const [key, adapter] of adapters) {
    if (adapter.supportsModel(modelName)) {
      logger.debug({ modelName, adapterKey: key }, 'Routed model via adapter.supportsModel()');
      return adapter;
    }
  }

  return undefined;
}

// ============================================================================
// Routing Adapter
// ============================================================================

/**
 * RoutingAdapter wraps multiple adapters and routes requests based on config
 *
 * Deterministic routing: model patterns + mode determine which adapter to use.
 * No fallbacks - if no adapter matches, throws an error.
 */
class RoutingAdapter implements ProviderAdapter {
  readonly name = 'routing';
  private adapters: Map<string, ProviderAdapter>;

  constructor(adapters: Map<string, ProviderAdapter>) {
    this.adapters = adapters;
    if (adapters.size === 0) {
      throw new Error('No adapters available for RoutingAdapter');
    }
  }

  supportsModel(modelId: string): boolean {
    for (const adapter of this.adapters.values()) {
      if (adapter.supportsModel(modelId)) {
        return true;
      }
    }
    return false;
  }

  async complete(request: any, options?: any): Promise<any> {
    const adapter = this.selectAdapter(request);
    return adapter.complete(request, options);
  }

  async stream(request: any, callbacks: any, options?: any): Promise<any> {
    const adapter = this.selectAdapter(request);
    return adapter.stream(request, callbacks, options);
  }

  private selectAdapter(request: any): ProviderAdapter {
    const modelName = request.config?.model ?? request.model;

    const selected = getAdapterForModel(modelName, this.adapters);
    if (!selected) {
      throw new Error(
        `No adapter found for model "${modelName}". ` +
        `Check vendor config patterns and ensure the model is registered.`
      );
    }
    return selected;
  }

  /**
   * Get the underlying adapter for a specific model
   */
  getAdapterForModel(modelName: string): ProviderAdapter | undefined {
    return getAdapterForModel(modelName, this.adapters);
  }

  /**
   * List all available adapters
   */
  getAvailableAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Membrane instance configured for chapterx
 * 
 * @example
 * ```typescript
 * const membrane = createMembrane({
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *   openrouterApiKey: process.env.OPENROUTER_API_KEY,
 *   assistantName: 'Claude',
 * });
 * 
 * // Make a completion
 * const response = await membrane.complete({
 *   messages: [...],
 *   config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 4096 },
 * });
 * ```
 * 
 * @example
 * ```typescript
 * // With multiple OpenAI-compatible endpoints
 * const membrane = createMembrane({
 *   assistantName: 'Bot',
 *   openaiCompatibleProviders: [
 *     { 
 *       name: 'local-ollama',
 *       apiKey: 'not-needed',
 *       baseUrl: 'http://localhost:11434/v1',
 *       provides: ['local:llama3.*', 'local:mistral.*'],
 *     },
 *     {
 *       name: 'remote-k3',
 *       apiKey: 'n/a',
 *       baseUrl: 'https://kimi.ggb-dev-site.com/v1',
 *       provides: ['local:k3'],
 *     },
 *   ],
 * });
 * ```
 */
export function createMembrane(config: MembraneFactoryConfig): Membrane {
  const adapters = new Map<string, ProviderAdapter>();

  // Reset adapter routing patterns (formatterRoutes is managed by createMembraneFromVendorConfigs)
  patternRoutes = [];
  
  // Create Anthropic adapters
  // When anthropicProviders is set, it takes precedence over anthropicApiKey
  // (anthropicProviders already contains the full list including the "default" one)
  if (config.anthropicProviders && config.anthropicProviders.length > 0) {
    // Multiple providers mode: create an adapter for each
    let defaultSet = false;
    for (const providerConfig of config.anthropicProviders) {
      // Vendor named 'anthropic' always gets the default key; otherwise first provider does
      const isDefault = providerConfig.name === 'anthropic' || !defaultSet;
      const adapterKey = isDefault ? 'anthropic' : `anthropic-${providerConfig.name}`;
      if (isDefault) defaultSet = true;

      try {
        const anthropicAdapter = new AnthropicAdapter({
          apiKey: providerConfig.apiKey,
        });
        adapters.set(adapterKey, anthropicAdapter);

        // Register pattern routes so getAdapterForModel can find the right one
        if (providerConfig.provides && providerConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: providerConfig.provides,
          });
        }

        logger.info({
          name: providerConfig.name,
          adapterKey,
          isDefault,
          patterns: providerConfig.provides ?? [],
        }, 'Membrane: Anthropic adapter initialized');
      } catch (error) {
        logger.error({ error, name: providerConfig.name }, 'Failed to create Anthropic adapter');
      }
    }
  } else {
    // Legacy single key mode
    const anthropicKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      try {
        const anthropicAdapter = new AnthropicAdapter({
          apiKey: anthropicKey,
        });
        adapters.set('anthropic', anthropicAdapter);
        logger.info('Membrane: Anthropic adapter initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to create Anthropic adapter');
      }
    } else {
      logger.debug('Membrane: No Anthropic API key provided, adapter not created');
    }
  }
  
  // Create OpenRouter adapter if API key is available
  const openrouterKey = config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    try {
      const openrouterAdapter = new OpenRouterAdapter({
        apiKey: openrouterKey,
        httpReferer: 'https://chapterx.local',
        xTitle: 'ChapterX',
      });
      adapters.set('openrouter', openrouterAdapter);
      logger.info('Membrane: OpenRouter adapter initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to create OpenRouter adapter');
    }
  } else {
    logger.debug('Membrane: No OpenRouter API key provided, adapter not created');
  }
  
  // Create OpenAI adapters
  // When openaiProviders is set, it takes precedence over openaiApiKey
  if (config.openaiProviders && config.openaiProviders.length > 0) {
    // Multiple providers mode: create an adapter for each
    let defaultSet = false;
    for (const providerConfig of config.openaiProviders) {
      const isDefault = providerConfig.name === 'openai' || !defaultSet;
      const adapterKey = isDefault ? 'openai' : `openai-${providerConfig.name}`;
      if (isDefault) defaultSet = true;

      try {
        const openaiAdapter = new OpenAIAdapter({
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseUrl,
        });
        adapters.set(adapterKey, openaiAdapter);

        // Register pattern routes
        if (providerConfig.provides && providerConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: providerConfig.provides,
          });
        }

        logger.info({
          name: providerConfig.name,
          adapterKey,
          isDefault,
          patterns: providerConfig.provides ?? [],
        }, 'Membrane: OpenAI adapter initialized');
      } catch (error) {
        logger.error({ error, name: providerConfig.name }, 'Failed to create OpenAI adapter');
      }
    }
  } else {
    // Legacy single key mode
    const openaiKey = config.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const openaiAdapter = new OpenAIAdapter({
          apiKey: openaiKey,
          baseURL: config.openaiBaseUrl,
        });
        adapters.set('openai', openaiAdapter);
        logger.info('Membrane: OpenAI adapter initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to create OpenAI adapter');
      }
    } else {
      logger.debug('Membrane: No OpenAI API key provided, adapter not created');
    }
  }

  // Create Bedrock adapter if valid AWS credentials are available
  // Check for real credentials (not placeholders) from config or environment
  const bedrockAccessKey = config.bedrock?.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
  const bedrockSecretKey = config.bedrock?.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
  const hasValidBedrockCreds = bedrockAccessKey && 
    bedrockSecretKey && 
    !bedrockAccessKey.includes('YOUR_') &&
    !bedrockSecretKey.includes('YOUR_');
  
  if (hasValidBedrockCreds) {
    try {
      const bedrockAdapter = new BedrockAdapter({
        accessKeyId: bedrockAccessKey,
        secretAccessKey: bedrockSecretKey,
        region: config.bedrock?.region,
        sessionToken: config.bedrock?.sessionToken,
      });
      adapters.set('bedrock', bedrockAdapter);
      
      // Register routing patterns if provided
      if (config.bedrock?.provides && config.bedrock.provides.length > 0) {
        patternRoutes.push({
          adapterKey: 'bedrock',
          patterns: config.bedrock.provides,
        });
      }
      
      logger.info({ 
        region: config.bedrock?.region ?? process.env.AWS_REGION ?? 'us-west-2',
        patterns: config.bedrock?.provides ?? [],
      }, 'Membrane: Bedrock adapter initialized');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to create Bedrock adapter');
    }
  } else {
    logger.debug('Membrane: No valid Bedrock credentials provided (or placeholders detected), adapter not created');
  }

  // Create Gemini adapter if API key is available
  const geminiKey = config.gemini?.apiKey ?? process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const geminiAdapter = new GeminiAdapter({
        apiKey: geminiKey,
      });
      adapters.set('gemini', geminiAdapter);

      // Register routing patterns if provided
      if (config.gemini?.provides && config.gemini.provides.length > 0) {
        patternRoutes.push({
          adapterKey: 'gemini',
          patterns: config.gemini.provides,
        });
      }

      logger.info({
        patterns: config.gemini?.provides ?? [],
      }, 'Membrane: Gemini adapter initialized');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to create Gemini adapter');
    }
  } else {
    logger.debug('Membrane: No Google API key provided, Gemini adapter not created');
  }

  // Create OpenAI Responses adapters (for gpt-image-1 and similar)
  if (config.openaiResponsesProviders && config.openaiResponsesProviders.length > 0) {
    for (const providerConfig of config.openaiResponsesProviders) {
      const adapterKey = `openai-responses-${providerConfig.name}`;

      try {
        const responsesAdapter = new OpenAIResponsesAdapter({
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseUrl,
          allowImageEditing: providerConfig.allowImageEditing,
        });
        adapters.set(adapterKey, responsesAdapter);

        // Register pattern routes
        if (providerConfig.provides && providerConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: providerConfig.provides,
          });
        }

        logger.info({
          name: providerConfig.name,
          adapterKey,
          patterns: providerConfig.provides ?? [],
        }, 'Membrane: OpenAI Responses adapter initialized');
      } catch (error) {
        logger.error({ error, name: providerConfig.name }, 'Failed to create OpenAI Responses adapter');
      }
    }
  }

  // Create OpenAI-compatible adapters
  // Support both legacy single config and new multiple configs
  const compatibleConfigs: OpenAICompatibleConfig[] = [];
  
  // Legacy single config
  if (config.openaiCompatible) {
    compatibleConfigs.push(config.openaiCompatible);
  }
  
  // Multiple configs
  if (config.openaiCompatibleProviders) {
    compatibleConfigs.push(...config.openaiCompatibleProviders);
  }
  
  // Create adapters for each OpenAI-compatible config
  let compatIndex = 0;
  for (const compatConfig of compatibleConfigs) {
    const adapterName = compatConfig.name ?? `openai-compatible-${compatIndex}`;
    // Use 'openai-compatible' as key for first/only adapter (backward compatibility)
    const adapterKey = compatIndex === 0 && !config.openaiCompatibleProviders 
      ? 'openai-compatible' 
      : `openai-compatible-${adapterName}`;
    
    try {
      const compatibleAdapter = new OpenAICompatibleAdapter({
        apiKey: compatConfig.apiKey,
        baseURL: compatConfig.baseUrl,
        providerName: adapterName,
      });
      adapters.set(adapterKey, compatibleAdapter);
      
      // Register routing patterns
      if (compatConfig.provides && compatConfig.provides.length > 0) {
        patternRoutes.push({
          adapterKey,
          patterns: compatConfig.provides,
        });
      }
      
      logger.info({ 
        name: adapterName,
        adapterKey,
        baseUrl: compatConfig.baseUrl,
        patterns: compatConfig.provides ?? [],
      }, 'Membrane: OpenAI-compatible adapter initialized');
    } catch (error) {
      logger.error({ error, name: adapterName }, 'Failed to create OpenAI-compatible adapter');
    }
    compatIndex++;
  }

  // Create OpenAI Completions adapters (for base models using /v1/completions)
  if (config.openaiCompletionsProviders) {
    let completionsIndex = 0;
    for (const completionsConfig of config.openaiCompletionsProviders) {
      const adapterName = completionsConfig.name ?? `openai-completions-${completionsIndex}`;
      const adapterKey = `openai-completions-${adapterName}`;

      try {
        const completionsAdapter = new OpenAICompletionsAdapter({
          apiKey: completionsConfig.apiKey,
          baseURL: completionsConfig.baseUrl,
          assistantName: config.assistantName,
          extraStopSequences: completionsConfig.defaultStopSequences,
          warnOnImageStrip: completionsConfig.warnOnImageStrip,
          eotToken: completionsConfig.eotToken,
        });
        adapters.set(adapterKey, completionsAdapter);

        // Register routing patterns
        if (completionsConfig.provides && completionsConfig.provides.length > 0) {
          patternRoutes.push({
            adapterKey,
            patterns: completionsConfig.provides,
          });
        }

        logger.info({
          name: adapterName,
          adapterKey,
          baseUrl: completionsConfig.baseUrl,
          patterns: completionsConfig.provides ?? [],
        }, 'Membrane: OpenAI Completions adapter initialized (base model mode)');
      } catch (error) {
        logger.error({ error, name: adapterName }, 'Failed to create OpenAI Completions adapter');
      }
      completionsIndex++;
    }
  }

  // Require at least one adapter
  if (adapters.size === 0) {
    throw new Error(
      'Membrane: No provider adapters could be created. ' +
      'Please provide at least one of: anthropicApiKey, openrouterApiKey, openaiApiKey, bedrock, openaiCompatible, openaiCompatibleProviders, openaiCompletionsProviders, openaiResponsesProviders'
    );
  }
  
  // Create routing adapter
  const routingAdapter = new RoutingAdapter(adapters);
  
  // Create formatter based on config
  const formatter = createFormatter(config);

  // Build membrane config
  // Note: Cast hooks to any because our local type definitions may not exactly match
  // membrane's updated types. The implementation is correct, just type mismatch.
  const membraneConfig: MembraneConfig = {
    assistantParticipant: config.assistantName,
    maxParticipantsForStop: config.maxParticipantsForStop,
    formatter,
    hooks: createTracingHooks() as any,
    debug: config.debug,
    retry: config.retries != null ? { maxRetries: config.retries } : undefined,
  };

  // Create and return Membrane instance
  const membrane = new Membrane(routingAdapter, membraneConfig);

  logger.info({
    adapters: routingAdapter.getAvailableAdapters(),
    assistantName: config.assistantName,
    formatter: formatter.name,
    patternRoutes: patternRoutes.map(r => ({ key: r.adapterKey, patterns: r.patterns })),
  }, 'Membrane instance created');

  return membrane;
}

/**
 * Create the appropriate formatter based on config
 */
function createFormatter(config: MembraneFactoryConfig): PrefillFormatter {
  const formatterType = config.formatter ?? 'anthropic-xml';

  switch (formatterType) {
    case 'native':
      return new NativeFormatter();

    case 'completions':
      return new CompletionsFormatter({
        eotToken: config.completionsConfig?.eotToken,
        nameFormat: config.completionsConfig?.nameFormat,
        messageSeparator: config.completionsConfig?.messageSeparator,
        maxParticipantsForStop: config.maxParticipantsForStop,
      });

    case 'anthropic-xml':
    default:
      return new AnthropicXmlFormatter({
        maxParticipantsForStop: config.maxParticipantsForStop,
      });
  }
}

// ============================================================================
// Convenience Exports
// ============================================================================

export { RoutingAdapter };

/**
 * Create membrane from vendor configs (for integration with main.ts)
 *
 * Adapter type is determined by vendor name prefix:
 * - 'anthropic-*' → Anthropic adapter
 * - 'openrouter-*' → OpenRouter adapter
 * - 'openairesponses-*' → OpenAI Responses adapter (/v1/responses, for gpt-image-1)
 * - 'openaicompletion-*' → OpenAI Completions adapter (base models, /v1/completions)
 * - 'openai-*' → OpenAI Compatible adapter (chat, /v1/chat/completions)
 *
 * Each vendor gets exactly one adapter. The vendor's `provides` patterns
 * determine which models it serves.
 */
export interface VendorConfigInput {
  config: Record<string, string>;
  provides?: string[];
  formatter?: FormatterType;
  completions_config?: {
    eot_token?: string;
    name_format?: string;
    message_separator?: string;
  };
}

export function createMembraneFromVendorConfigs(
  vendorConfigs: Record<string, VendorConfigInput>,
  assistantName: string,
  options?: {
    formatter?: FormatterType;
    completionsConfig?: MembraneFactoryConfig['completionsConfig'];
    maxParticipantsForStop?: number;
    retries?: number;
  }
): Membrane {
  // Reset formatter routes before processing vendors (adapter routes are reset in createMembrane)
  formatterRoutes = [];

  const anthropicProviders: AnthropicProviderConfig[] = [];
  const openaiProviders: OpenAIProviderConfig[] = [];
  let openrouterApiKey: string | undefined;
  let bedrockConfig: BedrockConfig | undefined;
  let geminiConfig: GeminiConfig | undefined;
  const openaiCompatibleProviders: OpenAICompatibleConfig[] = [];
  const openaiCompletionsProviders: OpenAICompletionsConfig[] = [];
  const openaiResponsesProviders: OpenAIResponsesConfig[] = [];

  // Track formatter from vendors (first one wins, can be overridden by options)
  let detectedFormatter: FormatterType | undefined;
  let detectedCompletionsConfig: MembraneFactoryConfig['completionsConfig'] | undefined;

  for (const [vendorName, vendorConfig] of Object.entries(vendorConfigs)) {
    const config = vendorConfig.config;
    const apiKey = config?.openai_api_key ?? config?.open_api_key ?? config?.api_key ?? 'not-needed';
    const baseUrl = config?.api_base ?? config?.openai_compatible_base_url ?? config?.openai_completions_base_url;

    // Capture formatter from vendor config (first one with formatter setting wins for default)
    if (!detectedFormatter && vendorConfig.formatter) {
      detectedFormatter = vendorConfig.formatter;
      logger.debug({ vendorName, formatter: detectedFormatter }, 'Using formatter from vendor config as default');
    }

    // Register per-model formatter routing if vendor has both formatter and provides patterns
    if (vendorConfig.formatter && vendorConfig.provides && vendorConfig.provides.length > 0) {
      formatterRoutes.push({
        patterns: vendorConfig.provides,
        formatter: vendorConfig.formatter,
      });
      logger.debug({ vendorName, formatter: vendorConfig.formatter, patterns: vendorConfig.provides }, 'Registered formatter routes for vendor');
    }

    // Capture completions config from vendor
    if (!detectedCompletionsConfig && vendorConfig.completions_config) {
      detectedCompletionsConfig = {
        eotToken: vendorConfig.completions_config.eot_token,
        nameFormat: vendorConfig.completions_config.name_format,
        messageSeparator: vendorConfig.completions_config.message_separator,
      };
      logger.debug({ vendorName, completionsConfig: detectedCompletionsConfig }, 'Using completions config from vendor');
    }

    // Determine adapter type from vendor name prefix
    if (vendorName.startsWith('anthropic')) {
      // Anthropic adapter - uses native Anthropic API (NOT OpenAI-compatible)
      // Collect ALL anthropic vendors for multi-key support
      if (config?.anthropic_api_key) {
        anthropicProviders.push({
          apiKey: config.anthropic_api_key,
          name: vendorName,
          provides: vendorConfig.provides,
        });
      }

      // Auto-detect anthropic-xml formatter for Anthropic vendors
      if (!detectedFormatter) {
        detectedFormatter = 'anthropic-xml';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found Anthropic vendor (uses native API)');

    } else if (vendorName.startsWith('bedrock')) {
      // Bedrock adapter - uses AWS Bedrock for Claude models
      // Support multiple naming conventions for AWS credentials
      if (!bedrockConfig) {
        bedrockConfig = {
          accessKeyId: config?.aws_access_key_id ?? config?.aws_access_key,
          secretAccessKey: config?.aws_secret_access_key ?? config?.aws_secret_key,
          region: config?.aws_region ?? config?.region,
          sessionToken: config?.aws_session_token ?? config?.session_token,
          provides: vendorConfig.provides,
        };
      }

      // Auto-detect anthropic-xml formatter for Bedrock vendors (same as Anthropic)
      if (!detectedFormatter) {
        detectedFormatter = 'anthropic-xml';
      }

      logger.debug({ vendorName, region: bedrockConfig.region, provides: vendorConfig.provides }, 'Found Bedrock vendor (uses AWS API)');

    } else if (vendorName.startsWith('gemini')) {
      // Gemini adapter - uses native Google AI API
      if (!geminiConfig) {
        const googleKey = config?.google_api_key ?? config?.api_key;
        if (googleKey) {
          geminiConfig = {
            apiKey: googleKey,
            provides: vendorConfig.provides,
          };
        }
      }

      // Auto-detect native formatter for Gemini vendors
      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found Gemini vendor (uses Google AI API)');

    } else if (vendorName.startsWith('openrouter')) {
      // OpenRouter adapter - uses OpenRouter's API (similar to OpenAI but with extras)
      // The native OpenRouterAdapter is created when openrouterApiKey is provided
      // Routing is handled by getAdapterForModel() based on 'provider/model' pattern
      if (config?.openrouter_api_key && !openrouterApiKey) {
        openrouterApiKey = config.openrouter_api_key;
      }

      // Auto-detect native formatter for OpenRouter vendors
      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found OpenRouter vendor (uses native API)');

    } else if (vendorName.startsWith('openairesponses')) {
      // OpenAI Images adapter (for gpt-image-1 and similar image generation models)
      const openaiKey = config?.openai_api_key ?? config?.api_key;
      if (openaiKey) {
        // allow_image_editing defaults to true — set to "false" in vendor config to disable
        const allowEditing = config?.allow_image_editing !== 'false';
        openaiResponsesProviders.push({
          apiKey: openaiKey,
          name: vendorName,
          baseUrl: baseUrl,
          provides: vendorConfig.provides,
          allowImageEditing: allowEditing,
        });
      }

      // Auto-detect native formatter for image vendors
      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found OpenAI Images vendor (/v1/images API)');

    } else if (vendorName.startsWith('openaicompletion')) {
      // OpenAI Completions adapter (base models using /v1/completions)
      if (baseUrl) {
        const eotToken = config.eot_token !== undefined ? config.eot_token : vendorConfig.completions_config?.eot_token;
        openaiCompletionsProviders.push({
          apiKey,
          baseUrl,
          name: vendorName,
          provides: vendorConfig.provides,
          eotToken,
        });

        // Auto-detect completions formatter for completions vendors
        if (!detectedFormatter) {
          detectedFormatter = 'completions';
        }

        logger.debug({ vendorName, baseUrl, eotToken, provides: vendorConfig.provides }, 'Found OpenAI Completions vendor (base model)');
      }

    } else if (vendorName.startsWith('openai')) {
      // Determine if this is official OpenAI API or a compatible endpoint
      const isOfficialOpenAI = !baseUrl || baseUrl.includes('api.openai.com');

      if (isOfficialOpenAI) {
        // Official OpenAI API — collect ALL vendors for multi-key support
        const openaiKey = config?.openai_api_key ?? config?.api_key;
        if (openaiKey) {
          openaiProviders.push({
            apiKey: openaiKey,
            name: vendorName,
            baseUrl: baseUrl, // undefined or explicit api.openai.com
            provides: vendorConfig.provides,
          });
        }
        logger.debug({ vendorName, provides: vendorConfig.provides }, 'Found OpenAI vendor (official API)');
      } else {
        // Custom base URL - use OpenAI Compatible adapter
        openaiCompatibleProviders.push({
          apiKey,
          baseUrl,
          name: vendorName,
          provides: vendorConfig.provides,
        });
        logger.debug({ vendorName, baseUrl, provides: vendorConfig.provides }, 'Found OpenAI Compatible vendor');
      }

      // Auto-detect native formatter for OpenAI vendors
      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

    } else if (config?.openai_compatible_base_url) {
      // Vendor has OpenAI-compatible config but non-standard prefix
      // Treat as OpenAI-compatible chat provider
      openaiCompatibleProviders.push({
        apiKey: config.openai_compatible_api_key ?? apiKey,
        baseUrl: config.openai_compatible_base_url,
        name: vendorName,
        provides: vendorConfig.provides,
      });

      if (!detectedFormatter) {
        detectedFormatter = 'native';
      }

      logger.debug({ vendorName, baseUrl: config.openai_compatible_base_url, provides: vendorConfig.provides }, 'Found OpenAI Compatible vendor (non-standard prefix)');

    } else {
      logger.warn({ vendorName }, 'Unknown vendor prefix and no openai_compatible_base_url, skipping');
    }
  }

  // Use explicit options, then vendor-detected settings, then defaults
  const finalFormatter = options?.formatter ?? detectedFormatter;
  const finalCompletionsConfig = options?.completionsConfig ?? detectedCompletionsConfig;

  return createMembrane({
    // When multiple anthropic vendors exist, pass them all as providers for pattern routing
    // When only one exists, use the legacy single-key path for backward compatibility
    anthropicApiKey: anthropicProviders.length === 1 ? anthropicProviders[0]!.apiKey : undefined,
    anthropicProviders: anthropicProviders.length > 1 ? anthropicProviders : undefined,
    openrouterApiKey,
    openaiApiKey: openaiProviders.length === 1 ? openaiProviders[0]!.apiKey : undefined,
    openaiBaseUrl: openaiProviders.length === 1 ? openaiProviders[0]!.baseUrl : undefined,
    openaiProviders: openaiProviders.length > 1 ? openaiProviders : undefined,
    bedrock: bedrockConfig,
    gemini: geminiConfig,
    openaiCompatibleProviders: openaiCompatibleProviders.length > 0 ? openaiCompatibleProviders : undefined,
    openaiCompletionsProviders: openaiCompletionsProviders.length > 0 ? openaiCompletionsProviders : undefined,
    openaiResponsesProviders: openaiResponsesProviders.length > 0 ? openaiResponsesProviders : undefined,
    assistantName,
    formatter: finalFormatter,
    completionsConfig: finalCompletionsConfig,
    maxParticipantsForStop: options?.maxParticipantsForStop,
    retries: options?.retries,
  });
}

