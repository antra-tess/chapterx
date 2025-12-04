/**
 * LLM Middleware
 * Transforms participant-based format to provider-specific formats
 */

import {
  LLMRequest,
  LLMCompletion,
  ParticipantMessage,
  ContentBlock,
  TextContent,
  LLMError,
  VendorConfig,
} from '../types.js'
import { logger } from '../utils/logger.js'
import { retryLLM } from '../utils/retry.js'
import { matchesAny } from '../utils/validation.js'

export interface LLMProvider {
  readonly name: string
  readonly supportedModes: ('prefill' | 'chat')[]
  complete(request: ProviderRequest): Promise<LLMCompletion>
}

export interface ProviderRequest {
  messages: ProviderMessage[]
  model: string
  temperature: number
  max_tokens: number
  top_p: number
  stop_sequences?: string[]
  tools?: any[]
  presence_penalty?: number
  frequency_penalty?: number
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | any[]
}

export class LLMMiddleware {
  private providers = new Map<string, LLMProvider>()
  private vendorConfigs: Record<string, VendorConfig> = {}

  constructor() {}

  /**
   * Register a provider
   * @param provider The provider instance
   * @param name Optional name override (defaults to provider.name). Use vendor name for correct routing.
   */
  registerProvider(provider: LLMProvider, name?: string): void {
    const registrationName = name || provider.name
    this.providers.set(registrationName, provider)
    logger.info({ provider: registrationName, type: provider.name }, 'Registered LLM provider')
  }

  /**
   * Set vendor configurations
   */
  setVendorConfigs(configs: Record<string, VendorConfig>): void {
    this.vendorConfigs = configs
  }

  /**
   * Complete a request with automatic provider selection
   */
  async complete(request: LLMRequest): Promise<LLMCompletion> {
    const provider = this.selectProvider(request.config.model)

    // Check if mode is supported
    if (!provider.supportedModes.includes(request.config.mode)) {
      throw new LLMError(
        `Provider ${provider.name} does not support ${request.config.mode} mode`
      )
    }

    // Transform to provider format based on mode
    const providerRequest =
      request.config.mode === 'prefill'
        ? this.transformToPrefill(request, provider)
        : this.transformToChat(request, provider)

    // Execute with retries
    const completion = await retryLLM(
      () => provider.complete(providerRequest),
      3  // TODO: Get from config
    )

    return completion
  }

  private selectProvider(modelName: string): LLMProvider {
    // Check vendor configs for model match
    // Each vendor is now registered with its own name
    for (const [vendorName, config] of Object.entries(this.vendorConfigs)) {
      if (matchesAny(modelName, config.provides)) {
        const provider = this.providers.get(vendorName)
        if (provider) {
          logger.debug({ modelName, vendorName }, 'Selected provider for model')
          return provider
        }
        // Provider not registered for this vendor - continue looking
        logger.debug({ modelName, vendorName }, 'Vendor matches but provider not registered')
      }
    }

    throw new LLMError(`No provider found for model: ${modelName}`)
  }

