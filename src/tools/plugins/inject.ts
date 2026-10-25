import { ToolPlugin, ContextInjection, PluginStateContext } from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger({ plugin: 'inject' })

interface InjectionConfig {
  id: string
  content: string
  depth: number
  anchor?: 'earliest' | 'latest'
  priority?: number
}

interface InjectPluginConfig {
  injections?: InjectionConfig[]
}

const plugin: ToolPlugin = {
  name: 'inject',
  description: 'Inject arbitrary text at specific depths in context (config-driven, no tools)',
  tools: [],
  
  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = context.pluginConfig as InjectPluginConfig | undefined
    
    if (!config?.injections?.length) {
      return []
    }
    
    const results: ContextInjection[] = []
    
    for (const injection of config.injections) {
      if (!injection.id || !injection.content) {
        logger.warn({ injection }, 'Skipping injection with missing id or content')
        continue
      }
      
      const anchor = injection.anchor || 'latest'
      
      let targetDepth: number
      if (anchor === 'earliest') {
        targetDepth = -(injection.depth + 1)
      } else {
        targetDepth = injection.depth
      }
      
      results.push({
        id: `inject:${injection.id}`,
        content: injection.content,
        targetDepth,
        priority: injection.priority ?? 0,
      })
      
      logger.debug({
        id: injection.id,
        depth: injection.depth,
        anchor,
        targetDepth,
        contentLength: injection.content.length
      }, 'Added injection from config')
    }
    
    logger.info({ count: results.length }, 'Returning config-driven injections')
    return results
  },
}

export default plugin


