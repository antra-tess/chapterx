export type TriggerType = 'message' | 'mention' | 'reply' | 'timer' | 'api' | 'random'

export interface ActivationTrigger {
  type: TriggerType
  anchorMessageId: string
}

export interface ToolCall {
  id: string
  name: string
  input: any
}

export interface ToolResult {
  callId: string
  output: any
  error?: string
}

export interface Completion {
  index: number
  
  text: string
  
  sentMessageIds: string[]
  
  toolCalls: ToolCall[]
  
  toolResults: ToolResult[]
}

export interface MessageContext {
  prefix: string
  suffix?: string
  bridgeOpen?: string
  bridgeClose?: string
}

export interface Activation {
  id: string
  channelId: string
  botId: string
  
  trigger: ActivationTrigger
  
  completions: Completion[]
  
  messageContexts: Record<string, MessageContext>
  
  startedAt: Date
  
  endedAt?: Date
}

export interface StoredActivation {
  id: string
  channelId: string
  botId: string
  trigger: ActivationTrigger
  completions: Completion[]
  messageContexts: Record<string, MessageContext>
  startedAt: string
  endedAt?: string
}

export interface ActivationIndexEntry {
  id: string
  channelId: string
  botId: string
  triggerType: TriggerType
  anchorMessageId: string
  sentMessageIds: string[]
  startedAt: string
}

