/**
 * Membrane Integration Module
 * 
 * Provides membrane LLM middleware integration for chapterx.
 * 
 * @example
 * ```typescript
 * import { createMembrane, MembraneProvider } from './llm/membrane';
 * 
 * const membrane = createMembrane({
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *   assistantName: 'Claude',
 * });
 * 
 * const provider = new MembraneProvider(membrane);
 * const result = await provider.completeFromLLMRequest(request);
 * ```
 */

// Adapter - type conversion functions
export {
  toMembraneMessage,
  fromMembraneMessage,
  toMembraneMessages,
  fromMembraneMessages,
  toMembraneContentBlock,
  fromMembraneContentBlock,
  toMembraneRequest,
  fromMembraneRequest,
  fromMembraneResponse,
  toMembraneToolDefinition,
  fromMembraneToolDefinition,
  resolveToolModeForModel,
} from './adapter.js';

export type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  MembraneContentBlock,
  MembraneToolDefinition,
  MessageMetadata,
  GenerationConfig,
  MembraneStopReason,
  ToolMode,
} from './adapter.js';

// Factory - membrane instance creation
export {
  createMembrane,
  createMembraneFromVendorConfigs,
  RoutingAdapter,
  getFormatterForModel,
} from './factory.js';

export type { MembraneFactoryConfig, OpenAICompatibleConfig, OpenAICompletionsConfig, FormatterType, VendorConfigInput } from './factory.js';

// Hooks - tracing integration
export {
  createTracingHooks,
  createTracingHooksWithContext,
} from './hooks.js';

export type { SharedHookContext as TracingHookContext } from './hooks.js';

// Provider - wraps membrane for LLM completions
export { MembraneProvider } from './provider.js';

export type { StreamOptions, ChunkMeta, BlockEvent } from './provider.js';

// Re-export membrane formatters and adapters for convenience
export {
  Membrane,
  AnthropicAdapter,
  OpenRouterAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  OpenAICompletionsAdapter,
  AnthropicXmlFormatter,
  NativeFormatter,
  CompletionsFormatter,
} from '@animalabs/membrane';

export type { ProviderAdapter, MembraneConfig, PrefillFormatter } from '@animalabs/membrane';

