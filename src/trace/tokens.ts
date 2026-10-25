import { ContentBlock, ParticipantMessage } from '../types.js'

const ESTIMATED_IMAGE_TOKENS = 1000

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

export function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens((block as any).text || '')
    
    case 'image':
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

export function estimateMessageTokens(msg: ParticipantMessage): number {
  let tokens = estimateTokens(msg.participant + ':')
  
  for (const block of msg.content) {
    tokens += estimateBlockTokens(block)
  }
  
  return tokens
}

export function estimateTotalTokens(messages: ParticipantMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

export function estimateSystemTokens(systemPrompt?: string): number {
  if (!systemPrompt) return 0
  return estimateTokens(systemPrompt)
}

export function extractTextContent(msg: ParticipantMessage): string {
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text || '')
    .join(' ')
}

