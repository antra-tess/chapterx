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
} from 'membrane';
import type { ProviderAdapter, MembraneConfig } from 'membrane';
import { createTracingHooks } from './hooks.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Configuration Types
// ============================================================================

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
   * OpenAI-compatible provider configuration
   * For local inference servers or third-party OpenAI-compatible APIs
   */
  openaiCompatible?: {
    /** API key for the compatible endpoint */
    apiKey: string;
    /** Base URL (required, e.g., "http://localhost:8080/v1") */
    baseUrl: string;
    /** Provider name for logging (default: 'openai-compatible') */
    name?: string;
  };
  
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
 * Determine which adapter supports a given model
 * 
 * Routing rules:
 * - claude-* → Anthropic (direct API is preferred for Claude)
 * - gpt-*, o1-*, o3-*, o4-* → OpenAI (direct API)
 * - provider/model → OpenRouter (any model with provider prefix, e.g. anthropic/claude-3-opus)
 * - local:* → OpenAI-compatible (local inference)
 * - Everything else → Anthropic as fallback, then OpenRouter, then OpenAI
 */
function getAdapterForModel(modelName: string, adapters: Map<string, ProviderAdapter>): ProviderAdapter | undefined {
  // Local models go to OpenAI-compatible
  if (modelName.startsWith('local:') || modelName.startsWith('openai-compatible:')) {
    return adapters.get('openai-compatible');
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
  if (modelName.startsWith('gpt-') || 
      modelName.startsWith('o1-') || 
      modelName.startsWith('o3-') || 
      modelName.startsWith('o4-') ||
      modelName.startsWith('gpt5') ||
      modelName.startsWith('chatgpt-')) {
    return adapters.get('openai');
  }
  
  // Fallback chain: Anthropic → OpenRouter → OpenAI → OpenAI-compatible
  return adapters.get('anthropic') 
    ?? adapters.get('openrouter') 
    ?? adapters.get('openai')
    ?? adapters.get('openai-compatible');
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
 */
export function createMembrane(config: MembraneFactoryConfig): Membrane {
  const adapters = new Map<string, ProviderAdapter>();
  
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
  
  // Create OpenAI-compatible adapter if configured
  if (config.openaiCompatible) {
    try {
      const compatibleAdapter = new OpenAICompatibleAdapter({
        apiKey: config.openaiCompatible.apiKey,
        baseURL: config.openaiCompatible.baseUrl,
        providerName: config.openaiCompatible.name,
      });
      adapters.set('openai-compatible', compatibleAdapter);
      logger.info({ 
        name: config.openaiCompatible.name ?? 'openai-compatible',
        baseUrl: config.openaiCompatible.baseUrl,
      }, 'Membrane: OpenAI-compatible adapter initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to create OpenAI-compatible adapter');
    }
  }
  
  // Require at least one adapter
  if (adapters.size === 0) {
    throw new Error(
      'Membrane: No provider adapters could be created. ' +
      'Please provide at least one of: anthropicApiKey, openrouterApiKey, openaiApiKey, openaiCompatible'
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
 */
export function createMembraneFromVendorConfigs(
  vendorConfigs: Record<string, { config: Record<string, string> }>,
  assistantName: string
): Membrane {
  // Extract API keys from vendor configs
  let anthropicApiKey: string | undefined;
  let openrouterApiKey: string | undefined;
  let openaiApiKey: string | undefined;
  let openaiBaseUrl: string | undefined;
  let openaiCompatible: MembraneFactoryConfig['openaiCompatible'] | undefined;
  
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
    if (config?.openai_compatible_base_url && !openaiCompatible) {
      openaiCompatible = {
        apiKey: config.openai_compatible_api_key ?? 'not-needed',
        baseUrl: config.openai_compatible_base_url,
        name: vendorName,
      };
    }
  }
  
  return createMembrane({
    anthropicApiKey,
    openrouterApiKey,
    openaiApiKey,
    openaiBaseUrl,
    openaiCompatible,
    assistantName,
  });
}

