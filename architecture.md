# Chapter3 Architecture

## Overview

Chapter3 is a Discord chat bot framework built in TypeScript, designed as a replacement for chapter2. It implements a sophisticated context management system with support for multiple LLM providers, MCP tool integration, and advanced Discord features like history commands and rolling context.

### Core Principles

1. **Async Discord, Sync Agent Loop**: Discord I/O is asynchronous, but the agent loop processes events synchronously in batches
2. **Stateless Services**: Most components are stateless and called by the orchestrator
3. **Clear Separation of Concerns**: Each component has a single, well-defined responsibility
4. **Provider Agnostic**: LLM middleware abstracts provider specifics
5. **Extensible**: Easy to add new providers, tools, and features

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                      Discord Platform                           │
└─────────────────────────┬──────────────────────────────────────┘
                          │
                          │ WebSocket Events / REST API
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │      Discord Connector              │
        │  - WebSocket event handling         │
        │  - Message history fetching         │
        │  - .history command parsing         │
        │  - Pinned message scanning          │
        │  - Image caching                    │
        │  - Typing indicators                │
        └────────┬────────────────────────────┘
                 │                      ▲
                 │ push events          │ call methods
                 ▼                      │
            ┌─────────┐                 │
            │  Queue  │                 │
            └────┬────┘                 │
                 │ poll batches         │
                 ▼                      │
        ┌────────────────────────────────────────┐
        │         Agent Loop                     │
        │  (Orchestrator)                        │
        │  - Poll queue for event batches       │
        │  - Decide if activation needed        │
        │  - Coordinate all components          │
        │  - Handle tool execution loops        │
        └────┬──────┬─────────┬─────────────────┘
             │      │         │
             │      │         │
             ▼      ▼         ▼
        ┌────────────────────────────────────────┐
        │  Stateless Services                    │
        │                                        │
        │  ┌──────────────────────────────────┐ │
        │  │  Channel State Manager           │ │
        │  │  - Tool use cache per channel    │ │
        │  │  - Cache marker positions        │ │
        │  │  - Messages since last roll      │ │
        │  └──────────────────────────────────┘ │
        │                                        │
        │  ┌──────────────────────────────────┐ │
        │  │  Config System                   │ │
        │  │  - YAML file loading             │ │
        │  │  - Config hierarchy merging      │ │
        │  │  - Validation                    │ │
        │  └──────────────────────────────────┘ │
        │                                        │
        │  ┌──────────────────────────────────┐ │
        │  │  Context Builder                 │ │
        │  │  - Transform Discord → LLM msgs  │ │
        │  │  - Merge consecutive bot msgs    │ │
        │  │  - Filter dot messages           │ │
        │  │  - Rolling context truncation    │ │
        │  │  - Cache marker placement        │ │
        │  └──────────────────────────────────┘ │
        │                                        │
        │  ┌──────────────────────────────────┐ │
        │  │  LLM Middleware                  │ │
        │  │  - Provider routing              │ │
        │  │  - Prefill/chat transformation   │ │
        │  │  - Retry logic                   │ │
        │  │  - Ephemeral message injection   │ │
        │  └──────────────────────────────────┘ │
        │                                        │
        │  ┌──────────────────────────────────┐ │
        │  │  Tool System                     │ │
        │  │  - MCP client wrapper            │ │
        │  │  - Tool call parsing (prefill)   │ │
        │  │  - JSONL persistence             │ │
        │  │  - Cache loading                 │ │
        │  └──────────────────────────────────┘ │
        └────────────────────────────────────────┘
```

## Component Responsibilities

### 1. Discord Connector

**Role**: Discord domain expert - handles all Discord API interactions

**Responsibilities**:
- Maintain WebSocket connection to Discord Gateway
- Receive events (messages, reactions, edits, etc.) and push to queue
- Fetch message history when requested
- Parse and follow `.history` commands (traverse Discord message URLs)
- Scan pinned messages for `.config` commands
- Cache images from Discord attachments (disk-based with eviction)
- Send messages and webhooks back to Discord
- Split messages exceeding 1800 characters before sending
- Manage typing indicators (with 8-second refresh)
- Handle exponential backoff for Discord API rate limits
- Delete messages (m commands)

**What it does NOT do**:
- Understand LLM formats
- Make decisions about when to activate
- Process or transform messages
- Know about tools or config merging

**Key Interface**:
```typescript
class DiscordConnector {
  constructor(queue: EventQueue, options: ConnectorOptions)
  
  // Lifecycle
  async start(): Promise<void>
  
  // Fetching (called by Agent Loop)
  async fetchContext(params: {
    channelId: string,
    depth: number,          // Max messages (default 400) or characters
    authorizedRoles?: string[]
  }): Promise<{
    messages: DiscordMessage[],
    pinnedConfigs: string[],
    images: CachedImage[],
    guildId: string
  }>
  
