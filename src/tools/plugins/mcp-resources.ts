/**
 * MCP Resources Plugin
 *
 * Provides tools to list and read MCP server resources.
 * Resources are read-only data exposed by MCP servers (e.g., robot state, sensor data).
 */

import { ToolPlugin, PluginTool, PluginContext } from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger({ plugin: 'mcp-resources' })

// This will be set by the agent loop when setting up plugin context
let resourceAccessor: {
  getMcpResources: () => Array<{ server: string; uri: string; name: string; description?: string }>
  readMcpResource: (uri: string) => Promise<{ content: string; mimeType?: string } | null>
} | null = null

export function setResourceAccessor(accessor: typeof resourceAccessor) {
  resourceAccessor = accessor
}

const listResourcesTool: PluginTool = {
  name: 'list_mcp_resources',
  description: 'List all available MCP resources. Resources are read-only data from connected services (e.g., robot state, sensor data).',
  inputSchema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'Optional: filter by server name',
      },
    },
    required: [],
  },
  handler: async (input: { server?: string }, _context: PluginContext): Promise<string> => {
    if (!resourceAccessor) {
      return 'MCP resource access not available.'
    }

    const resources = resourceAccessor.getMcpResources()
    
    if (resources.length === 0) {
      return 'No MCP resources available from connected servers.'
    }

    const filtered = input.server 
      ? resources.filter(r => r.server === input.server)
      : resources

    if (filtered.length === 0) {
      return `No resources found for server "${input.server}".`
    }

    const lines = filtered.map(r => {
      const desc = r.description ? ` - ${r.description}` : ''
      return `• ${r.name} (${r.server})\n  URI: ${r.uri}${desc}`
    })

    return `Available MCP Resources (${filtered.length}):\n\n${lines.join('\n\n')}`
  },
}

const readResourceTool: PluginTool = {
  name: 'read_mcp_resource',
  description: 'Read the content of an MCP resource by URI. Use list_mcp_resources first to discover available resources.',
  inputSchema: {
    type: 'object',
    properties: {
      uri: {
        type: 'string',
        description: 'The resource URI (e.g., "robot://state/full")',
      },
    },
    required: ['uri'],
  },
  handler: async (input: { uri: string }, _context: PluginContext): Promise<string> => {
    if (!resourceAccessor) {
      return 'MCP resource access not available.'
    }

    const { uri } = input
    
    logger.info({ uri }, 'Reading MCP resource')
    
    const result = await resourceAccessor.readMcpResource(uri)
    
    if (!result) {
      return `Resource not found or could not be read: ${uri}`
    }

    return result.content
  },
}

const plugin: ToolPlugin = {
  name: 'mcp-resources',
  description: 'Access read-only data from MCP servers (robot state, sensor data, etc.)',
  tools: [listResourcesTool, readResourceTool],
}

export default plugin
