import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logger } from '../utils/logger.js'
import { 
  Activation, 
  StoredActivation, 
  Completion, 
  ToolCall,
  ToolResult,
  MessageContext 
} from './types.js'

export class ActivationStore {
  private activationDir: string
  
  private activeActivations = new Map<string, Activation>()
  
  constructor(cacheDir: string) {
    this.activationDir = join(cacheDir, 'activations')
    if (!existsSync(this.activationDir)) {
      mkdirSync(this.activationDir, { recursive: true })
    }
  }
  
  startActivation(
    botId: string,
    channelId: string,
    trigger: Activation['trigger']
  ): Activation {
    const activation: Activation = {
      id: this.generateActivationId(),
      channelId,
      botId,
      trigger,
      completions: [],
      messageContexts: {},
      startedAt: new Date(),
    }
    
    this.activeActivations.set(activation.id, activation)
    
    logger.debug({ 
      activationId: activation.id, 
      botId, 
      channelId,
      triggerType: trigger.type,
      anchorMessageId: trigger.anchorMessageId
    }, 'Started activation')
    
    return activation
  }
  
  addCompletion(
    activationId: string,
    text: string,
    sentMessageIds: string[],
    toolCalls: ToolCall[] = [],
    toolResults: ToolResult[] = []
  ): Completion {
    const activation = this.activeActivations.get(activationId)
    if (!activation) {
      throw new Error(`Activation ${activationId} not found or already completed`)
    }
    
    const completion: Completion = {
      index: activation.completions.length,
      text,
      sentMessageIds,
      toolCalls,
      toolResults,
    }
    
    activation.completions.push(completion)
    
    logger.debug({
      activationId,
      completionIndex: completion.index,
      isPhantom: sentMessageIds.length === 0,
      hasTools: toolCalls.length > 0,
      textLength: text.length,
    }, 'Added completion to activation')
    
    return completion
  }
  
  updateLastCompletionMessageIds(activationId: string, messageIds: string[]): void {
    const activation = this.activeActivations.get(activationId)
    if (!activation || activation.completions.length === 0) {
      return
    }
    
    const lastCompletion = activation.completions[activation.completions.length - 1]!
    lastCompletion.sentMessageIds = messageIds
    
    logger.debug({
      activationId,
      completionIndex: lastCompletion.index,
      messageIds,
    }, 'Updated completion message IDs')
  }
  
  setMessageContext(activationId: string, messageId: string, context: MessageContext): void {
    const activation = this.activeActivations.get(activationId)
    if (!activation) {
      logger.warn({ activationId, messageId }, 'Tried to set message context for unknown activation')
      return
    }
    
    activation.messageContexts[messageId] = context
    
    logger.debug({
      activationId,
      messageId,
      prefixLength: context.prefix.length,
      suffixLength: context.suffix?.length ?? 0,
      hasToolXml: context.prefix.includes('function_calls') || (context.suffix?.includes('function_calls') ?? false),
    }, 'Set message context')
  }
  
  setMessageContexts(activationId: string, contexts: Record<string, MessageContext>): void {
    const activation = this.activeActivations.get(activationId)
    if (!activation) {
      logger.warn({ activationId }, 'Tried to set message contexts for unknown activation')
      return
    }
    
    for (const [messageId, context] of Object.entries(contexts)) {
      activation.messageContexts[messageId] = context
    }
    
    logger.debug({
      activationId,
      messageCount: Object.keys(contexts).length,
    }, 'Set multiple message contexts')
  }
  
  
  async completeActivation(activationId: string): Promise<void> {
    const activation = this.activeActivations.get(activationId)
    if (!activation) {
      logger.warn({ activationId }, 'Tried to complete unknown activation')
      return
    }
    
    activation.endedAt = new Date()
    
    await this.persistActivation(activation)
    
    this.activeActivations.delete(activationId)
    
    logger.debug({
      activationId,
      completionCount: activation.completions.length,
      phantomCount: activation.completions.filter(c => c.sentMessageIds.length === 0).length,
    }, 'Completed and persisted activation')
  }
  
  getActiveActivation(activationId: string): Activation | undefined {
    return this.activeActivations.get(activationId)
  }
  