  // Sending (called by Agent Loop)
  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<void>  // Auto-splits if > 1800 chars
  async sendWebhook(webhookUrl: string, content: string, username: string): Promise<void>
  async startTyping(channelId: string): Promise<void>
  async stopTyping(channelId: string): Promise<void>
  async deleteMessage(channelId: string, messageId: string): Promise<void>
}
```

**Image Caching**:
- Disk-based cache in `cache/images/`
- In-memory index for fast lookups
- Eviction: Time-based (24h) + size-based (500MB)
- Cache key: Image URL hash

**Typing Indicator Management**:
- Discord typing expires after 10s
- Refresh every 8s while active
- Track active typing per channel
- Clean up on stopTyping or error

### 2. Event Queue

**Role**: Simple buffer between Discord Connector and Agent Loop

**Responsibilities**:
- Buffer events from Discord Connector
- Provide batching interface (return all Discord events until a non-Discord event)
- Thread-safe push/poll operations

**Interface**:
```typescript
class EventQueue {
  push(event: Event): void  // Thread-safe
  pollBatch(): Event[]      // Returns all consecutive Discord events
  isEmpty(): boolean
}

interface Event {
  type: 'message' | 'reaction' | 'edit' | 'delete' | 'self_activation' | 'timer' | 'internal'
  channelId: string
  guildId: string
  data: any
  timestamp: Date
}
```

### 3. Agent Loop

**Role**: The orchestrator - coordinates all components and manages control flow

**Responsibilities**:
- Poll queue for event batches
- **Decide if bot activation is needed** (mentioned? replied to? m command?)
- **Decide if LLM call is needed** (or just acknowledge/react)
- Fetch Discord context via Connector
- Load/update channel state via State Manager
- Load configuration via Config System
- Build LLM context via Context Builder
- Call LLM via Middleware
- Parse responses for tool use
- **Loop tool execution** until no tools detected or max depth reached
- Send responses via Discord Connector
- Handle errors and retries at orchestration level

**What it does NOT do**:
- Understand Discord API details
- Know LLM provider specifics
- Build context itself
- Execute tools directly

**Key Interface**:
```typescript
class AgentLoop {
  constructor(
    private botId: string,
    private queue: EventQueue,
    private connector: DiscordConnector,
    private stateManager: ChannelStateManager,
    private configSystem: ConfigSystem,
    private contextBuilder: ContextBuilder,
    private llmMiddleware: LLMMiddleware,
    private toolSystem: ToolSystem
  )
  
  async run(): Promise<void> {
    while (true) {
      try {
        const batch = this.queue.pollBatch()
        if (batch.length > 0) {
          await this.processBatch(batch)
        } else {
          await sleep(100) // Avoid busy-waiting
        }
      } catch (error) {
        this.handleError(error)
      }
    }
  }
  
  private async processBatch(events: Event[]): Promise<void>
  private shouldActivate(events: Event[]): boolean
  private async handleActivation(events: Event[]): Promise<void>
  private async executeToolLoop(context: Context, config: BotConfig): Promise<Completion>
}
```

### 4. Channel State Manager

**Role**: Manages per-channel state (tool cache, cache markers)

**Responsibilities**:
- Track tool use cache per channel (in-memory)
- Track last prompt cache marker position per channel
- Track messages since last rolling context truncation
- Load tool cache from JSONL on first access
- Provide state updates (immutable pattern preferred)
- Prune old tool calls from cache

**Interface**:
```typescript
class ChannelStateManager {
  constructor(private toolSystem: ToolSystem)
  
  async getOrInitialize(botId: string, channelId: string): Promise<ChannelState>
  
  updateToolCache(botId: string, channelId: string, newCalls: ToolCall[]): void
  
  pruneToolCache(botId: string, channelId: string, oldestMessageId: string): void
  
  updateCacheMarker(botId: string, channelId: string, marker: string): void
  
  incrementMessageCount(botId: string, channelId: string): void
  
  resetMessageCount(botId: string, channelId: string): void
}

interface ChannelState {
  toolCache: ToolCall[]
  lastCacheMarker: string | null
  messagesSinceRoll: number
}
```

### 5. Config System

**Role**: Loads and merges configuration from multiple sources

**Responsibilities**:
- Load YAML files from disk (shared, guild, bot, bot-guild)
- Parse channel configs from pinned message strings (provided by Connector)
- Merge configs in priority order (line 94-99 in requirements)
- Validate final config against schema
- Return merged config for a specific bot/guild/channel

**What it does NOT do**:
- Fetch configs from Discord (Connector does that)
- Store config state
- Know about Discord API

**Interface**:
```typescript
class ConfigSystem {
  constructor(private configBasePath: string)
  
  loadConfig(params: {
    botName: string,
    guildId: string,
    channelConfigs: string[]  // Raw YAML strings from Connector
  }): BotConfig
  
