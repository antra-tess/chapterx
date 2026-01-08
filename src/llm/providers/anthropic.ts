/**
 * Anthropic Provider
 */

import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LLMProvider, ProviderRequest } from '../middleware.js'
import { LLMCompletion, ContentBlock, LLMError } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { getCurrentTrace } from '../../trace/index.js'
import { processRequestForLogging } from '../../utils/blob-store.js'

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly supportedModes: ('prefill' | 'chat')[] = ['prefill', 'chat']

  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async complete(request: ProviderRequest): Promise<LLMCompletion> {
    const trace = getCurrentTrace()
    const callId = trace?.startLLMCall(trace.getLLMCallCount())
    const startTime = Date.now()

      // Extract system messages - preserve cache_control if present
      const systemMsgs = request.messages.filter((m) => m.role === 'system')
      let systemParam: string | any[] | undefined
      
      if (systemMsgs.length > 0) {
        // Check if any system message has cache_control (array format)
        const hasArrayContent = systemMsgs.some(m => Array.isArray(m.content))
        
        if (hasArrayContent) {
          // Use array format to preserve cache_control
          systemParam = systemMsgs.flatMap(m => {
            if (Array.isArray(m.content)) return m.content
            return [{ type: 'text', text: m.content }]
          })
        } else {
          // Simple string format
          systemParam = systemMsgs
            .map(m => typeof m.content === 'string' ? m.content : '')
        .join('\n\n')
        }
      }

      const nonSystemMessages = request.messages.filter((m) => m.role !== 'system')

      // Build request params (some models don't support both temperature and top_p)
      const params: any = {
        model: request.model,
        max_tokens: request.max_tokens,
        system: systemParam,
        messages: nonSystemMessages,
        stop_sequences: request.stop_sequences,
      }

      // Only include temperature (not top_p) to avoid API errors with newer models
      if (request.temperature !== undefined) {
        params.temperature = request.temperature
      }

      // Add tools if provided
      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools
      }

    // Log request to file BEFORE making the call (so we have it even on error)
    const requestRef = this.logRequestToFile(params)
    
    try {
      logger.debug({ model: request.model, traceId: trace?.getTraceId() }, 'Calling Anthropic API')

      const response = await this.client.messages.create(params)

      // Log response to file (and get ref for trace)
      const responseRef = this.logResponseToFile(response)

      const durationMs = Date.now() - startTime

      logger.debug({ 
        stopReason: response.stop_reason,
        contentBlocks: response.content.length,
        firstBlock: response.content[0]?.type,
        durationMs,
      }, 'Received Anthropic response')

      // Parse response
      const content: ContentBlock[] = response.content.map((block: any) => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        } else if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          }
        }
        // Unknown block type, return as text
        return { type: 'text', text: JSON.stringify(block) }
      })

      // Calculate text length for trace
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
            systemPromptLength: Array.isArray(systemParam) ? systemParam.length : (systemParam?.length || 0),
            hasTools: !!(request.tools && request.tools.length > 0),
            toolCount: request.tools?.length || 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: 'https://api.anthropic.com',
          },
          {
            stopReason: this.mapStopReason(response.stop_reason),
            contentBlocks: response.content.length,
            textLength,
            toolUseCount,
          },
          {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheCreationTokens: (response.usage as any).cache_creation_input_tokens,
            cacheReadTokens: (response.usage as any).cache_read_input_tokens,
          },
          response.model,
          {
            requestBodyRef: requestRef,
            responseBodyRef: responseRef,
          }
        )
      }

      return {
        content,
        stopReason: this.mapStopReason(response.stop_reason),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: (response.usage as any).cache_creation_input_tokens,
          cacheReadTokens: (response.usage as any).cache_read_input_tokens,
        },
        model: response.model,
        raw: response,
      }
    } catch (error) {
      // Record error to trace (request body was already logged above)
      if (trace && callId) {
        trace.failLLMCall(callId, {
          message: error instanceof Error ? error.message : String(error),
          retryCount: 0,
        }, {
          requestBodyRef: requestRef,
          model: request.model,
          request: {
            messageCount: request.messages.length,
            systemPromptLength: Array.isArray(systemParam) ? systemParam.length : (systemParam?.length || 0),
            hasTools: !!(request.tools && request.tools.length > 0),
            toolCount: request.tools?.length || 0,
            temperature: request.temperature,
            maxTokens: request.max_tokens,
            stopSequences: request.stop_sequences,
            apiBaseUrl: 'https://api.anthropic.com',
          },
        })
      }
      logger.error({ error }, 'Anthropic API error')
      throw new LLMError('Anthropic API call failed', error)
    }
  }

  private mapStopReason(reason: string | null): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' {
    // Handle null/undefined
    if (!reason) {
      return 'end_turn'
    }
    
    // Check for refusal (case-insensitive, may appear as 'refusal', 'content_filter', etc.)
    const lowerReason = reason.toLowerCase()
    if (lowerReason.includes('refusal') || lowerReason.includes('refuse') || lowerReason.includes('content_filter')) {
      return 'refusal'
    }
    
    switch (reason) {
      case 'end_turn':
        return 'end_turn'
      case 'max_tokens':
        return 'max_tokens'
      case 'stop_sequence':
        return 'stop_sequence'
      case 'tool_use':
        return 'tool_use'
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

      // Extract images to blob store before logging
      const processedParams = processRequestForLogging(params)
      
      writeFileSync(filename, JSON.stringify(processedParams, null, 2))
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

