/**
 * OpenAI Provider (Chat API)
 * 
 * Standard OpenAI chat completions API - supports chat mode only.
 * Does NOT support prefill (OpenAI doesn't allow partial assistant messages).
 * Supports images (converts from Anthropic format to OpenAI's image_url format).
 * 
 * For prefill support, consider:
 * - OpenRouter provider (uses `prompt` param on chat endpoint)
 * - OpenAI Completions provider (legacy /completions endpoint)
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LLMProvider, ProviderRequest } from '../middleware.js'
import { LLMCompletion, ContentBlock, LLMError } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { getCurrentTrace } from '../../trace/index.js'

export interface OpenAIProviderConfig {
  apiKey: string
  baseUrl?: string  // For compatible endpoints (default: https://api.openai.com/v1)
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  // OpenAI doesn't support true prefill, but we can do chat mode
  readonly supportedModes: ('prefill' | 'chat')[] = ['chat']

  private apiKey: string
  private baseUrl: string

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1'
  }

  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace()
    const callId = trace?.startLLMCall(trace.getLLMCallCount())
    const startTime = Date.now()

    try {
      logger.debug({ model: request.model, baseUrl: this.baseUrl, traceId: trace?.getTraceId() }, 'Calling OpenAI-compatible API')

      // Build request body
      // Note: Newer OpenAI models (gpt-5.x, o1, o3) use max_completion_tokens instead of max_tokens
      const body: any = {
        model: request.model,
        messages: request.messages.map(m => ({
          role: m.role,
          content: this.transformContent(m.content),
        })),
        max_completion_tokens: request.max_tokens,
        temperature: request.temperature,
      }

      // Add stop sequences if provided
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

      // Make API call
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ status: response.status, errorText, model: request.model }, 'OpenAI API returned error')
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`)
      }

      const data = await response.json()

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
      }, 'Received OpenAI response')

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
        const systemMessages = request.messages.filter(m => m.role === 'system')
        const systemPromptLength = systemMessages
          .map(m => typeof m.content === 'string' ? m.content.length : 0)
          .reduce((a, b) => a + b, 0)

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
        })
      }
      logger.error({ error }, 'OpenAI API error')
      throw new LLMError('OpenAI API call failed', error)
    }
  }

  private mapStopReason(reason: string | null | undefined): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' {
    // Handle null/undefined
    if (!reason) {
      return 'end_turn'
    }
    
    // Check for refusal (OpenAI uses 'content_filter')
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
   * - String content passes through as-is
   * - Array content has image blocks converted from Anthropic format to OpenAI format
   */
  private transformContent(content: string | any[]): string | any[] {
    // String content passes through
    if (typeof content === 'string') {
      return content
    }

    // Array content needs image transformation
    return content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text }
      }
      
      if (block.type === 'image') {
        // Transform from Anthropic format to OpenAI format
        // Anthropic: { type: 'image', source: { type: 'base64', data: '...', media_type: 'image/jpeg' } }
        // OpenAI: { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }
        const mediaType = block.source?.media_type || 'image/jpeg'
        const data = block.source?.data || ''
        return {
          type: 'image_url',
          image_url: {
            url: `data:${mediaType};base64,${data}`,
          },
        }
      }

      // Pass through other block types (shouldn't happen but be safe)
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