  private loadSharedConfig(): Partial<BotConfig>
  private loadGuildConfig(guildId: string): Partial<BotConfig>
  private loadBotConfig(botName: string): Partial<BotConfig>
  private loadBotGuildConfig(botName: string, guildId: string): Partial<BotConfig>
  private parseChannelConfig(yamlString: string): Partial<BotConfig>
  private mergeConfigs(configs: Partial<BotConfig>[]): BotConfig
  private validateConfig(config: BotConfig): void
}

interface BotConfig {
  name: string  // Name used in LLM context
  
  // Model config
  mode: 'prefill' | 'chat'
  continuation_model: string
  temperature: number
  max_tokens: number
  top_p: number
  
  // Context config
  recency_window_messages: number  // Max messages
  recency_window_characters: number  // Max characters
  rolling_threshold: number  // Messages before truncation
  
  // Image config
  include_images: boolean
  max_images: number
  
  // Tool config
  tools_enabled: boolean
  tool_output_visible: boolean
  max_tool_depth: number
  
  // Stop sequences
  stop_sequences: string[]
  
  // Retries
  llm_retries: number
  discord_backoff_max: number
  
  // Misc
  reply_on_random: number
  reply_on_name: boolean
  max_queued_replies: number
}
```

### 6. Context Builder

**Role**: Transform Discord data into normalized multi-participant format

**Responsibilities**:
- Take raw Discord messages and transform to participant-based format
- Merge consecutive bot messages (with space separator)
- Filter dot messages (unless they're commands)
- Filter messages with dotted_face emoji (🙃)
- Incorporate tool use from cache
- Apply rolling context truncation (based on messagesSinceRoll, at message boundaries)
- Determine and place prompt cache markers
- Handle image inclusion (max_images limit)
- Build stop sequences from participant names (for prefill)
- Return **participant-based format** (NOT provider-specific, NOT role-based)

**What it does NOT do**:
- Fetch messages from Discord (Connector does that)
- Know about provider-specific formats (Middleware does that)
- Know about user/assistant roles (Middleware handles that)
- Execute tools
- Make decisions about activation

**Interface**:
```typescript
class ContextBuilder {
  buildContext(params: {
    messages: DiscordMessage[],
    toolCache: ToolCall[],
    images: CachedImage[],
    lastCacheMarker: string | null,
    messagesSinceRoll: number,
    config: BotConfig
  }): LLMRequest
  
  private mergeConsecutiveBotMessages(messages: DiscordMessage[]): DiscordMessage[]
  private filterDotMessages(messages: DiscordMessage[]): DiscordMessage[]
  private applyRollingTruncation(messages: DiscordMessage[], config: BotConfig): DiscordMessage[]  // Removes complete messages only
  private determineCacheMarker(messages: DiscordMessage[], lastMarker: string | null): string
  private formatMessages(messages: DiscordMessage[], config: BotConfig): ParticipantMessage[]
  private formatToolUse(toolCache: ToolCall[], botName: string): ParticipantMessage[]
  private includeImages(images: CachedImage[], config: BotConfig): CachedImage[]
  private buildStopSequences(participants: Set<string>, config: BotConfig): string[]
  private parseContent(message: DiscordMessage): ContentBlock[]
}

// Normalized multi-participant format
interface LLMRequest {
  messages: ParticipantMessage[]
  systemPrompt?: string
  config: ModelConfig
  tools?: ToolDefinition[]
  stopSequences?: string[]
}

interface ParticipantMessage {
  participant: string  // "Alice", "Bob", "Claude", etc.
  content: ContentBlock[]
  timestamp?: Date
  messageId?: string  // Discord message ID (for cache markers)
  cacheControl?: CacheControl
}

type ContentBlock = 
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent

interface TextContent {
  type: 'text'
  text: string
}

interface ImageContent {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    data: string
    mediaType: string
  }
}

interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

interface ToolResultContent {
  type: 'tool_result'
  toolUseId: string
  content: string | ContentBlock[]
  isError?: boolean
}

interface CacheControl {
  type: 'ephemeral'
}

interface ModelConfig {
  model: string
  temperature: number
  maxTokens: number
  topP: number
  mode: 'prefill' | 'chat'
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
}
```

### 7. LLM Middleware

**Role**: Transform participant-based format to provider-specific formats and handle completions

**Responsibilities**:
- Route requests to correct provider (Anthropic, Bedrock, OpenAI, Google)
- **Transform participant-based format to provider-specific format**
- **Transform to prefill or chat mode** (based on config)
  - **Prefill**: Convert to colon format (`"Alice: text\n\nBob: text\n\nClaude:"`)
  - **Chat**: Map participants to user/assistant roles
- Add ephemeral tool descriptions (for prefill mode)
- Handle retries with configurable count
- Parse completions and return structured response
- Handle streaming (optional)

**What it does NOT do**:
- Know about Discord
- Manage context/history
- Execute tools
- Cache anything

**Interface**:
```typescript
class LLMMiddleware {
  constructor(private providers: Map<string, LLMProvider>)
  
