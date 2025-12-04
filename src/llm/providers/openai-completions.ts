/**
 * OpenAI Completions Provider (Base Model API)
 * 
 * Uses the OpenAI-compatible /v1/completions endpoint for base/foundation models.
 * This is for models that take a prompt and return a continuation (no chat roles).
 * 
 * Supports prefill mode only - converts participant messages to a single prompt string.
 * Does NOT support chat mode or native tool use (base models are completion-only).
 * 
 * Configuration:
 *   vendors:
 *     my-base-model:
 *       config:
 *         openai_completions_api_key: "sk-..."
 *         openai_completions_base_url: "https://api.example.com/v1"
 *       provides:
 *         - "my-model-.*"
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LLMProvider, ProviderRequest } from '../middleware.js'
import { LLMCompletion, ContentBlock, LLMError } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { getCurrentTrace } from '../../trace/index.js'

export interface OpenAICompletionsProviderConfig {
  apiKey: string
  baseUrl: string  // Required - e.g., "https://api.openai.com/v1" or compatible endpoint
}

export class OpenAICompletionsProvider implements LLMProvider {
  readonly name = 'openai-completions'
  // Base models only support completion (prefill) mode - no chat roles
  readonly supportedModes: ('prefill' | 'chat')[] = ['prefill']

  private apiKey: string
  private baseUrl: string

  constructor(config: OpenAICompletionsProviderConfig) {
    this.apiKey = config.apiKey
    if (!config.baseUrl) {
      throw new Error('OpenAI Completions provider requires baseUrl to be configured')
    }
    this.baseUrl = config.baseUrl
  }

  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace()
    const callId = trace?.startLLMCall(trace.getLLMCallCount())
    const startTime = Date.now()

    // Convert chat messages to a single prompt string
    // For base models, we concatenate all messages into one prompt
    const prompt = this.buildPrompt(request.messages)

    // Build request body for /v1/completions endpoint
    const body: any = {
      model: request.model,
      prompt,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
    }

    // Add penalty parameters if provided
    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }
    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    // Add stop sequences if provided
    if (request.stop_sequences && request.stop_sequences.length > 0) {
      body.stop = request.stop_sequences
    }

    // Note: /v1/completions doesn't support tools - they should be embedded in prompt

    // Log request to file BEFORE making the call (so we have it even on error)
    const requestRef = this.logRequestToFile(body)

    // Calculate system prompt length for trace (from system messages if any)
    const systemMessages = request.messages.filter(m => m.role === 'system')
    const systemPromptLength = systemMessages
      .map(m => typeof m.content === 'string' ? m.content.length : 0)
      .reduce((a, b) => a + b, 0)

    try {
      logger.debug({ 
        model: request.model, 
        baseUrl: this.baseUrl, 
        promptLength: prompt.length,
        traceId: trace?.getTraceId() 
      }, 'Calling OpenAI Completions API (base model)')

      // Make API call to /v1/completions (not /v1/chat/completions)
      const response = await fetch(`${this.baseUrl}/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ 
          status: response.status, 
          errorText, 
          model: request.model 
        }, 'OpenAI Completions API returned error')
        throw new Error(`OpenAI Completions API error ${response.status}: ${errorText}`)
      }

      const data = await response.json() as any

      // Log response to file
      const responseRef = this.logResponseToFile(data)

      const durationMs = Date.now() - startTime
      const choice = data.choices?.[0]
      const text = choice?.text || ''

      logger.debug({
        finishReason: choice?.finish_reason,
        textLength: text.length,
        durationMs,
      }, 'Received OpenAI Completions response')

      // Parse response - completions API returns text directly
      const content: ContentBlock[] = []
      if (text) {
        content.push({ type: 'text', text })
      }

      // Calculate metrics
      const textLength = text.length

      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength,
            hasTools: false,  // Completions API doesn't have native tools
            toolCount: 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: this.baseUrl,
          },
          {
            stopReason: this.mapStopReason(choice?.finish_reason),
            contentBlocks: content.length,
            textLength,
            toolUseCount: 0,
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
            hasTools: false,
            toolCount: 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: this.baseUrl,
          },
        })
      }
      logger.error({ error }, 'OpenAI Completions API error')
      throw new LLMError('OpenAI Completions API call failed', error)
    }
  }

  /**
   * Build a single prompt string from chat-format messages.
   * For base models, we concatenate all content into one prompt.
   * 
   * The middleware's prefill transformation already does most of the work -
   * it converts participant messages into "Name: content" format.
   * We just need to concatenate the message contents.
   */
  private buildPrompt(messages: { role: string; content: string | any[] }[]): string {
    const parts: string[] = []

    for (const msg of messages) {
      const text = this.extractText(msg.content)
      if (text) {
        // System messages can be included as-is or with a prefix
        if (msg.role === 'system') {
          parts.push(text)
        } else {
          // User/assistant messages - the middleware has already formatted them
          parts.push(text)
        }
      }
    }

    return parts.join('\n')
  }

  /**
   * Extract text content from a message's content field.
   * Content can be a string or an array of content blocks.
   */
  private extractText(content: string | any[]): string {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      return content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    }

    return ''
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
        return 'stop_sequence'  // Completions API uses 'stop' when hitting stop sequence
      case 'length':
        return 'max_tokens'
      default:
        return 'end_turn'
    }
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
