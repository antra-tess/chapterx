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
} from '@animalabs/membrane';
import type { ProviderAdapter, MembraneConfig } from '@animalabs/membrane';
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
  /** Default stop sequences (default: ['\n\nHuman:', '\nHuman:']) */
  defaultStopSequences?: string[];
  /** Warn when images are stripped from context (default: true) */
  warnOnImageStrip?: boolean;
}

export interface MembraneFactoryConfig {
  /**
   * Anthropic API key
   * If not provided, falls back to ANTHROPIC_API_KEY env var
   */
  anthropicApiKey?: string;
  
  /**
   * OpenRouter API key
   * If not provided, falls back to OPENROUTER_API_KEY env var
   */
  openrouterApiKey?: string;
  
  /**
   * OpenAI API key
   * If not provided, falls back to OPENAI_API_KEY env var
   */
  openaiApiKey?: string;
  
  /**
   * OpenAI base URL (optional, for Azure or custom endpoints)
   */
  openaiBaseUrl?: string;
  
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
 * Track which OpenAI-compatible adapters serve which model patterns
 */
interface OpenAICompatibleRouting {
  adapterKey: string;
  patterns: string[];
}

// Module-level storage for OpenAI-compatible routing patterns
// This is set during factory initialization and used by getAdapterForModel
let openaiCompatibleRoutes: OpenAICompatibleRouting[] = [];

/**
 * Determine which adapter supports a given model
 * 
 * Routing rules:
 * - claude-* → Anthropic (direct API is preferred for Claude)
 * - gpt-*, o1*, o3*, o4* → OpenAI (direct API, includes bare o1/o3/o4)
 * - provider/model → OpenRouter (any model with provider prefix, e.g. anthropic/claude-3-opus)
 * - local:* or openai-compatible:* → Check pattern matches against registered OpenAI-compatible providers
 * - Everything else → Anthropic as fallback, then OpenRouter, then OpenAI
 */
function getAdapterForModel(modelName: string, adapters: Map<string, ProviderAdapter>): ProviderAdapter | undefined {
  // Local/OpenAI-compatible models: check patterns to find the right adapter
  if (modelName.startsWith('local:') || modelName.startsWith('openai-compatible:')) {
    // Check each registered OpenAI-compatible provider's patterns
    for (const route of openaiCompatibleRoutes) {
      for (const pattern of route.patterns) {
        if (matchesPattern(modelName, pattern)) {
          const adapter = adapters.get(route.adapterKey);
          if (adapter) {
            logger.debug({ modelName, pattern, adapterKey: route.adapterKey }, 'Routed local model via pattern match');
            return adapter;
          }
        }
      }
    }
    
    // Fallback: try the default 'openai-compatible' adapter or first registered one
    const defaultAdapter = adapters.get('openai-compatible');
    if (defaultAdapter) {
      return defaultAdapter;
    }
    
    // Try any openai-compatible-* adapter
    for (const [key, adapter] of adapters) {
      if (key.startsWith('openai-compatible-')) {
        logger.debug({ modelName, adapterKey: key }, 'Routed local model to first available OpenAI-compatible adapter');
        return adapter;
      }
    }
    
    logger.warn({ modelName }, 'No OpenAI-compatible adapter found for local model');
    return undefined;
  }
  
  // OpenRouter models have a provider prefix (e.g., "anthropic/claude-3-opus")
  if (modelName.includes('/')) {
    return adapters.get('openrouter');
  }
  
  // Direct Claude models go to Anthropic
  if (modelName.startsWith('claude-')) {
    return adapters.get('anthropic');
  }
  
  // OpenAI models go to OpenAI
  // Note: o1/o3/o4 patterns match both bare names (o3) and variants (o3-mini)
  if (modelName.startsWith('gpt-') || 
      modelName.startsWith('o1') ||   // o1, o1-mini, o1-preview
      modelName.startsWith('o3') ||   // o3, o3-mini, o3-mini-high
      modelName.startsWith('o4') ||   // o4, o4-mini
      modelName.startsWith('gpt5') ||
      modelName.startsWith('chatgpt-')) {
    return adapters.get('openai');
  }
  
  // Fallback chain: Anthropic → OpenRouter → OpenAI → any OpenAI-compatible
  if (adapters.has('anthropic')) return adapters.get('anthropic');
  if (adapters.has('openrouter')) return adapters.get('openrouter');
  if (adapters.has('openai')) return adapters.get('openai');
  
  // Last resort: any available adapter
  for (const adapter of adapters.values()) {
    return adapter;
  }
  
  return undefined;
}

// ============================================================================
// Routing Adapter
// ============================================================================

/**
 * RoutingAdapter wraps multiple adapters and routes requests based on model name
 * 
 * This allows Membrane to work with multiple providers through a single adapter,
 * automatically selecting the right one based on the model being requested.
 */
class RoutingAdapter implements ProviderAdapter {
  readonly name = 'routing';
  private adapters: Map<string, ProviderAdapter>;
  private defaultAdapter: ProviderAdapter;
  
  constructor(adapters: Map<string, ProviderAdapter>) {
    this.adapters = adapters;
    
    // Pick a default (prefer Anthropic)
    const defaultAdapter = adapters.get('anthropic') ?? adapters.get('openrouter');
    if (!defaultAdapter) {
      throw new Error('No adapters available for RoutingAdapter');
    }
    this.defaultAdapter = defaultAdapter;
  }
  
  supportsModel(modelId: string): boolean {
    // We support any model that any of our adapters support
    for (const adapter of this.adapters.values()) {
      if (adapter.supportsModel(modelId)) {
        return true;
      }
    }
    return false;
  }
  
  async complete(request: any, options?: any): Promise<any> {
    const adapter = this.selectAdapter(request.model);
    return adapter.complete(request, options);
  }
  
