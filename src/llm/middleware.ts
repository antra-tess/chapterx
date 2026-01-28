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
  readonly supportedModes: ('prefill' | 'chat' | 'base-model')[]
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
    // Bot's participant name in LLM context is always config.botName
    // (context builder normalizes bot's Discord messages to use this name)
    const botName = request.config.botName
    const delimiter = request.config.messageDelimiter || ''  // e.g., '</s>' for base models (removes newlines)
    const turnEndToken = request.config.turnEndToken || ''  // e.g., '<eot>' for Gemini (preserves newlines)
    // If using delimiter (base model), don't add newlines - delimiter provides separation
    // If using turnEndToken, keep newlines - token is just appended to content
    const joiner = delimiter ? '' : '\n'
    let lastNonEmptyParticipant: string | null = null
    
    // Check if prompt caching is enabled (default: true)
    const promptCachingEnabled = request.config.prompt_caching !== false
    
    // Track conversation lines for current section
    let currentConversation: Array<{ text: string }> = []
    
    // Track cache marker GLOBALLY across all flushes (not reset on image flush)
    // Everything BEFORE we see the marker gets cache_control
    // Everything AFTER (including the section containing it) does NOT
    let passedCacheMarker = false
    
    // Add system prompt if present (with cache_control for prompt caching if enabled)
    if (request.system_prompt) {
      const systemContent: any = { 
        type: 'text', 
        text: request.system_prompt,
      }
      if (promptCachingEnabled) {
        systemContent.cache_control = { type: 'ephemeral', ttl: '1h' }
      }
      messages.push({
        role: 'system',
        content: [systemContent],
      })
    }
    
    // Add context prefix as first cached assistant message (for simulacrum seeding)
    if (request.context_prefix) {
      // Need a user message first (Anthropic requires user->assistant alternation)
      messages.push({
        role: 'user',
        content: '[conversation begins]',
      })
      const prefixContent: any = { 
        type: 'text', 
        text: request.context_prefix,
      }
      if (promptCachingEnabled) {
        prefixContent.cache_control = { type: 'ephemeral', ttl: '1h' }
      }
      messages.push({
        role: 'assistant',
        content: [prefixContent],
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
        // Flush everything before this message WITH cache_control (if caching enabled)
        if (currentConversation.length > 0) {
          const content = currentConversation.map(e => e.text).join(joiner)
          const contentBlock: any = { type: 'text', text: content }
          if (promptCachingEnabled) {
            contentBlock.cache_control = { type: 'ephemeral', ttl: '1h' }
          }
          messages.push({
            role: 'assistant',
            content: [contentBlock],
          })
          currentConversation = []
        } else if (promptCachingEnabled) {
          // BUG FIX: If currentConversation is empty (e.g., images caused early flush),
          // we need to retroactively add cache_control to the most recent assistant message.
          // Otherwise the large text block flushed for images won't be cached!
          for (let j = messages.length - 1; j >= 0; j--) {
            const prevMsg = messages[j]!
            if (prevMsg.role === 'assistant') {
              const content = prevMsg.content
              if (typeof content === 'string') {
                // Convert string content to array with cache_control
                prevMsg.content = [{
                  type: 'text',
                  text: content,
                  cache_control: { type: 'ephemeral', ttl: '1h' }
                }]
                logger.debug({ 
                  messageIndex: j, 
                  contentLength: content.length 
                }, 'Added cache_control to previous assistant message (image-induced flush recovery)')
              } else if (Array.isArray(content)) {
                // Find the last text block and add cache_control
                for (let k = content.length - 1; k >= 0; k--) {
                  if (content[k].type === 'text' && !content[k].cache_control) {
                    content[k].cache_control = { type: 'ephemeral', ttl: '1h' }
                    logger.debug({ 
                      messageIndex: j, 
                      blockIndex: k 
                    }, 'Added cache_control to previous assistant content block (image-induced flush recovery)')
                    break
                  }
                }
              }
              break
            }
          }
        }
        passedCacheMarker = true
        logger.debug({ messageIndex: i, totalMessages: request.messages.length }, 'Cache marker found - switching to uncached mode')
      }
      
      // Check bot continuation logic
      // Bot's participant name in LLM context is always botName (context builder normalizes it)
      const isBotMessage = msg.participant === botName
      const hasToolResult = msg.content.some(c => c.type === 'tool_result')
      
      // Continuation mode: if the last message in the context is from the bot,
      // we should NOT add a new "\nBotName:" suffix. This is required for "m continue"
      // where we want to continue the previous bot message mid-sentence.
      //
      // Historically this used lastNonEmptyParticipant, but that can be thrown off by
      // empty/filtered messages. Using the immediately previous message is more robust.
      const prevMsg = i > 0 ? request.messages[i - 1] : undefined
      const prevIsBotMessage = !!prevMsg && prevMsg.participant === botName
      const prevHasToolResult = !!prevMsg && prevMsg.content.some(c => c.type === 'tool_result')
      const isContinuation =
        isBotMessage && !hasToolResult && (
          lastNonEmptyParticipant === botName ||
          (prevIsBotMessage && !prevHasToolResult)
        )
      
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
        // Regular message - append delimiter/turnEndToken if configured
        // delimiter: for base models (e.g., '</s>') - removes newlines between messages
        // turnEndToken: for models like Gemini (e.g., '<eot>') - preserves newlines
        const suffix = delimiter || turnEndToken
        currentConversation.push({ text: `${msg.participant}: ${formatted.text}${suffix}` })
        if (!hasToolResult) {
          lastNonEmptyParticipant = msg.participant
        }
      }
    }
    
    // Flush any remaining conversation, insert tools near end
    // Note: By this point, we've already passed the cache marker (if any),
    // so all remaining content is uncached
    
    // Add tools if we have them - regardless of conversation length
    const hasTools = request.tools && request.tools.length > 0
    
    if (currentConversation.length > 0) {
      if (hasTools && currentConversation.length > 10) {
        // Long remaining buffer - insert tools ~10 messages from the end
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
          content: this.formatToolsForPrefill(request.tools ?? []),
        })
        
        // Add content after tools
        if (afterTools.length > 0) {
          messages.push({
            role: 'assistant',
            content: afterTools.map(e => e.text).join(joiner),
          })
        }
      } else if (hasTools) {
        // Short remaining buffer but we have tools - add tools first, then conversation
        messages.push({
          role: 'user',
          content: this.formatToolsForPrefill(request.tools ?? []),
        })
        messages.push({
          role: 'assistant',
          content: currentConversation.map(e => e.text).join(joiner),
        })
      } else {
        // No tools - just add conversation
        messages.push({
          role: 'assistant',
          content: currentConversation.map(e => e.text).join(joiner),
        })
      }
    } else if (hasTools) {
      // No remaining conversation but we have tools - still need to add them
      messages.push({
        role: 'user',
        content: this.formatToolsForPrefill(request.tools ?? []),
      })
    }

    // Anthropic API rejects assistant prefill ending with trailing whitespace
    // Trim the final assistant message if it exists
    const lastMessage = messages[messages.length - 1]
    if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
      lastMessage.content = lastMessage.content.trimEnd()
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
    const botName = request.config.botName
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
        content: `Respond to the chat, where your username is shown as ${botName}. Only respond with the content of your message, without including your username.`,
      })
    }

    // Group consecutive non-bot messages
    let buffer: ParticipantMessage[] = []

    for (const msg of request.messages) {
      // Match by Discord username if available, otherwise fall back to inner name
      const isBot = botAsAssistant && (botDiscordUsername 
        ? msg.participant === botDiscordUsername 
        : msg.participant === botName)

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
          userMsg.content = `${userMsg.content}:\n${botName}:`
        } else if (Array.isArray(userMsg.content)) {
          // Find last text block and append
          const lastTextIdx = userMsg.content.map((c: any) => c.type).lastIndexOf('text')
          if (lastTextIdx >= 0) {
            (userMsg.content[lastTextIdx] as any).text += `:\n${botName}:`
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
      // Add images, stripping tokenEstimate (Anthropic API doesn't allow extra fields)
      for (const img of images) {
        const { tokenEstimate, ...cleanImage } = img as any
        content.push(cleanImage)
      }
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
        // Strip tokenEstimate (Anthropic API doesn't allow extra fields)
        const { tokenEstimate, ...cleanImage } = block as any
        images.push(cleanImage)
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

  // Anthropic-style XML tag constants (assembled to avoid triggering stop sequences)
  private static readonly FUNCTIONS_OPEN = '<' + 'functions>'
  private static readonly FUNCTIONS_CLOSE = '</' + 'functions>'
  private static readonly FUNCTION_OPEN = '<' + 'function>'
  private static readonly FUNCTION_CLOSE = '</' + 'function>'

  // Tool call format constants (plain format - model prefers this)
  private static readonly INVOKE_OPEN_EX = '<' + 'invoke name="'
  private static readonly INVOKE_CLOSE_EX = '</' + 'invoke>'
  private static readonly PARAM_OPEN_EX = '<' + 'parameter name="'
  private static readonly PARAM_CLOSE_EX = '</' + 'parameter>'
  private static readonly FUNC_CALLS_OPEN_EX = '<' + 'function_calls>'
  private static readonly FUNC_CALLS_CLOSE_EX = '</' + 'function_calls>'

  private formatToolsForPrefill(tools: any[]): string {
    // Format each tool as JSON inside <function> tags (Anthropic's actual format)
    const formatted = tools.map((tool) => {
      const toolDef = {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
      return `${LLMMiddleware.FUNCTION_OPEN}${JSON.stringify(toolDef)}${LLMMiddleware.FUNCTION_CLOSE}`
    })

    // Build instruction with example
    const instruction = `
When making function calls using tools that accept array or object parameters ensure those are structured using JSON. For example:
${LLMMiddleware.FUNC_CALLS_OPEN_EX}
${LLMMiddleware.INVOKE_OPEN_EX}example_complex_tool">
${LLMMiddleware.PARAM_OPEN_EX}parameter">[{"color": "orange", "options": {"key": true}}]${LLMMiddleware.PARAM_CLOSE_EX}
${LLMMiddleware.INVOKE_CLOSE_EX}
${LLMMiddleware.FUNC_CALLS_CLOSE_EX}`

    return `${LLMMiddleware.FUNCTIONS_OPEN}
${formatted.join('\n')}
${LLMMiddleware.FUNCTIONS_CLOSE}
${instruction}`
  }
  
}

