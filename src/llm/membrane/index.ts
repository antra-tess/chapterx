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
 * const provider = new MembraneProvider(membrane, 'Claude');
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
} from './factory.js';

export type { MembraneFactoryConfig } from './factory.js';

// Hooks - tracing integration
export {
  createTracingHooks,
  createTracingHooksWithContext,
} from './hooks.js';

export type { SharedHookContext as TracingHookContext } from './hooks.js';

// Provider - LLMProvider implementation
export { MembraneProvider } from './provider.js';

