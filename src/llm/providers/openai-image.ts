/**
 * OpenAI Image Provider
 * 
 * Supports image generation models (gpt-image-1, gpt-image-1.5, gpt-image-1-mini)
 * using the /v1/images/generations endpoint.
 * 
 * These models are transformers that participate in chat by outputting images
 * instead of text. The conversation is formatted as a prompt string (prefill mode).
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LLMProvider, ProviderRequest } from '../middleware.js'
import { LLMCompletion, ContentBlock, LLMError } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { getCurrentTrace } from '../../trace/index.js'

export interface OpenAIImageProviderConfig {
  apiKey: string
  baseUrl?: string  // Default: https://api.openai.com/v1
}

export class OpenAIImageProvider implements LLMProvider {
  readonly name = 'openai-image'
  // Image models work with prefill-style prompts
  readonly supportedModes: ('prefill' | 'chat')[] = ['prefill']

  private apiKey: string
  private baseUrl: string

  constructor(config: OpenAIImageProviderConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1'
  }

  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace()
    const callId = trace?.startLLMCall(trace.getLLMCallCount())
    const startTime = Date.now()

    // Extract the prompt from the messages
    // In prefill mode, the last assistant message contains the conversation
    const prompt = this.extractPrompt(request.messages)
    
    if (!prompt) {
      throw new LLMError('No prompt content found for image generation')
    }

    // Build request body for image generation
    const body: any = {
      model: request.model,
      prompt: prompt,
      n: 1,
      response_format: 'b64_json',  // Get base64 data instead of URL
    }

    // Log request
    const requestRef = this.logRequestToFile(body)

    try {
      logger.debug({ 
        model: request.model, 
        baseUrl: this.baseUrl,
        promptLength: prompt.length,
        traceId: trace?.getTraceId() 
      }, 'Calling OpenAI Image API')

      const response = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ status: response.status, errorText, model: request.model }, 'OpenAI Image API returned error')
        throw new LLMError(`OpenAI Image API error: ${response.status} ${errorText}`)
      }

      const data = await response.json() as { data?: { b64_json?: string }[] }
      const durationMs = Date.now() - startTime

      // Log response
      const responseRef = this.logResponseToFile(data)

      logger.debug({
        model: request.model,
        hasImage: !!data.data?.[0]?.b64_json,
        durationMs,
      }, 'Received OpenAI Image response')

      // Extract image from response
      const imageData = data.data?.[0]?.b64_json
      if (!imageData) {
        throw new LLMError('No image data in OpenAI Image API response')
      }

      // Build content blocks with image
      const content: ContentBlock[] = [{
        type: 'image',
        source: {
          type: 'base64',
          data: imageData,
          media_type: 'image/png',
        }
      }]

      // Record to trace
      if (trace && callId) {
        trace.completeLLMCall(
          callId,
          {
            messageCount: request.messages.length,
            systemPromptLength: 0,
            hasTools: false,
            toolCount: 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: this.baseUrl,
          },
          {
            stopReason: 'end_turn',
            contentBlocks: 1,
            textLength: 0,
            toolUseCount: 0,
          },
          {
            inputTokens: Math.ceil(prompt.length / 4),  // Rough estimate
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          request.model,
          { requestBodyRef: requestRef, responseBodyRef: responseRef }
        )
      }

      return {
        content,
        stopReason: 'end_turn',
        usage: {
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: 0,
        },
        model: request.model,
        raw: data,
      }

    } catch (error: any) {
      const durationMs = Date.now() - startTime
      logger.error({ error: error.message, model: request.model, durationMs }, 'OpenAI Image API call failed')
      
      if (error instanceof LLMError) {
        throw error
      }
      throw new LLMError(`OpenAI Image API failed: ${error.message}`)
    }
  }

  /**
   * Extract prompt from messages
   * For prefill mode, the conversation is in the assistant messages
   */
  private extractPrompt(messages: ProviderRequest['messages']): string {
    // Find all content and concatenate
    const parts: string[] = []
    
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        parts.push(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(block.text)
          }
        }
      }
    }
    
    return parts.join('\n').trim()
  }

  private logRequestToFile(body: any): string | undefined {
    try {
      const logsDir = process.env.LOGS_DIR || './logs'
      const requestsDir = join(logsDir, 'llm-requests')
      
      if (!existsSync(requestsDir)) {
        mkdirSync(requestsDir, { recursive: true })
      }
      
      const filename = `request-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const filepath = join(requestsDir, filename)
      
      writeFileSync(filepath, JSON.stringify(body, null, 2))
      logger.debug({ filename: filepath }, 'Logged image request to file')
      
      return filename
    } catch (err) {
      logger.warn({ err }, 'Failed to log image request to file')
      return undefined
    }
  }

  private logResponseToFile(response: any): string | undefined {
    try {
      const logsDir = process.env.LOGS_DIR || './logs'
      const responsesDir = join(logsDir, 'llm-responses')
      
      if (!existsSync(responsesDir)) {
        mkdirSync(responsesDir, { recursive: true })
      }
      
      const filename = `response-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const filepath = join(responsesDir, filename)
      
      // Don't log the full base64 image data - just log metadata
      const logData = {
        ...response,
        data: response.data?.map((d: any) => ({
          ...d,
          b64_json: d.b64_json ? `[base64 image data: ${d.b64_json.length} chars]` : undefined,
        }))
      }
      
      writeFileSync(filepath, JSON.stringify(logData, null, 2))
      logger.debug({ filename: filepath }, 'Logged image response to file')
      
      return filename
    } catch (err) {
      logger.warn({ err }, 'Failed to log image response to file')
      return undefined
    }
  }
}