  private transformToPrefill(request: LLMRequest, _provider: LLMProvider): ProviderRequest {
    // Build conversation, splitting messages with images into user turns
    const messages: ProviderMessage[] = []
    const botName = request.config.botInnerName
    const delimiter = request.config.messageDelimiter || ''  // e.g., '</s>' for base models
    // If using delimiter, don't add newlines between messages - delimiter provides separation
    const joiner = delimiter ? '' : '\n'
    let lastNonEmptyParticipant: string | null = null
    
    // Track conversation lines for current section
    let currentConversation: Array<{ text: string }> = []
    
    // Track cache marker GLOBALLY across all flushes (not reset on image flush)
    // Everything BEFORE we see the marker gets cache_control
    // Everything AFTER (including the section containing it) does NOT
    let passedCacheMarker = false
    
    // Add system prompt if present (with cache_control for prompt caching)
    if (request.system_prompt) {
      messages.push({
        role: 'system',
        content: [{ 
          type: 'text', 
          text: request.system_prompt,
          cache_control: { type: 'ephemeral' }
        }],
      })
    }
    
    // Add context prefix as first cached assistant message (for simulacrum seeding)
    if (request.context_prefix) {
      // Need a user message first (Anthropic requires user->assistant alternation)
      messages.push({
        role: 'user',
        content: '[conversation begins]',
      })
      messages.push({
        role: 'assistant',
        content: [{ 
          type: 'text', 
          text: request.context_prefix,
          cache_control: { type: 'ephemeral' }
        }],
      })
    }
    
    for (let i = 0; i < request.messages.length; i++) {
      const msg = request.messages[i]!
      const isLastMessage = i === request.messages.length - 1
      const formatted = this.formatContentForPrefill(msg.content, msg.participant)
      const hasImages = formatted.images.length > 0
      const isEmpty = !formatted.text.trim() && !hasImages
      const hasCacheMarker = !!msg.cacheControl
      
      // Don't insert tools yet - we'll add them near the end
      
      // If message has images, flush current conversation and add as user message
      if (hasImages && !isEmpty) {
        // Flush current assistant conversation (NO cache_control here - only at cache marker)
        if (currentConversation.length > 0) {
          const content = currentConversation.map(e => e.text).join(joiner)
          messages.push({
            role: 'assistant',
            content: content,
          })
          currentConversation = []
        }
        
        // Add message with image as user turn
        const userContent: any[] = []
        if (formatted.text) {
          userContent.push({type: 'text', text: `${msg.participant}: ${formatted.text}`})
        }
        userContent.push(...formatted.images)
        
        messages.push({
          role: 'user',
          content: userContent,
        })
        
        lastNonEmptyParticipant = msg.participant
        continue
      }
      
      // Skip empty messages (except last)
      if (isEmpty && !isLastMessage) {
        continue
      }
      
      // Check if this message has the cache marker - switch to uncached mode AFTER this
      if (hasCacheMarker && !passedCacheMarker) {
        // Flush everything before this message WITH cache_control
        if (currentConversation.length > 0) {
          const content = currentConversation.map(e => e.text).join(joiner)
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }],
          })
          currentConversation = []
        }
        passedCacheMarker = true
        logger.debug({ messageIndex: i, totalMessages: request.messages.length }, 'Cache marker found - switching to uncached mode')
      }
      
      // Check bot continuation logic
      const isBotMessage = msg.participant === botName
      const hasToolResult = msg.content.some(c => c.type === 'tool_result')
      const isContinuation = isBotMessage && lastNonEmptyParticipant === botName && !hasToolResult
      
      if (isContinuation && isLastMessage) {
        // Bot continuation - don't add prefix, just complete from where we are
        continue
      } else if (isLastMessage && isEmpty) {
        // Completion target - optionally start with thinking tag
        // Note: No delimiter here - we want the model to generate the message
        if (request.config.prefill_thinking) {
          currentConversation.push({ text: `${msg.participant}: <thinking>` })
        } else {
          currentConversation.push({ text: `${msg.participant}:` })
        }
      } else if (formatted.text) {
        // Regular message - append delimiter if configured (for base model completions)
        currentConversation.push({ text: `${msg.participant}: ${formatted.text}${delimiter}` })
        if (!hasToolResult) {
          lastNonEmptyParticipant = msg.participant
        }
      }
    }
    
    // Flush any remaining conversation, insert tools near end
    // Note: By this point, we've already passed the cache marker (if any),
    // so all remaining content is uncached
    if (currentConversation.length > 0) {
      if (request.tools && request.tools.length > 0 && currentConversation.length > 10) {
        // Insert tools ~10 messages from the end
        const splitPoint = currentConversation.length - 10
        const beforeTools = currentConversation.slice(0, splitPoint)
        const afterTools = currentConversation.slice(splitPoint)
        
        // Add content before tools (no cache_control - we're past the marker)
        if (beforeTools.length > 0) {
          messages.push({
            role: 'assistant',
            content: beforeTools.map(e => e.text).join(joiner),
          })
        }
        
        // Add tools
        messages.push({
          role: 'user',
          content: this.formatToolsForPrefill(request.tools),
        })
        
        // Add content after tools
        if (afterTools.length > 0) {
          messages.push({
            role: 'assistant',
            content: afterTools.map(e => e.text).join(joiner),
          })
        }
      } else {
        // Short conversation - just add everything (no cache_control - we're past marker or none exists)
        messages.push({
          role: 'assistant',
          content: currentConversation.map(e => e.text).join(joiner),
        })
      }
    }

    return {
      messages,
      model: request.config.model,
      temperature: request.config.temperature,
      max_tokens: request.config.max_tokens,
      top_p: request.config.top_p,
      stop_sequences: request.stop_sequences,
      tools: undefined,  // Don't use native tool use in prefill mode
      presence_penalty: request.config.presence_penalty,
      frequency_penalty: request.config.frequency_penalty,
    }
  }

  private transformToChat(request: LLMRequest, _provider: LLMProvider): ProviderRequest {
    const messages: ProviderMessage[] = []
    const botInnerName = request.config.botInnerName
    // Use Discord username for message matching (identifies bot's own messages accurately)
    const botDiscordUsername = request.config.botDiscordUsername
    const usePersonaPrompt = request.config.chatPersonaPrompt
    const usePersonaPrefill = request.config.chatPersonaPrefill
    const botAsAssistant = request.config.chatBotAsAssistant !== false  // Default true

    // Add system prompt
    if (request.system_prompt) {
      messages.push({
        role: 'system',
        content: request.system_prompt,
      })
    }
    
    // Add persona instruction if configured
    if (usePersonaPrompt) {
      messages.push({
        role: 'system',
        content: `Respond to the chat, where your username is shown as ${botInnerName}. Only respond with the content of your message, without including your username.`,
      })
    }

    // Group consecutive non-bot messages
    let buffer: ParticipantMessage[] = []

    for (const msg of request.messages) {
      // Match by Discord username if available, otherwise fall back to inner name
      const isBot = botAsAssistant && (botDiscordUsername 
        ? msg.participant === botDiscordUsername 
        : msg.participant === botInnerName)

      if (isBot) {
        // Flush buffer
        if (buffer.length > 0) {
          messages.push(this.mergeToUserMessage(buffer))
          buffer = []
        }
        // Add bot message as assistant (skip if empty - API doesn't allow empty assistant messages)
        const text = this.extractText(msg.content)
        if (text.trim()) {
        messages.push({
          role: 'assistant',
          content: text,
        })
        }
      } else {
        // Add to buffer (including bot messages if botAsAssistant is false)
        buffer.push(msg)
      }
    }

    // Flush remaining buffer (this is the last user message)
    if (buffer.length > 0) {
      const userMsg = this.mergeToUserMessage(buffer)
      // Add persona prefill ending if configured (adds "botname:" to prompt completion)
      if (usePersonaPrefill) {
        if (typeof userMsg.content === 'string') {
          userMsg.content = `${userMsg.content}:\n${botInnerName}:`
        } else if (Array.isArray(userMsg.content)) {
          // Find last text block and append
          const lastTextIdx = userMsg.content.map((c: any) => c.type).lastIndexOf('text')
          if (lastTextIdx >= 0) {
            (userMsg.content[lastTextIdx] as any).text += `:\n${botInnerName}:`
          }
        }
      }
      messages.push(userMsg)
    }

    return {
      messages,
      model: request.config.model,
      temperature: request.config.temperature,
      max_tokens: request.config.max_tokens,
      top_p: request.config.top_p,
      tools: request.tools,
      presence_penalty: request.config.presence_penalty,
      frequency_penalty: request.config.frequency_penalty,
    }
  }

  private mergeToUserMessage(messages: ParticipantMessage[]): ProviderMessage {
    const parts: string[] = []
    const images: any[] = []

    for (const msg of messages) {
      const text = this.extractText(msg.content)
      if (text) {
        parts.push(`${msg.participant}: ${text}`)
      }
      // Collect images
      for (const block of msg.content) {
        if (block.type === 'image') {
          images.push(block)
        }
      }
    }

    // If there are images, return content as array of blocks
    if (images.length > 0) {
      const content: any[] = []
      // Add text first
      if (parts.length > 0) {
        content.push({ type: 'text', text: parts.join('\n') })
      }
      // Add images
      content.push(...images)
      return {
        role: 'user',
        content,
      }
    }

    // No images - return simple string content
    return {
      role: 'user',
      content: parts.join('\n'),
    }
  }

  private formatContentForPrefill(content: ContentBlock[], participant: string): {text: string, images: any[]} {
    const parts: string[] = []
    const images: any[] = []

    for (const block of content) {
      if (block.type === 'text') {
        parts.push((block as any).text)
      } else if (block.type === 'image') {
        // Images are handled separately - will be added as content blocks in Anthropic format
        images.push(block)
      } else if (block.type === 'tool_use') {
        const toolUse = block as any
        // Format as: Name>[toolname]: {json}
        parts.push(`${participant}>[${toolUse.name}]: ${JSON.stringify(toolUse.input)}`)
      } else if (block.type === 'tool_result') {
        const toolResult = block as any
        const resultText = typeof toolResult.content === 'string' 
          ? toolResult.content 
          : JSON.stringify(toolResult.content)
        // Format as: Name<[toolname]: result
        // Extract tool name from ID or use generic
        parts.push(`${participant}<[tool_result]: ${resultText}`)
      }
    }

    return {text: parts.join('\n'), images}
  }

  private extractText(content: ContentBlock[]): string {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => (c as TextContent).text)
      .join('\n')
  }

  private formatToolsForPrefill(tools: any[]): string {
    const formatted = tools.map((tool) => {
      // Generate concise description: strip fluff, keep first sentence, max ~60 chars
      const desc = this.conciseDescription(tool.description)
      
      // Generate example from schema
      const example = this.schemaToExample(tool.inputSchema)
      const exampleStr = JSON.stringify(example)
      
      return `${tool.name} - ${desc}\n  <${tool.name}>${exampleStr}</${tool.name}>`
    })

    return `<tools>
${formatted.join('\n')}

Don't announce the tool calls. Others will not see the calls, as they will be redacted from Discord messages.
To escape a tool call (show without executing), wrap in backticks: \`<tool>{}\`
</tools>`
  }
  
  private conciseDescription(desc: string): string {
    if (!desc) return ''
    
    // Take first sentence
    let result = desc.split(/[.!]/)[0] || desc
    
    // Remove fluff phrases
    const fluff = [
      /^(This tool |Tool to |A tool that |Allows you to |Used to |Use this to )/i,
      /\s*(using|via|through) the \w+ API/gi,
      /\s*and returns? .*$/i,
    ]
    for (const pattern of fluff) {
      result = result.replace(pattern, '')
    }
    
    // Trim and capitalize
    result = result.trim()
    if (result.length > 80) {
      result = result.slice(0, 77) + '...'
    }
    
    return result
  }
  
  private schemaToExample(schema: any): any {
    if (!schema) return {}
    
    const props = schema.properties || {}
    const required = schema.required || []
    
    // Only include required props, or first 2 if none required
    const propsToInclude = required.length > 0 
      ? required 
      : Object.keys(props).slice(0, 2)
    
    const example: any = {}
    for (const key of propsToInclude) {
      const propSchema = props[key]
      if (propSchema) {
        example[key] = this.schemaValueExample(propSchema, key)
      }
    }
    
    return example
  }
  
  private schemaValueExample(schema: any, name: string): any {
    if (!schema) return '...'
    
    const type = schema.type
    
    // Check for enum - use first value
    if (schema.enum && schema.enum.length > 0) {
      return schema.enum[0]
    }
    
    // Check description for examples like "e.g., system, user, assistant"
    const desc = schema.description || ''
    const egMatch = desc.match(/e\.?g\.?,?\s*['"]?(\w+)['"]?/i)
    if (egMatch && type === 'string') {
      return egMatch[1]
    }
    
    switch (type) {
      case 'string':
        // Use contextual placeholder based on name
        if (name.includes('url') || name.includes('path')) return 'https://...'
        if (name.includes('query') || name.includes('question') || name.includes('content')) return '...'
        if (name.includes('name')) return 'example'
        return '...'
      
      case 'number':
      case 'integer':
        return 1
      
      case 'boolean':
        return true
      
      case 'array':
        // Generate one example item
        const itemSchema = schema.items
        if (itemSchema) {
          return [this.schemaValueExample(itemSchema, name)]
        }
        return ['...']
      
      case 'object':
        // Recurse into nested object
        const nestedProps = schema.properties || {}
        const nestedRequired = schema.required || []
        const nestedKeys = nestedRequired.length > 0 
          ? nestedRequired.slice(0, 3)
          : Object.keys(nestedProps).slice(0, 3)
        
        const obj: any = {}
        for (const k of nestedKeys) {
          if (nestedProps[k]) {
            obj[k] = this.schemaValueExample(nestedProps[k], k)
          }
        }
        return obj
      
      default:
        return '...'
    }
  }
}