  async stream(request: any, callbacks: any, options?: any): Promise<any> {
    const adapter = this.selectAdapter(request.model);
    return adapter.stream(request, callbacks, options);
  }
  
  private selectAdapter(modelName: string): ProviderAdapter {
    const selected = getAdapterForModel(modelName, this.adapters);
    if (!selected) {
      logger.warn({ model: modelName }, 'No adapter found for model, using default');
      return this.defaultAdapter;
    }
    return selected;
  }
  
  /**
   * Get the underlying adapter for a specific model
   * Useful for debugging/inspection
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
  
  // Reset routing patterns
  openaiCompatibleRoutes = [];
  
  // Create Anthropic adapter if API key is available
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
  
  // Create OpenAI adapter if API key is available
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
        openaiCompatibleRoutes.push({
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
          defaultStopSequences: completionsConfig.defaultStopSequences,
          warnOnImageStrip: completionsConfig.warnOnImageStrip,
        });
        adapters.set(adapterKey, completionsAdapter);

        // Register routing patterns
        if (completionsConfig.provides && completionsConfig.provides.length > 0) {
          openaiCompatibleRoutes.push({
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
      'Please provide at least one of: anthropicApiKey, openrouterApiKey, openaiApiKey, openaiCompatible, openaiCompatibleProviders, openaiCompletionsProviders'
    );
  }
  
  // Create routing adapter
  const routingAdapter = new RoutingAdapter(adapters);
  
  // Build membrane config
  // Note: Cast hooks to any because our local type definitions may not exactly match
  // membrane's updated types. The implementation is correct, just type mismatch.
  const membraneConfig: MembraneConfig = {
    assistantParticipant: config.assistantName,
    maxParticipantsForStop: config.maxParticipantsForStop,
    hooks: createTracingHooks() as any,
    debug: config.debug,
  };
  
  // Create and return Membrane instance
  const membrane = new Membrane(routingAdapter, membraneConfig);
  
  logger.info({
    adapters: routingAdapter.getAvailableAdapters(),
    assistantName: config.assistantName,
    openaiCompatibleRoutes: openaiCompatibleRoutes.map(r => ({ key: r.adapterKey, patterns: r.patterns })),
  }, 'Membrane instance created');
  
  return membrane;
}

// ============================================================================
// Convenience Exports
// ============================================================================

export { RoutingAdapter };

/**
 * Create membrane from vendor configs (for integration with main.ts)
 *
 * This extracts API keys from the vendor config structure used by chapterx.
 *
 * Supported vendor config keys:
 * - anthropic_api_key → Anthropic adapter
 * - openrouter_api_key → OpenRouter adapter
 * - openai_api_key + openai_base_url → OpenAI adapter
 * - openai_compatible_api_key + openai_compatible_base_url → OpenAI-compatible adapter
 *   (multiple vendors can define this - each becomes a separate adapter with pattern routing)
 * - openai_completions_base_url → OpenAI Completions adapter (base model mode)
 *   Uses /v1/completions endpoint with Human:/Assistant: format
 */
export function createMembraneFromVendorConfigs(
  vendorConfigs: Record<string, { config: Record<string, string>; provides?: string[] }>,
  assistantName: string
): Membrane {
  // Extract API keys from vendor configs
  let anthropicApiKey: string | undefined;
  let openrouterApiKey: string | undefined;
  let openaiApiKey: string | undefined;
  let openaiBaseUrl: string | undefined;
  const openaiCompatibleProviders: OpenAICompatibleConfig[] = [];
  const openaiCompletionsProviders: OpenAICompletionsConfig[] = [];

  for (const [vendorName, vendorConfig] of Object.entries(vendorConfigs)) {
    const config = vendorConfig.config;

    if (config?.anthropic_api_key && !anthropicApiKey) {
      anthropicApiKey = config.anthropic_api_key;
    }

    if (config?.openrouter_api_key && !openrouterApiKey) {
      openrouterApiKey = config.openrouter_api_key;
    }

    if (config?.openai_api_key && !openaiApiKey) {
      openaiApiKey = config.openai_api_key;
      openaiBaseUrl = config.openai_base_url;
    }

    // OpenAI-compatible (for local inference or third-party compatible APIs)
    // Now supports MULTIPLE vendors - each becomes a separate adapter
    if (config?.openai_compatible_base_url) {
      openaiCompatibleProviders.push({
        apiKey: config.openai_compatible_api_key ?? 'not-needed',
        baseUrl: config.openai_compatible_base_url,
        name: vendorName,
        provides: vendorConfig.provides,
      });
      logger.debug({
        vendorName,
        baseUrl: config.openai_compatible_base_url,
        provides: vendorConfig.provides,
      }, 'Found OpenAI-compatible vendor config');
    }

    // OpenAI Completions (for base models using /v1/completions)
    // Uses Human:/Assistant: format, no image support
    if (config?.openai_completions_base_url) {
      openaiCompletionsProviders.push({
        apiKey: config.openai_completions_api_key ?? 'not-needed',
        baseUrl: config.openai_completions_base_url,
        name: vendorName,
        provides: vendorConfig.provides,
      });
      logger.debug({
        vendorName,
        baseUrl: config.openai_completions_base_url,
        provides: vendorConfig.provides,
      }, 'Found OpenAI Completions vendor config (base model mode)');
    }
  }
  
  return createMembrane({
    anthropicApiKey,
    openrouterApiKey,
    openaiApiKey,
    openaiBaseUrl,
    openaiCompatibleProviders: openaiCompatibleProviders.length > 0 ? openaiCompatibleProviders : undefined,
    openaiCompletionsProviders: openaiCompletionsProviders.length > 0 ? openaiCompletionsProviders : undefined,
    assistantName,
  });
}

