/**
 * Plugin Registry
 * 
 * All available plugins are registered here.
 */

import { ToolPlugin } from './types.js'
import configPlugin from './config.js'
import notesPlugin from './notes.js'
import injectPlugin from './inject.js'
import uploadPlugin from './upload.js'
import shareImagePlugin from './share-image.js'
import mcpResourcesPlugin from './mcp-resources.js'

// Register all available plugins
export const availablePlugins: Record<string, ToolPlugin> = {
  'config': configPlugin,
  'notes': notesPlugin,
  'inject': injectPlugin,
  'upload': uploadPlugin,
  'share-image': shareImagePlugin,
  'mcp-resources': mcpResourcesPlugin,
}

export * from './types.js'
export * from './state.js'
export { PluginContextFactory } from './context-factory.js'