  async complete(request: LLMRequest): Promise<LLMCompletion>
  
  private selectProvider(modelName: string): LLMProvider
  private transformToPrefill(request: LLMRequest, provider: LLMProvider): ProviderRequest
  private transformToChat(request: LLMRequest, provider: LLMProvider): ProviderRequest
  private formatToolsForPrefill(tools: ToolDefinition[]): string
  private mergeParticipantsToUserMessage(messages: ParticipantMessage[]): ProviderMessage
  private getBotNames(config: ModelConfig): string[]
  private retryWithBackoff<T>(fn: () => Promise<T>, retries: number): Promise<T>
}

interface LLMCompletion {
  content: ContentBlock[]  // May contain text and tool_use blocks
  stopReason: StopReason
  usage: UsageInfo
  model: string
  raw?: any  // Optional: raw provider response for debugging
}

type StopReason = 
  | 'end_turn'      // Natural completion
  | 'max_tokens'    // Hit token limit
  | 'stop_sequence' // Hit stop sequence
  | 'tool_use'      // Stopped for tool use

interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

interface LLMProvider {
  readonly name: string
  readonly supportedModes: ('prefill' | 'chat')[]
  
  async complete(request: ProviderRequest): Promise<LLMCompletion>
  transformFromNormalized(request: LLMRequest): ProviderRequest
  parseToNormalized(response: ProviderResponse): LLMCompletion
}
```

**Transformation Examples**:

**Prefill Mode Transform**:
```typescript
// Input: ParticipantMessage[]
[
  { participant: "Alice", content: [{ type: "text", text: "Hello" }] },
  { participant: "Bob", content: [{ type: "text", text: "Hi" }] },
  { participant: "Claude", content: [{ type: "text", text: "" }] }
]

// Output: Provider format (Anthropic)
[
  { role: "user", content: "<cmd>cat untitled.txt</cmd>" },
  { role: "assistant", content: "Alice: Hello\n\nBob: Hi\n\nClaude:" }
]
```

**Chat Mode Transform**:
```typescript
// Input: ParticipantMessage[]
[
  { participant: "Alice", content: [{ type: "text", text: "Hello" }] },
  { participant: "Claude", content: [{ type: "text", text: "Hi there!" }] },
  { participant: "Bob", content: [{ type: "text", text: "Thanks" }] },
  { participant: "Claude", content: [{ type: "text", text: "" }] }
]

// Output: Provider format (grouped by bot/non-bot)
[
  { role: "user", content: "Alice: Hello" },
  { role: "assistant", content: "Hi there!" },
  { role: "user", content: "Bob: Thanks" },
  { role: "assistant", content: "" }
]
```

**Providers**:
- `AnthropicProvider`: Direct Anthropic API
- `BedrockProvider`: Anthropic via AWS Bedrock
- `OpenAIProvider`: OpenAI-compatible API with custom fields
- `GoogleProvider`: Google Gemini API

### 8. Tool System

**Role**: Manage MCP tools and tool execution

**Responsibilities**:
- Wrap MCP SDK client
- Parse tool calls from completion text (for prefill mode)
- Execute tools via MCP
- Persist tool calls and results to JSONL files
- Load tool cache from JSONL on startup (called by State Manager)
- Provide list of available tools to LLM Middleware
- Format tool results for inclusion in context

**What it does NOT do**:
- Know about Discord
- Make decisions about when to call tools
- Know about LLM formats (Context Builder handles that)

**Interface**:
```typescript
class ToolSystem {
  constructor(
    private mcpClient: MCPClient,
    private toolCacheDir: string
  )
  
  async initialize(): Promise<void>
  
  async getAvailableTools(): Promise<Tool[]>
  
  async loadCache(botId: string, channelId: string): Promise<ToolCall[]>
  
  parseToolCalls(completion: string): ToolCall[]
  
  async executeTool(call: ToolCall): Promise<ToolResult>
  
  async persistToolUse(
    botId: string,
    channelId: string,
    call: ToolCall,
    result: ToolResult
  ): Promise<void>
}

interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
}

interface ToolCall {
  id: string
  name: string
  input: any
  messageId: string  // For pruning old calls
}

