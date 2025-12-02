/**
 * Config Plugin
 * 
 * Tools for bots to view and request changes to their own config.
 */

import { ToolPlugin } from './types.js'

const plugin: ToolPlugin = {
  name: 'config',
  description: 'Tools for viewing and requesting config changes',
  tools: [
    {
      name: 'list_config',
      description: 'List current bot configuration values',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Optional filter - only show keys containing this string'
          }
        }
      },
      handler: async (input, context) => {
        const { filter } = input
        const config = context.config
        
        // Get config entries, optionally filtered
        let entries = Object.entries(config)
        if (filter) {
          entries = entries.filter(([key]) => 
            key.toLowerCase().includes(filter.toLowerCase())
          )
        }
        
        // Format for display (redact sensitive values)
        const sensitiveKeys = ['api_key', 'token', 'secret', 'password', 'PERPLEXITY_API_KEY']
        const formatted = entries.map(([key, value]) => {
          // Check if key or any parent key is sensitive
          const isSensitive = sensitiveKeys.some(sk => 
            key.toLowerCase().includes(sk.toLowerCase())
          )
          
          // Redact sensitive values
          let displayValue = value
          if (isSensitive && typeof value === 'string') {
            displayValue = value.slice(0, 4) + '...[redacted]'
          } else if (typeof value === 'object') {
            // For objects, recursively redact
            displayValue = JSON.stringify(value, (k, v) => {
              if (sensitiveKeys.some(sk => k.toLowerCase().includes(sk.toLowerCase())) && typeof v === 'string') {
                return v.slice(0, 4) + '...[redacted]'
              }
              return v
            }, 2)
          } else {
            displayValue = JSON.stringify(value)
          }
          
          return `${key}: ${displayValue}`
        })
        
        return formatted.join('\n')
      }
    },
    {
      name: 'set_config',
      description: 'Change bot configuration by pinning a YAML .config message. For multiline values like system_prompt, use YAML block scalar syntax: key: |\\n  line1\\n  line2',
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'object',
            description: 'YAML-compatible config keys and values. For multiline strings, the value should start with | followed by indented lines.'
          }
        },
        required: ['changes']
      },
      handler: async (input, context) => {
        const { changes } = input
        
        // Validate that changes only include allowed keys (not sensitive ones)
        const forbiddenKeys = ['api_key', 'token', 'secret', 'password', 'mcp_servers', 'tool_plugins']
        const changeKeys = Object.keys(changes)
        const forbiddenAttempts = changeKeys.filter(k => 
          forbiddenKeys.some(fk => k.toLowerCase().includes(fk.toLowerCase()))
        )
        
        if (forbiddenAttempts.length > 0) {
          return `Error: Cannot change sensitive keys: ${forbiddenAttempts.join(', ')}`
        }
        
        // Format as .config message (chapter2 format: .config TARGET\n---\nyaml)
        const yamlLines = Object.entries(changes).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        const configMessage = `.config ${context.botId}\n---\n${yamlLines.join('\n')}`
        
        // Send and pin the config message
        const messageIds = await context.sendMessage(configMessage)
        if (messageIds.length > 0) {
          await context.pinMessage(messageIds[0]!)
        }
        
        return `Config change pinned. Changes will apply on next message:\n${Object.entries(changes).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}`
      }
    }
  ]
}

export default plugin

