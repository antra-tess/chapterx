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
          
          let displayValue = value
          if (isSensitive && typeof value === 'string') {
            displayValue = value.slice(0, 4) + '...[redacted]'
          } else if (typeof value === 'object') {
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
      description: 'Change bot configuration by pinning a YAML .config message.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Config key to set (e.g. system_prompt, temperature)'
          },
          value: {
            type: 'string',
            description: 'Value to set. For multiline, use actual newlines.'
          }
        },
        required: ['key', 'value']
      },
      handler: async (input, context) => {
        try {
          const { key, value } = input
          
          if (!key || value === undefined) {
            return 'Error: key and value are required'
          }
          
          const forbiddenKeys = ['api_key', 'token', 'secret', 'password', 'mcp_servers', 'tool_plugins']
          if (forbiddenKeys.some(fk => key.toLowerCase().includes(fk.toLowerCase()))) {
            return `Error: Cannot change sensitive key: ${key}`
          }
          
          if (!context.sendMessage) {
            return 'Error: sendMessage not available in this context'
          }
          
          let yamlValue = value
          if (typeof value === 'string' && value.includes('\n')) {
            const indented = value.split('\n').map(line => `  ${line}`).join('\n')
            yamlValue = `|\n${indented}`
          }
          
          const configMessage = `.config ${context.botId}\n---\n${key}: ${yamlValue}`
          
          const messageIds = await context.sendMessage(configMessage)
          if (messageIds.length > 0 && context.pinMessage) {
            await context.pinMessage(messageIds[0]!)
          }
          
          return `Config change pinned. ${key} will update on next message.`
        } catch (err: any) {
          return `Error: ${err?.message || err?.toString() || 'Unknown error'}`
        }
      }
    }
  ]
}

export default plugin