interface ToolResult {
  callId: string
  output: any
  error?: string
}
```

**JSONL File Structure**:
- Path: `tools/{botId}/{channelId}/{YYYY-MM-DD-HH}.jsonl`
- One file per bot per channel per hour
- Files closed at hour boundary, new file created
- Old files kept indefinitely (could add cleanup later)
- Each line: `{"call": {...}, "result": {...}, "timestamp": "..."}`

## Normalized Multi-Participant API

### Design Rationale

Discord conversations are inherently **multi-participant** - Alice, Bob, and Claude all participate equally. The internal API reflects this reality rather than imposing artificial "user" vs "assistant" roles.

**Context Builder** outputs participant-based format (honest representation of Discord).
**LLM Middleware** transforms to provider-specific format (prefill colon format, or chat roles).

### Why This Matters

1. **Honest representation**: Discord has many participants, not just "user" and "assistant"
2. **Prefill is natural**: Colon format is the native representation
3. **Chat mode adapts**: Middleware handles the role mapping
4. **Easy to debug**: Participant format is human-readable
5. **No artificial decisions**: Context Builder doesn't need to guess who is "user" vs "assistant"

### Format Examples

#### Example 1: Simple Multi-Participant Conversation

**Discord:**
```
Alice: Hey Claude, what's the weather?
Bob: Yeah I want to know too
Claude: 
```

**Context Builder Output (Normalized):**
```typescript
{
  messages: [
    {
      participant: 'Alice',
      content: [{ type: 'text', text: "Hey Claude, what's the weather?" }],
      messageId: '001'
    },
    {
      participant: 'Bob',
      content: [{ type: 'text', text: 'Yeah I want to know too' }],
      messageId: '002'
    },
    {
      participant: 'Claude',
      content: [{ type: 'text', text: '' }]  // Completion target
    }
  ],
  stopSequences: ['Alice:', 'Bob:', 'Claude:'],
  config: { mode: 'prefill', model: 'claude-3-5-sonnet-20241022', ... }
}
```

**LLM Middleware → Prefill Transform:**
```typescript
[
  { role: 'user', content: '<cmd>cat untitled.txt</cmd>' },
  { 
    role: 'assistant', 
    content: "Alice: Hey Claude, what's the weather?\n\nBob: Yeah I want to know too\n\nClaude:"
  }
]
```

**LLM Middleware → Chat Transform:**
```typescript
[
  { 
    role: 'user', 
    content: "Alice: Hey Claude, what's the weather?\nBob: Yeah I want to know too"
  },
  { role: 'assistant', content: '' }
]
```

#### Example 2: With Images and Cache Marker

**Discord:**
```
Alice: Check out this photo [image]
Bob: Nice!
Claude: That's a beautiful sunset!
Alice: Can you describe it in detail?
Claude:
```

**Context Builder Output:**
```typescript
{
  messages: [
    {
      participant: 'Alice',
      content: [
        { type: 'text', text: 'Check out this photo' },
        { 
          type: 'image',
          source: { type: 'base64', data: '...', mediaType: 'image/jpeg' }
        }
      ],
      messageId: '001',
      cacheControl: { type: 'ephemeral' }  // Cache marker
    },
    {
      participant: 'Bob',
      content: [{ type: 'text', text: 'Nice!' }],
      messageId: '002'
    },
    {
      participant: 'Claude',
      content: [{ type: 'text', text: "That's a beautiful sunset!" }],
      messageId: '003'
    },
    {
      participant: 'Alice',
      content: [{ type: 'text', text: 'Can you describe it in detail?' }],
      messageId: '004'
    },
    {
      participant: 'Claude',
      content: [{ type: 'text', text: '' }]
    }
  ],
  config: { mode: 'prefill', ... }
}
```

**LLM Middleware → Prefill Transform:**
```typescript
[
  { role: 'user', content: '<cmd>cat untitled.txt</cmd>' },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Alice: Check out this photo',
        cache_control: { type: 'ephemeral' }  // Marker attached here
      },
      {
        type: 'image',
        source: { type: 'base64', data: '...', media_type: 'image/jpeg' }
      }
    ]
  },
  {
    role: 'assistant',
    content: "Bob: Nice!\n\nClaude: That's a beautiful sunset!\n\nAlice: Can you describe it in detail?\n\nClaude:"
  }
]
```

#### Example 3: With Tool Use

**Discord:**
```
Alice: What time is it in Tokyo?
Claude: [uses get_time tool]
[tool result: 14:30 JST]
Claude:
```

**Context Builder Output:**
```typescript
{
  messages: [
    {
      participant: 'Alice',
      content: [{ type: 'text', text: 'What time is it in Tokyo?' }]
    },
    {
      participant: 'Claude',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_time',
          input: { timezone: 'Asia/Tokyo' }
        }
      ]
    },
    {
      participant: 'Claude',  // Tool results attributed to bot
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          content: '14:30 JST'
        }
      ]
    },
    {
      participant: 'Claude',
      content: [{ type: 'text', text: '' }]
    }
  ],
  tools: [{ name: 'get_time', description: '...', inputSchema: {...} }],
  config: { mode: 'prefill', ... }
}
```

**LLM Middleware → Prefill Transform:**
```typescript
[
  { role: 'user', content: '<cmd>cat untitled.txt</cmd>' },
  { 
    role: 'user',
    content: '<tools>\n- get_time: Get current time...\n</tools>'
  },
  {
    role: 'assistant',
    content: `Alice: What time is it in Tokyo?

Claude>[get_time]: {"timezone": "Asia/Tokyo"}

Claude<[get_time]: 14:30 JST

Claude:`
  }
]
```

**LLM Middleware → Chat Transform:**
```typescript
[
  { role: 'user', content: 'What time is it in Tokyo?' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_1', name: 'get_time', input: { timezone: 'Asia/Tokyo' } }
    ]
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: '14:30 JST' }
    ]
  },
  { role: 'assistant', content: '' }
]
```

### Key Implementation Details

**Stop Sequences in Prefill Mode:**
- Extract all unique participant names from messages
- Add colon suffix: `["Alice:", "Bob:", "Claude:"]`
- Prevents bot from speaking as other participants

**Consecutive Non-Bot Messages in Chat Mode:**
- Group consecutive human messages together
- Maintain participant names within grouped messages
- Example: `"Alice: Hello\nBob: Hi there"` becomes single user message

**Tool Results Attribution:**
- In normalized format, tool results are attributed to the bot participant
- In prefill format, rendered as `BotName<[tool_name]: result`
- In chat format, rendered as user message with tool_result content block

## Data Flow

### Complete Flow Example: User Mentions Bot

```
1. Discord → DiscordConnector
   MESSAGE_CREATE event received
   ├─→ Push to Queue
   