  async loadActivationsForChannel(
    botId: string,
    channelId: string,
    existingMessageIds: Set<string>
  ): Promise<Activation[]> {
    const dirPath = join(this.activationDir, botId, channelId)
    
    if (!existsSync(dirPath)) {
      return []
    }
    
    const files = readdirSync(dirPath).filter(f => f.endsWith('.json')).sort()
    const activations: Activation[] = []
    let filteredCount = 0
    
    for (const file of files) {
      const filePath = join(dirPath, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const stored: StoredActivation = JSON.parse(content)
        
        const allSentIds = stored.completions.flatMap(c => c.sentMessageIds)
        const hasAnchor = allSentIds.some(id => existingMessageIds.has(id))
        
        if (!hasAnchor && allSentIds.length > 0) {
          filteredCount++
          continue
        }
        
        const messageContexts: Record<string, MessageContext> = {}
        if (stored.messageContexts) {
          for (const [msgId, ctx] of Object.entries(stored.messageContexts)) {
            if (typeof ctx === 'string') {
              messageContexts[msgId] = { prefix: ctx }
            } else {
              messageContexts[msgId] = ctx as MessageContext
            }
          }
        }
        
        activations.push({
          ...stored,
          messageContexts,
          startedAt: new Date(stored.startedAt),
          endedAt: stored.endedAt ? new Date(stored.endedAt) : undefined,
        })
      } catch (error) {
        logger.warn({ error, file: filePath }, 'Failed to load activation file')
      }
    }
    
    logger.debug({
      botId,
      channelId,
      loaded: activations.length,
      filtered: filteredCount,
    }, 'Loaded activations for channel')
    
    return activations
  }
  
  buildCompletionMap(activations: Activation[]): Map<string, { activation: Activation; completion: Completion }> {
    const map = new Map<string, { activation: Activation; completion: Completion }>()
    
    for (const activation of activations) {
      for (const completion of activation.completions) {
        for (const messageId of completion.sentMessageIds) {
          map.set(messageId, { activation, completion })
        }
      }
    }
    
    return map
  }
  
  buildMessageContextMap(activations: Activation[]): Map<string, MessageContext> {
    const map = new Map<string, MessageContext>()
    
    for (const activation of activations) {
      for (const [messageId, context] of Object.entries(activation.messageContexts)) {
        if (typeof context === 'string') {
          map.set(messageId, { prefix: context })
        } else {
          map.set(messageId, context)
        }
      }
    }
    
    return map
  }
  
  getPhantomInsertions(
    activations: Activation[],
    existingMessageIds: Set<string>
  ): Map<string, Completion[]> {
    const insertions = new Map<string, Completion[]>()
    
    for (const activation of activations) {
      let currentAnchor = activation.trigger.anchorMessageId
      
      for (const completion of activation.completions) {
        if (completion.sentMessageIds.length === 0) {
          const existing = insertions.get(currentAnchor) || []
          existing.push(completion)
          insertions.set(currentAnchor, existing)
        } else {
          for (const msgId of completion.sentMessageIds) {
            if (existingMessageIds.has(msgId)) {
              currentAnchor = msgId
            }
          }
        }
      }
    }
    
    return insertions
  }
  
  async removeActivationsForMessage(botId: string, channelId: string, messageId: string): Promise<void> {
    const dirPath = join(this.activationDir, botId, channelId)
    
    if (!existsSync(dirPath)) {
      return
    }
    
    const fs = await import('fs/promises')
    const files = readdirSync(dirPath).filter(f => f.endsWith('.json'))
    
    for (const file of files) {
      const filePath = join(dirPath, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const stored: StoredActivation = JSON.parse(content)
        
        const hasMsgId = stored.completions.some(c => 
          c.sentMessageIds.includes(messageId)
        )
        
        if (hasMsgId) {
          let modified = false
          for (const completion of stored.completions) {
            const idx = completion.sentMessageIds.indexOf(messageId)
            if (idx !== -1) {
              completion.sentMessageIds.splice(idx, 1)
              modified = true
            }
          }
          
          const allSentIds = stored.completions.flatMap(c => c.sentMessageIds)
          if (allSentIds.length === 0) {
            await fs.unlink(filePath)
            logger.debug({ filePath, messageId }, 'Deleted orphaned activation file')
          } else if (modified) {
            writeFileSync(filePath, JSON.stringify(stored, null, 2))
            logger.debug({ filePath, messageId }, 'Updated activation file after message deletion')
          }
        }
      } catch (error) {
        logger.warn({ error, file: filePath }, 'Failed to process activation file during deletion')
      }
    }
  }
  
  private generateActivationId(): string {
    return Math.random().toString(36).substring(2, 10)
  }
  
  private async persistActivation(activation: Activation): Promise<void> {
    const dirPath = join(this.activationDir, activation.botId, activation.channelId)
    
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }
    
    const dateStr = activation.startedAt.toISOString().replace(/[:.]/g, '-')
    const fileName = `${dateStr}-${activation.id}.json`
    const filePath = join(dirPath, fileName)
    
    const stored: StoredActivation = {
      ...activation,
      startedAt: activation.startedAt.toISOString(),
      endedAt: activation.endedAt?.toISOString(),
    }
    
    writeFileSync(filePath, JSON.stringify(stored, null, 2))
    
    logger.debug({ filePath, activationId: activation.id }, 'Persisted activation')
  }
}

