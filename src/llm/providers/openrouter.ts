/**
 * OpenRouter Provider
 * 
 * OpenRouter is an API gateway that supports many models including Anthropic models.
 * Unlike standard OpenAI, OpenRouter DOES support prefill mode by allowing
 * the last message to be a partial assistant message.
 * 
 * Uses OpenAI-compatible chat completions API format.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LLMProvider, ProviderRequest } from '../middleware.js'
import { LLMCompletion, ContentBlock, LLMError } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { getCurrentTrace } from '../../trace/index.js'

export interface OpenRouterProviderConfig {
  apiKey: string
  baseUrl?: string  // Default: https://openrouter.ai/api/v1
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter'
  // OpenRouter supports prefill for models that support it (like Claude)
  readonly supportedModes: ('prefill' | 'chat')[] = ['prefill', 'chat']

  private apiKey: string
  private baseUrl: string

  constructor(config: OpenRouterProviderConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1'
  }

  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace()
    const callId = trace?.startLLMCall(trace.getLLMCallCount())
    const startTime = Date.now()

    // Build request body
    const body: any = {
      model: request.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: this.transformContent(m.content),
      })),
      max_tokens: request.max_tokens,
      temperature: request.temperature,
    }

    // Add stop sequences if provided
    // Note: OpenAI-compatible APIs may limit to 4, but we let them handle that
    if (request.stop_sequences && request.stop_sequences.length > 0) {
      body.stop = request.stop_sequences
    }

    // Add tools if provided (OpenAI native function calling)
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        }
      }))
    }

    // Log request to file
    const requestRef = this.logRequestToFile(body)

    // Calculate system prompt length for trace
    const systemMessages = request.messages.filter(m => m.role === 'system')
    const systemPromptLength = systemMessages
      .map(m => typeof m.content === 'string' ? m.content.length : 0)
      .reduce((a, b) => a + b, 0)

    try {
      logger.debug({ model: request.model, baseUrl: this.baseUrl, traceId: trace?.getTraceId() }, 'Calling OpenRouter API')

      // Make API call
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://github.com/animalabs/chapter3',  // OpenRouter requires this
          'X-Title': 'Chapter3 Bot',  // Optional but recommended
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ status: response.status, errorText, model: request.model }, 'OpenRouter API returned error')
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`)
      }

      const data = await response.json() as any

      // Log response to file
      const responseRef = this.logResponseToFile(data)

      const durationMs = Date.now() - startTime
      const choice = data.choices?.[0]
      const message = choice?.message

      logger.debug({
        stopReason: choice?.finish_reason,
        hasContent: !!message?.content,
        hasToolCalls: !!message?.tool_calls,
        durationMs,
      }, 'Received OpenRouter response')

      // Parse response content
      const content: ContentBlock[] = []

      // Add text content
      if (message?.content) {
        content.push({ type: 'text', text: message.content })
      }

      // Add tool calls if present
      if (message?.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.type === 'function') {
            content.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments || '{}'),
            })
          }
        }
      }

      // Calculate metrics
      const textLength = content
        .filter(c => c.type === 'text')
        .reduce((sum, c) => sum + ((c as any).text?.length || 0), 0)
      const toolUseCount = content.filter(c => c.type === 'tool_use').length

      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength,
            hasTools: !!(request.tools && request.tools.length > 0),
            toolCount: request.tools?.length || 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: this.baseUrl,
          },
          {
            stopReason: this.mapStopReason(choice?.finish_reason),
            contentBlocks: content.length,
            textLength,
            toolUseCount,
          },
          {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
          },
          data.model || request.model,
          {
            requestBodyRef: requestRef,
            responseBodyRef: responseRef,
          }
        )
      }

      return {
        content,
        stopReason: this.mapStopReason(choice?.finish_reason),
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
        },
        model: data.model || request.model,
        raw: data,
      }
    } catch (error) {
      // Record error to trace
      if (trace && callId) {
        trace.failLLMCall(callId, {
          message: error instanceof Error ? error.message : String(error),
          retryCount: 0,
        }, {
          requestBodyRef: requestRef,
          model: request.model,
          request: {
            messageCount: request.messages.length,
            systemPromptLength,
            hasTools: !!(request.tools && request.tools.length > 0),
            toolCount: request.tools?.length || 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: this.baseUrl,
          },
        })
      }
      logger.error({ error }, 'OpenRouter API error')
      throw new LLMError('OpenRouter API call failed', error)
    }
  }

  private mapStopReason(reason: string | null | undefined): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' {
    if (!reason) {
      return 'end_turn'
    }
    
    const lowerReason = reason.toLowerCase()
    if (lowerReason.includes('refusal') || lowerReason.includes('refuse') || lowerReason.includes('content_filter')) {
      return 'refusal'
    }
    
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'tool_calls':
        return 'tool_use'
      default:
        return 'end_turn'
    }
  }

  /**
   * Transform content blocks from internal format to OpenAI format
   */
  private transformContent(content: string | any[]): string | any[] {
    if (typeof content === 'string') {
      return content
    }

    return content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text }
      }
      
      if (block.type === 'image') {
        const mediaType = block.source?.media_type || 'image/jpeg'
        const data = block.source?.data || ''
        return {
          type: 'image_url',
          image_url: {
            url: `data:${mediaType};base64,${data}`,
          },
        }
      }

      return block
    })
  }

  private logRequestToFile(params: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-requests')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const basename = `request-${timestamp}.json`
      const filename = join(dir, basename)

      writeFileSync(filename, JSON.stringify(params, null, 2))
      logger.debug({ filename }, 'Logged request to file')
      return basename
    } catch (error) {
      logger.warn({ error }, 'Failed to log request to file')
      return undefined
    }
  }

  private logResponseToFile(response: any): string | undefined {
    try {
      const dir = join(process.cwd(), 'logs', 'llm-responses')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const basename = `response-${timestamp}.json`
      const filename = join(dir, basename)

      writeFileSync(filename, JSON.stringify(response, null, 2))
      logger.debug({ filename }, 'Logged response to file')
      return basename
    } catch (error) {
      logger.warn({ error }, 'Failed to log response to file')
      return undefined
    }
  }
}