2. AgentLoop polls Queue
   ├─→ Receives batch of events
   ├─→ Sees bot mention
   └─→ Decides: activation needed

3. AgentLoop → DiscordConnector.startTyping()
   ├─→ Start typing indicator (refreshes every 8s)

4. AgentLoop → DiscordConnector.fetchContext()
   ├─→ Connector fetches 400 messages from Discord API
   ├─→ Finds .history command, validates role
   ├─→ Follows Discord URLs, fetches message ranges
   ├─→ Fetches pinned messages
   ├─→ Downloads and caches images
   └─→ Returns: {messages, pinnedConfigs, images, guildId}

5. AgentLoop → ConfigSystem.loadConfig()
   ├─→ Loads YAML files (shared, guild, bot, bot-guild)
   ├─→ Parses channel configs from strings
   ├─→ Merges in priority order
   └─→ Returns: BotConfig

6. AgentLoop → ChannelStateManager.getOrInitialize()
   ├─→ State Manager → ToolSystem.loadCache() (if first access)
   └─→ Returns: ChannelState {toolCache, lastCacheMarker, messagesSinceRoll}

7. AgentLoop → ContextBuilder.buildContext()
   ├─→ Merges consecutive bot messages (space separator)
   ├─→ Filters dot messages and dotted_face emoji
   ├─→ Formats tool use from cache as ParticipantMessage[]
   ├─→ Applies rolling truncation (if threshold reached)
   ├─→ Places cache marker
   ├─→ Includes images (up to max_images)
   ├─→ Builds stop sequences from participant names
   └─→ Returns: LLMRequest {messages: ParticipantMessage[], ...}

8. AgentLoop → ToolSystem.getAvailableTools()
   └─→ Returns: ToolDefinition[]

9. AgentLoop → LLMMiddleware.complete()
   ├─→ Receives LLMRequest with participant-based messages
   ├─→ Selects provider (Anthropic/Bedrock/OpenAI/Google)
   ├─→ Transforms participant format to provider format:
   │   ├─ Prefill mode: "Alice: text\n\nBob: text\n\nClaude:"
   │   └─ Chat mode: Maps participants to user/assistant roles
   ├─→ Adds ephemeral tool descriptions (prefill mode)
   ├─→ Calls provider API (with retries)
   └─→ Returns: LLMCompletion {content: ContentBlock[], ...}

10. IF toolCalls detected:
    ├─→ AgentLoop → ToolSystem.parseToolCalls()
    ├─→ FOR EACH tool call:
    │   ├─→ AgentLoop → ToolSystem.executeTool()
    │   ├─→ AgentLoop → ToolSystem.persistToolUse()
    │   └─→ AgentLoop → ChannelStateManager.updateToolCache()
    ├─→ AgentLoop → DiscordConnector.sendWebhook() (if tool output visible)
    ├─→ AgentLoop loops back to step 7 with tool results
    └─→ Repeat until no tools OR max depth reached

11. AgentLoop → DiscordConnector.stopTyping()

12. AgentLoop → DiscordConnector.sendMessage()
    ├─→ Connector splits if > 1800 chars
    └─→ Message(s) appear in Discord

13. AgentLoop → ChannelStateManager updates:
    ├─→ updateCacheMarker()
    └─→ incrementMessageCount() or resetMessageCount() (if rolled)

