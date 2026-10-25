/**
 * Token Estimation
 * 
 * Rough token counting for context size estimation.
 * Uses simple heuristics since we don't have access to the actual tokenizer.
 */

import { ContentBlock, ParticipantMessage } from '../types.js'

const ESTIMATED_IMAGE_TOKENS = 1000

/**
 * Estimate tokens for a string.
 * Rule of thumb: ~4 characters per token for English text.
 * This is an approximation - actual tokenization varies.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // Average of ~4 chars per token, but account for whitespace and special chars
  return Math.ceil(text.length / 3.5)
}

/**
 * Estimate tokens for a content block
 */
export function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens((block as any).text || '')
    
    case 'image':
      // Images are roughly 1000-2000 tokens depending on size
      // Anthropic charges based on image dimensions
      // Rough estimate: 765 tokens for a typical image
      return ESTIMATED_IMAGE_TOKENS
    
    case 'tool_use':
      const toolBlock = block as any
      return estimateTokens(toolBlock.name || '') + 
             estimateTokens(JSON.stringify(toolBlock.input || {}))
    
    case 'tool_result':
      const resultBlock = block as any
      const content = typeof resultBlock.content === 'string'
        ? resultBlock.content
        : JSON.stringify(resultBlock.content || '')
      return estimateTokens(content)
    
    default:
      return 0
  }
}

/**
 * Estimate tokens for a participant message
 */
export function estimateMessageTokens(msg: ParticipantMessage): number {
  // Participant name contributes some tokens
  let tokens = estimateTokens(msg.participant + ':')
  
  // Add content blocks
  for (const block of msg.content) {
    tokens += estimateBlockTokens(block)
  }
  
  return tokens
}

/**
 * Estimate tokens for a list of messages
 */
export function estimateTotalTokens(messages: ParticipantMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

/**
 * Estimate tokens for a system prompt
 */
export function estimateSystemTokens(systemPrompt?: string): number {
  if (!systemPrompt) return 0
  return estimateTokens(systemPrompt)
}

/**
 * Get text content from a message for preview
 */
export function extractTextContent(msg: ParticipantMessage): string {
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text || '')
    .join(' ')
}