14. Loop continues, polls queue for next batch
```

## Technology Stack

### Core
- **Runtime**: Node.js 20+
- **Language**: TypeScript 5.3+
- **Package Manager**: npm or pnpm

### Primary Dependencies
- **discord.js** v14 - Discord API client
- **@modelcontextprotocol/sdk** - MCP client
- **@anthropic-ai/sdk** - Anthropic API
- **@aws-sdk/client-bedrock-runtime** - AWS Bedrock
- **openai** - OpenAI and compatible APIs
- **@google/generative-ai** - Google Gemini API

### Utilities
- **yaml** - YAML parsing
- **zod** - Runtime validation and config schema
- **pino** - Structured logging
- **ioredis** (optional) - For multi-process coordination later

### Development
- **tsx** - TypeScript execution
- **vitest** - Testing
- **prettier** - Code formatting
- **eslint** - Linting

## Project Structure

```
chapter3/
├── src/
│   ├── main.ts                     # Entry point
│   │
│   ├── discord/
│   │   ├── connector.ts            # Discord Connector
│   │   ├── message-parser.ts      # Parse Discord messages
│   │   ├── history-parser.ts      # .history command parsing
│   │   └── image-cache.ts         # Image caching logic
│   │
│   ├── agent/
│   │   ├── loop.ts                 # Agent Loop
│   │   ├── event-queue.ts         # Event Queue
│   │   └── state-manager.ts       # Channel State Manager
│   │
│   ├── config/
│   │   ├── system.ts               # Config System
│   │   ├── schema.ts               # Config schema (zod)
│   │   └── types.ts                # Config TypeScript types
│   │
│   ├── context/
│   │   ├── builder.ts              # Context Builder
│   │   ├── rolling.ts              # Rolling context logic
│   │   ├── cache-marker.ts        # Cache marker placement
│   │   └── message-formatter.ts   # Format messages
│   │
│   ├── llm/
│   │   ├── middleware.ts           # LLM Middleware
│   │   ├── prefill.ts              # Prefill mode transformer
│   │   ├── chat.ts                 # Chat mode transformer
│   │   └── providers/
│   │       ├── base.ts             # Provider interface
│   │       ├── anthropic.ts        # Anthropic provider
│   │       ├── bedrock.ts          # Bedrock provider
│   │       ├── openai.ts           # OpenAI provider
│   │       └── google.ts           # Google provider
│   │
│   ├── tools/
│   │   ├── system.ts               # Tool System
│   │   ├── parser.ts               # Parse tool calls from text
│   │   ├── persistence.ts          # JSONL persistence
│   │   └── mcp-client.ts           # MCP client wrapper
│   │
│   └── utils/
│       ├── logger.ts               # Logging
│       ├── retry.ts                # Retry with backoff
│       ├── errors.ts               # Error types
│       └── validation.ts           # Validation helpers
│
├── config/
│   ├── shared.yaml                 # Shared config
│   ├── guilds/
│   │   └── {guildId}.yaml          # Guild-specific configs
│   └── bots/
│       ├── {botName}.yaml          # Bot-specific configs
│       └── {botName}-{guildId}.yaml # Bot-guild configs
│
├── tools/                          # Tool use JSONL files
│   └── {botId}/
│       └── {channelId}/
│           └── {YYYY-MM-DD-HH}.jsonl
│
├── cache/
│   └── images/                     # Cached Discord images
│       └── {hash}.{ext}
│
├── logs/                           # Application logs
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── package.json
├── tsconfig.json
├── .eslintrc.js
├── .prettierrc
└── README.md
```

## Key Design Decisions

### 1. Why TypeScript?
- Strong typing for complex context transformations
- Excellent Discord.js library
- Mature MCP SDK
- Great async/await support
- Rich ecosystem

### 2. Why Participant-Based Internal API?
- **Honest representation**: Discord is multi-participant, not user/assistant
- **Prefill is natural**: Colon format (`"Alice: ...\n\nClaude:"`) is the native form
- **No artificial roles**: Context Builder doesn't need to decide who is "user" vs "assistant"
- **Easy to debug**: Participant format is human-readable
- **Extensible**: Easy to add more participant types (bots, system, etc.)
- **Provider agnostic**: LLM Middleware handles the role mapping for each provider

### 3. Why Separate Context Builder from LLM Middleware?
- Context Builder: Discord → participant format (domain translation)
- LLM Middleware: participant format → provider format (protocol translation)
- Allows testing context logic without LLM calls
- Clean separation of concerns
- Easy to add new providers without touching Context Builder

### 4. Why Channel State Manager?
- Centralizes per-channel state
- Easy to test state management separately
- Could add state persistence later
- Could add state cleanup/eviction
- Agent Loop stays focused on orchestration

### 5. Why Disk-based Image Cache?
- Images can be large (memory constraints)
- Persistent across restarts
- Easy to inspect and debug
- Can implement TTL and size limits

### 6. Why JSONL for Tool Use?
- Simple, debuggable format
- Easy to inspect with text tools
- Git-friendly (can version control)
- One file per hour = automatic time-based sharding
- No database setup required

### 7. Why Queue Between Connector and Agent?
- Decouples async Discord I/O from sync agent logic
- Natural batching point
- Easy to test agent in isolation
- Could add priority queuing later

## Configuration Examples

See `config_examples.md` for detailed configuration examples.

### Minimal Bot Config

```yaml
# config/bots/claude.yaml
name: Claude  # Name used in LLM context

mode: prefill
continuation_model: claude-3-5-sonnet-20241022
temperature: 1.0
max_tokens: 4096

recency_window_messages: 400
rolling_threshold: 50

include_images: true
max_images: 5

tools_enabled: true
tool_output_visible: false
max_tool_depth: 100

llm_retries: 3
discord_backoff_max: 32000
```

### Vendor Config

```yaml
# config/shared.yaml
vendors:
  anthropic:
    config:
      anthropic_api_key: "sk-ant-..."
    provides:
      - "claude-3-5-sonnet-20241022"
      - "claude-3-opus-20240229"
  
  aws-bedrock:
    config:
      aws_access_key: "AKIA..."
      aws_secret_key: "..."
      aws_region: "us-west-2"
    provides:
      - "anthropic\\.claude.*"
```

## Error Handling

### LLM Retries
- Configurable retry count per call
- No exponential backoff (same delay between retries)
- Log each retry attempt
- Return error to agent after exhausting retries

### Discord Retries
- Exponential backoff: 1s, 2s, 4s, 8s, ..., max
- Configurable max backoff (default 32s)
- Apply to all Discord API calls
- Log rate limit hits

### Agent Loop Error Handling
- Catch errors at batch processing level
- Log error with context
- Continue processing next batch
- Don't crash on single event failure
- Stop typing indicator on error

## Logging Strategy

### Structured Logging (pino)
```typescript
logger.info({
  component: 'AgentLoop',
  event: 'activation',
  botId: 'claude',
  channelId: '123',
  messageId: '456',
  activated: true
}, 'Bot activated by mention')
```

### Log Levels
- **ERROR**: Errors that prevent operation
- **WARN**: Recoverable issues (retries, rate limits)
- **INFO**: Key events (activations, completions, tool calls)
- **DEBUG**: Detailed flow (context building, config loading)
- **TRACE**: Full data dumps (messages, completions)

### Log Organization
- One log file per day
- Separate error log
- Rotate after 30 days (configurable)

## Testing Strategy

### Unit Tests
- Each component tested in isolation
- Mock dependencies
- Focus on business logic

### Integration Tests
- Test component interactions
- Mock Discord API and LLM APIs
- Test full flow without external services

### E2E Tests (Optional)
- Test against real Discord test server
- Use mock LLM responses
- Verify actual Discord messages

## Deployment

### Single Bot Process
```bash
BOT_NAME=claude node dist/main.js
```

### Multiple Bots (Different Processes)
```bash
# Terminal 1
BOT_NAME=claude node dist/main.js

# Terminal 2
BOT_NAME=opus node dist/main.js
```

### Process Management
- Use PM2 or systemd for production
- Each bot = separate process
- Auto-restart on crash
- Log aggregation

### Environment Variables
```bash
BOT_NAME=claude           # Required
CONFIG_PATH=./config      # Optional, default: ./config
TOOLS_PATH=./tools        # Optional, default: ./tools
CACHE_PATH=./cache        # Optional, default: ./cache
LOG_LEVEL=info            # Optional, default: info
```

## Performance Considerations

### Memory Usage
- Image cache: 500MB limit (configurable)
- Tool cache: ~1-10MB per active channel
- Message context: ~1-5MB per channel
- Total: ~500-1000MB per bot process

### Latency
- Discord message fetch: 100-500ms
- LLM completion: 2-10s (depends on model)
- Tool execution: Variable (100ms - 10s)
- Total activation time: 3-15s typical

### Scalability
- Single bot handles 10-50 active channels
- Each bot = separate process (horizontal scaling)
- No shared state between bots (except Discord)

## Future Extensions

### Potential Additions
1. **Memory System**: Episodic memory with vector store (discussed separately)
2. **Multi-bot Coordination**: Redis for cross-bot communication
3. **Metrics**: Prometheus metrics for monitoring
4. **Web Dashboard**: Optional web UI for config/monitoring
5. **Voice Support**: Discord voice channel integration
6. **Database**: PostgreSQL for long-term analytics (optional)

### Backward Compatibility
- Import chapter2 configs
- Migrate tool use history
- Support legacy command syntax

## Migration from Chapter2

### Key Improvements Over Chapter2
1. **Better architecture**: Clear component boundaries
2. **TypeScript**: Type safety and better tooling
3. **Modern MCP**: Official SDK support
4. **Better caching**: Prompt caching with rolling context
5. **Better config**: Hierarchical YAML with validation
6. **Better error handling**: Retries and exponential backoff
7. **Better testing**: Testable components

### Migration Steps
1. Set up chapter3 project structure
2. Migrate bot configs to new YAML format
3. Run both in parallel for testing
4. Gradually move bots to chapter3
5. Deprecate chapter2 after stable period

