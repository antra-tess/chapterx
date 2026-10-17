# ChapterX Context Architecture: Complete Reference

> Full map of how context is structured, how Discord messages are pulled/preprocessed/processed, and how hidden text is injected. Generated from source analysis of `chatperx` and `membrane` codebases.

---

## Table of Contents

1. [End-to-End Flow Overview](#1-end-to-end-flow-overview)
2. [Discord Message Fetching](#2-discord-message-fetching)
3. [Push-Based Message Cache](#3-push-based-message-cache)
4. [Message Conversion & Preprocessing](#4-message-conversion--preprocessing)
5. [Configuration System & Override Hierarchy](#5-configuration-system--override-hierarchy)
6. [Context Builder Pipeline](#6-context-builder-pipeline)
7. [Rolling Context & Truncation](#7-rolling-context--truncation)
8. [Cache Marker System](#8-cache-marker-system)
9. [Hidden Text Injection Points](#9-hidden-text-injection-points)
10. [Membrane Formatter Layer](#10-membrane-formatter-layer)
11. [Tool Integration & Invisible Content](#11-tool-integration--invisible-content)
12. [Stop Sequence Generation](#12-stop-sequence-generation)
13. [Data Types Reference](#13-data-types-reference)

---

## 1. End-to-End Flow Overview

```
Discord gateway event (messageCreate)
  |
  v
pushMessageToCache()                       [connector.ts]
EventQueue.push()
  |
  v
Agent Loop polls batch                     [loop.ts]
  |
  v
shouldActivate() check                     [loop.ts:950-1109]
  |  (mention? reply? random? m-command? timer?)
  v
SOMA credit check (if enabled)             [loop.ts:537-558]
  |
  v
handleActivation()                         [loop.ts:1111-1915]
  |
  +---> fetchContext()                      [connector.ts:293-638]
  |       |
  |       +---> fetchMessagesRecursive()    (batch fetch, .history processing)
  |       +---> thread parent context       (if thread)
  |       +---> cache stability extension   (extend to firstMessageId)
  |       +---> convertMessage()            (mentions, replies, oblique bridge)
  |       +---> fetchPinnedConfigs()        (pinned YAML configs)
  |       +---> image/document processing   (3-tier image cache, text attachments)
  |       |
  |       v
  |     DiscordContext { messages, pinnedConfigs, images, documents, inheritanceInfo }
  |
  +---> loadConfig()                        [system.ts]
  |       shared -> guild -> bot -> bot-guild -> pinned (override cascade)
  |
  +---> buildContext()                      [builder.ts:68-328]
  |       |
  |       +---> merge consecutive bot msgs  (step 1)
  |       +---> filter dot-commands         (step 2)
  |       +---> pre-calc cache marker       (step 3)
  |       +---> formatMessages()            (step 4: images, docs, mention normalization)
  |       +---> interleave tool cache       (step 5)
  |       +---> inject activations          (step 6: thinking traces)
  |       +---> inject plugins              (step 7: context injections)
  |       +---> merge consecutive same-participant (step 8)
  |       +---> applyLimits() / rolling     (step 9)
  |       +---> determine + apply cache marker (step 10)
  |       +---> add empty completion msg    (step 11)
  |       +---> build stop sequences        (step 12)
  |       |
  |       v
  |     LLMRequest { messages, system_prompt, context_prefix,
  |                  prefill_user_message, config, tools, stop_sequences }
  |
  +---> membrane.stream()                   [provider.ts -> membrane]
  |       |
  |       +---> getFormatterForModel()      (per-vendor formatter routing)
  |       +---> formatter.buildMessages()   (participant -> user/assistant roles)
  |       +---> provider.stream()           (Anthropic/OpenAI/Bedrock/Gemini API)
  |       |
  |       v
  |     Streaming response
  |
  +---> parseIntoSegments()                 [loop.ts:225-301]
  |       (split visible text from <thinking>, <function_calls>, etc.)
  |
  +---> sendSegments()                      [loop.ts:364-425]
  |       (send visible text to Discord, store invisible prefix/suffix associations)
  |
  +---> update channel state                [loop.ts:1785-1831]
          (cache marker, message count, oldest message ID)
```

---

## 2. Discord Message Fetching

### Entry Point: `fetchContext()` — `connector.ts:293-638`

**Parameters** (`FetchContextParams`):
| Param | Purpose |
|-------|---------|
| `channelId` | Channel to fetch from |
| `depth` | Max messages to fetch |
| `targetMessageId` | End point (fetch up to here) |
| `firstMessageId` | Cache stability anchor (extend backwards to include) |
| `authorized_roles` | Roles allowed to use .history |
| `pinnedConfigs` | Pre-fetched configs (skip API) |
| `maxImages` | Cap on image fetching |
| `ignoreHistory` | Skip .history processing |

**Returns** `DiscordContext`:
```typescript
{
  messages: DiscordMessage[]          // Chronological (oldest-first)
  pinnedConfigs: string[]             // YAML config strings from pinned messages
  images: CachedImage[]              // Processed images with tokens estimated
  documents: CachedDocument[]         // Text attachments (truncated to 200KB)
  guildId: string
  inheritanceInfo?: {
    parentChannelId?: string          // If thread
    historyOriginChannelId?: string   // Channel where .history was found
    historyDidClear?: boolean         // Whether .history clear was used
  }
}
```

### Recursive Fetch: `fetchMessagesRecursive()` — `connector.ts:684-964`

Fetches messages in batches going backwards, processing `.history` commands recursively.

**Critical ordering**: Discord API returns newest-first. After `Array.from(fetched.values()).reverse()`, messages are **OLDEST-first** within each batch. This has been a repeated source of bugs.

**`.history` command processing** (lines 777-916):

| `.history` variant | Behavior |
|-------------------|----------|
| Empty body (`.history\n---`) | **Clear**: Discard all older messages. Sets `didClear = true`. |
| With `first:` and `last:` URLs | **Range**: Recursively fetch from target channel between boundaries. |
| Targeting different bot | **Skip**: Ignored entirely. |

**Authorization**: `.history` commands checked against `authorized_roles` (lines 781-790).

### Thread Parent Context — `connector.ts:344-427`

If channel is a thread:
1. Fetch thread messages first
2. Fetch parent channel context with remaining budget
3. Prepend parent messages: `[...parentMessages, ...threadMessages]`
4. **Parent's `.history clear` does NOT affect thread's cache stability** (separate state)

### Cache Stability Extension — `connector.ts:429-534`

Extends fetch backwards to include `firstMessageId` (previous cache marker) if it's not already in the window.

- **24-hour sanity check**: Won't extend if gap > 24 hours (prevents feedback loops with truncation)
- **Additive only**: Never removes messages — "Cache stability should only add data, never remove it" (line 520)
- **500-message cap**: Maximum backward extension

---

## 3. Push-Based Message Cache

### Data Structures — `connector.ts:59-64`

```
messageCache:          Map<channelId, (Message | null)[]>     // chronological, nulls = tombstones
messageCacheIndex:     Map<channelId, Map<messageId, index>>  // O(1) lookups
messageCachePopulated: Set<channelId>                         // first-fetch tracking
pinnedConfigCache:     Map<channelId, string[]>               // cached pinned configs
pinnedConfigDirty:     Set<channelId>                         // invalidation flags
```

### Gateway Event Handlers — `connector.ts:2052-2126`

| Event | Action |
|-------|--------|
| `messageCreate` | `pushMessageToCache()` + queue event |
| `messageUpdate` | `updateMessageInCache()` + queue event |
| `messageDelete` | `removeMessageFromCache()` (tombstone) + queue event |
| `channelPinsUpdate` | Mark `pinnedConfigDirty` |
| `messageReactionAdd/Remove` | Update cache in-place |

### Cache Query Logic — `connector.ts:1860-1940`

- **Cache hit**: If `before` ID is within cached range, serve from cache
- **Cache miss**: API fetch, merge results into cache (prepend if extending backwards)
- **Eviction**: Every 5 minutes — compact tombstones, cap at 2000 messages per channel

**Performance**: Cold cache ~1.1s, warm cache ~70ms (pre-LLM overhead).

**Bypass**: `NO_MSG_CACHE=1` env var disables caching for debugging.

---

## 4. Message Conversion & Preprocessing

### `convertMessage()` — `connector.ts:2148-2206`

Converts `discord.js Message` to internal `DiscordMessage`:

1. **Mention conversion**: `<@USER_ID>` → `<@username>` (line 2150)
2. **Oblique bridge**: Extract real name from `displayname[oblique:...]` webhook format (lines 2134-2141)
3. **Reply handling**: Prepend `<reply:@targetname>` to content (lines 2164-2176)
   - If target not in message map: `<reply:@someone>` (fallback)
4. **Fields extracted**: `id, channelId, guildId, author{id, username, displayName, bot}, content, timestamp, attachments[], reactions[], mentions[], referencedMessage`

### Image Processing — `connector.ts:2304-2430`

Three-tier caching: in-memory → disk (SHA256) → Discord CDN download.

- Downscale to max 1568x1568 (Anthropic limit)
- Token estimate: `(width * height) / 750`
- Persistent URL→filename map survives restarts
- Format detection via magic bytes, not extension

### Text Attachments — `connector.ts:2481-2517`

- Detected by MIME type (`text/*`, `application/json`) or extension (`.txt`, `.py`, `.yaml`, etc.)
- Truncated to 200KB max (`max_text_attachment_kb` config)

---

## 5. Configuration System & Override Hierarchy

### Priority Order (lowest → highest) — `system.ts:30-56`

```
1. Code defaults (system.ts:213-345)
2. Shared config          /config/shared.yaml  (or EMS /config.yaml)
3. Guild config           /config/guilds/{guildId}.yaml
4. Bot config             /config/bots/{botName}.yaml  (or EMS /{botName}/config.yaml)
5. Bot-Guild config       /config/bots/{botName}-{guildId}.yaml  (or EMS /{botName}/guilds/{guildId}.yaml)
6. Channel pinned configs (multiple, applied in order — newest pin wins)
```

Pinned configs can target specific bots with `target: botname` field (case-insensitive match against botName or display name).

### File-Loaded Fields — `system.ts:213-257`

| Config field | File field | Purpose |
|-------------|-----------|---------|
| `system_prompt` | `system_prompt_file` | System instructions for LLM |
| `context_prefix` | `context_prefix_file` | First cached assistant message (simulacrum seeding) |
| `prefill_user_message` | `prefill_user_message_file` | Custom synthetic user message (replaces `[Start]`) |

### Key Defaults

| Setting | Default |
|---------|---------|
| `temperature` | 1.0 |
| `max_tokens` | 4096 |
| `rolling_threshold` | 50 |
| `recent_participant_count` | 10 |
| `max_images` | 5 |
| `max_text_attachment_kb` | 100 |
| `max_tool_depth` | 100 |
| `max_mcp_images` | 3 |
| `prompt_caching` | true |
| `participant_stop_sequences` | false |
| `max_bot_reply_chain_depth` | 2 |
| `hard_max_characters` | 500,000 |
| `recency_window_characters` | 100,000 |

---

## 6. Context Builder Pipeline

### Entry: `buildContext()` — `builder.ts:68-328`

**Input** (`BuildContextParams`):
```typescript
{
  discordContext: DiscordContext              // Raw Discord messages + images
  toolCacheWithResults: ToolCall[]           // Previous tool executions
  lastCacheMarker: string | null             // Where cache stopped last time
  messagesSinceRoll: number                  // Messages since last truncation
  config: BotConfig
  botDiscordUsername?: string                // Bot's actual Discord username
  activations?: Activation[]                 // Prior completions (preserve_thinking_context)
  pluginInjections?: ContextInjection[]      // Plugin-provided context insertions
}
```

### Step-by-Step Pipeline

**Step 1: Merge Consecutive Bot Messages** (line 82)
- Combines sequential bot messages into single turns
- Skipped if `preserve_thinking_context` enabled (needs message IDs for injection)
- Messages starting with `.` (dot commands) are NOT merged
- Bot identified by `botDisplayName` (Discord username), normalized to `config.name`

**Step 2: Filter Dot-Commands** (line 94)
- Removes messages starting with `.` + letter (`.config`, `.history`, etc.)
- Does NOT match ellipsis (`...` or `..`)
- Strips `<reply:@username>` prefix before checking
- Also filters messages with `🫥` (dotted_line_face) reaction

**Step 3: Pre-calculate Cache Marker for Image Selection** (lines 107-125)
- Determines cache boundary BEFORE image selection (critical for cache stability)
- Images selected relative to this marker to prevent cross-boundary inclusion
- First activation: `determineCacheMarker()` with buffer=20, prefer non-bot messages
- Subsequent: reuse `lastCacheMarker` if valid

**Step 4: Format Messages** (lines 127-143)
- Converts `DiscordMessage[]` → `ParticipantMessage[]`
- Adds image content (selected based on cache marker position)
- Adds document attachments (wrapped in `<attachment>` XML tags)
- Normalizes bot mentions: `<@DiscordUsername>` → `<@ConfigName>`
- Optionally strips `<reply:@username>` tags (`include_reply_tags` config)

**Step 5: Interleave Tool Cache** (lines 145-196)
- Skipped if `preserve_thinking_context` enabled
- Tool calls formatted as bot participant messages
- Tool results formatted as `System<[tool_name]` participant messages
- Interleaved chronologically after their triggering Discord message
- MCP images limited by `max_mcp_images` config

**Step 6: Inject Activation Completions** (lines 198-202)
- Only if `preserve_thinking_context` enabled
- Replaces bot message content with full completion text (including thinking)
- Inserts "phantom" completions (thinking-only) after anchor messages
- See [Section 9.6](#96-activation-completions-preserve_thinking_context) for details

**Step 7: Insert Plugin Injections** (lines 204-207)
- Adds `ContextInjection` items at calculated depths
- Supports negative depths (from start) and positive (from end)
- Each injection becomes a `System>[plugin]` or `System` participant message

**Step 8: Merge Consecutive Same-Participant Messages** (lines 209-212)
- Handles "m continue" scenarios
- Done AFTER injection so message IDs are available for lookup
- Merges text blocks with space separator
- Preserves cache breakpoint from either merged message

**Step 9: Apply Limits (Rolling)** (lines 214-224)
- Enforces character and message count limits
- See [Section 7](#7-rolling-context--truncation) for full algorithm

**Step 10: Determine + Apply Cache Marker** (lines 226-275)
- See [Section 8](#8-cache-marker-system) for full algorithm

**Step 11: Add Empty Completion Message** (lines 277-282)
- `{ participant: config.name, content: [{ type: 'text', text: '' }] }`
- Signals to formatter: "bot generates from here"

**Step 12: Build Stop Sequences** (lines 284-287)
- See [Section 12](#12-stop-sequence-generation)

### Output (`ContextBuildResult`):
```typescript
{
  request: LLMRequest {
    messages: ParticipantMessage[]        // Full context
    system_prompt?: string                // System instructions
    context_prefix?: string               // First cached assistant message
    prefill_user_message?: string         // Custom synthetic user message
    config: ModelConfig                   // Model params
    tools?: ToolDefinition[]              // Available tools (added by agent loop)
    stop_sequences?: string[]
  },
  didRoll: boolean,                       // Whether truncation occurred
  cacheMarker: string | null              // Message ID for cache boundary
}
```

---

## 7. Rolling Context & Truncation

### Decision Logic: `shouldRoll()` — `rolling.ts:83-120`

```
Calculate total characters (text + tool_result, NOT images)
     |
     v
Hard limit exceeded? (hard_max_characters, default 500KB)
  YES → Roll to recency_window_characters
     |
     NO
     v
Rolling threshold exceeded? (messagesSinceRoll >= rolling_threshold)
  YES → Roll to recency_window_characters
     |
     NO
     v
Caching enabled?
  YES → Keep ALL messages (cache stability — unchanged prefix = cache hits)
  NO  → Check normal limits, truncate if exceeded
```

### Truncation Methods — `rolling.ts:130-220`

**Character-based** (`truncateToCharacterLimit`): Count from END backwards, keep most recent messages up to character limit.

**Message-based** (`truncateToMessageLimit`): Simple `messages.slice(removed)`, keep most recent N.

### State Tracking

- `messagesSinceRoll`: Incremented each activation, reset to 0 when rolling occurs
- `cacheOldestMessageId`: Oldest message when cache was created, used for stability extension
- State persisted per channel per bot via `ChannelStateManager`

### Character Counting — `rolling.ts:130-147`

```typescript
function calculateCharacters(messages: ParticipantMessage[]): number {
  // Counts: text blocks (character length), tool_result (JSON stringified)
  // Does NOT count: images (separate limits), system prompt
}
```

---

## 8. Cache Marker System

### Purpose

Marks the boundary in the message stream where Anthropic prompt caching begins. Everything before the marker is cached and reused across activations; everything after is ephemeral.

### Placement Algorithm — `builder.ts:226-275`

1. **First activation**: `determineCacheMarker()` places marker at `length - 20` (buffer of 20 uncached messages)
2. **Subsequent activations**: Reuse `lastCacheMarker` if the message still exists in context
3. **Orphaned marker** (message was merged/filtered):
   - Search for valid fallback among original messages
   - Prefer non-bot messages (won't be merged during injection)
   - Last resort: any message in tail 20
4. **Apply**: Sets `cacheBreakpoint: true` on the marked `ParticipantMessage`

### Cache Marker Preference

Non-bot messages are preferred because:
- Bot messages can be merged during consecutive-message merging
- Bot messages may be replaced during activation injection
- User messages are stable anchors that don't get transformed

### Image Selection Anchoring

Images are selected in two tiers relative to the cache marker:
- **Cached prefix** (before marker): Only if `cache_images: true`, deterministic
- **Ephemeral window** (after marker): If `include_images: true`, up to `max_ephemeral_images`

---

## 9. Hidden Text Injection Points

"Hidden text" = content injected into the LLM context that is NOT directly visible in Discord messages. There are 6 injection points:

### 9.1. System Prompt

**Source**: `config.system_prompt` or loaded from `config.system_prompt_file`

**Where**: Passed as `LLMRequest.system_prompt` → formatter places in API `system` field.

**Caching**: System content gets `cache_control` marker if `prompt_caching` enabled (always cached).

### 9.2. Context Prefix (Simulacrum Seeding)

**Source**: `config.context_prefix` or loaded from `config.context_prefix_file`

**Where**: Passed as `LLMRequest.context_prefix` → formatter inserts as **first assistant message** in the conversation, BEFORE any Discord messages.

**Purpose**: Establishes bot "voice" / persona at the beginning of context. Stable across activations (cached).

**Per-formatter behavior**:
| Formatter | Behavior |
|-----------|----------|
| `anthropic-xml` | Separate assistant message with `cache_control` |
| `native` | Separate assistant message with `cache_control` |
| `completions` | Serialized into prompt string: `"AssistantName: {prefix}<eot>"` |

### 9.3. Prefill User Message

**Source**: `config.prefill_user_message` or loaded from `config.prefill_user_message_file`

**Where**: Passed as `LLMRequest.prefill_user_message` → formatter uses as synthetic first user message (when API requires user role first).

**Fallback chain** (anthropic-xml formatter):
1. `prefill_user_message` if provided
2. CLI simulation mode if no system prompt (`<cmd>cat untitled.txt</cmd>`)
3. Generic `[Start]` marker

### 9.4. Tool Cache Interleaving

**Source**: `toolCacheWithResults` from `ChannelState`

**Where**: Inserted during Step 5 of context builder pipeline.

**Format**:
```
{ participant: "BotName", content: [{ type: 'text', text: originalCompletionText }] }
{ participant: "System<[tool_name]", content: [toolResultContent] }
```

- Positioned chronologically after the Discord message that triggered the tool call
- MCP images from tool results included (subject to `max_mcp_images`)

### 9.5. Plugin Context Injections

**Source**: Plugins (e.g., `inject` plugin) provide `ContextInjection[]`

**Config example**:
```yaml
plugin_config:
  inject:
    injections:
      - id: persona
        content: "Remember: you love cats."
        depth: 5         # 5 messages from latest
        anchor: latest
```

**Where**: Inserted during Step 7 of context builder pipeline.

**Type**:
```typescript
interface ContextInjection {
  id: string
  content: string | ContentBlock[]
  targetDepth: number              // Depth from anchor
  lastModifiedAt?: string | null
  priority?: number                // Higher = earlier at same depth
  asSystem?: boolean               // System message vs participant
}
```

**Positioning**: Positive depth = from end (latest), negative depth = from start (earliest).

### 9.6. Activation Completions (`preserve_thinking_context`)

**Source**: `ActivationStore` — historical completions for each bot message

**Where**: Inserted during Step 6 of context builder pipeline.

**Mechanism** — `builder.ts:1287-1516`:

Each activation stores per-message context:
```typescript
{ prefix: string, suffix?: string }
```

Injection wraps the Discord-visible text:
```typescript
const newText = (context.prefix || '') + existingText + (context.suffix || '')
```

- **prefix**: Typically `<thinking>...</thinking>` blocks or tool XML before visible text
- **suffix**: Trailing invisible content (only for last message in generation)

**Phantom completions** (lines 1337-1368):
- Completions with no `sentMessageIds` (thinking-only, no Discord output)
- Inserted AFTER their anchor message
- Thinking-only phantoms skipped to prevent feedback loops

---

## 10. Membrane Formatter Layer

### Formatter Selection — `factory.ts`

**Per-model routing** via `formatterRoutes` (module-level):
```typescript
// Each vendor config with `formatter` + `provides` patterns:
formatterRoutes.push({ patterns: ['claude-*-opus-*'], formatter: 'native' })
```

**Resolution order**:
1. `getFormatterForModel(modelName)` — glob pattern match against formatterRoutes
2. Factory default (`config.formatter ?? 'anthropic-xml'`)

### Three Formatters

#### `anthropic-xml` (default for Claude chat models)

**File**: `membrane/src/formatters/anthropic-xml.ts`
- `usesPrefill: true`
- Serializes multi-participant conversation as text: `"ParticipantName: content\n"`
- All messages accumulate in assistant role content
- Final turn: `"BotName:"` (or `"BotName: <thinking>"` if thinking enabled)
- Auto-generates stop sequences from participant names
- Supports XML tool injection into system prompt or conversation
- Cache markers via `cacheBreakpoint` property

**API output structure**:
```
system: [{ type: 'text', text: systemPrompt, cache_control }]
messages: [
  { role: 'user', content: '[Start]' },                              // synthetic
  { role: 'assistant', content: [{ text: contextPrefix, cache_control }] },  // if set
  { role: 'user', content: '...' },                                  // conversation batches
  { role: 'assistant', content: 'Alice: Hi\nBob: Hello\nBotName:' }  // prefill
]
```

#### `native` (for models without prefill, e.g., Opus 4)

**File**: `membrane/src/formatters/native.ts`
- `usesPrefill: false`
- Maps participants directly to user/assistant roles
- In multiuser mode: prepends participant name to content
- Merges consecutive same-role messages for API compliance
- No auto-generated stop sequences
- Supports native API tool calling

**API output structure**:
```
system: systemPrompt (string or array with cache_control)
messages: [
  { role: 'assistant', content: [{ text: contextPrefix, cache_control }] },
  { role: 'user', content: 'Alice: Hi' },
  { role: 'assistant', content: 'response text' },
  { role: 'user', content: 'Bob: question' },
]
```

#### `completions` (for base/completion models)

**File**: `membrane/src/formatters/completions.ts`
- `usesPrefill: true`
- Serializes entire conversation as single prompt string
- Format: `"ParticipantName: content<eot>"` per message
- No images (stripped with warning)
- No native tools
- Stop sequences from participant names + EOT token

**API output structure**:
```
messages: [{ role: 'assistant', content: 'entire serialized conversation as one string' }]
```

### Formatter Comparison

| Aspect | anthropic-xml | native | completions |
|--------|--------------|--------|-------------|
| Prefill | Yes | No | Yes |
| Participant names in content | Always | Multiuser mode only | Always |
| Context prefix | Separate assistant msg | Separate assistant msg | Part of prompt string |
| Stop sequences | Auto from participants | Manual only | Auto from participants + EOT |
| Cache markers | cacheBreakpoint + hasCacheMarker | cacheBreakpoint + hasCacheMarker | None |
| Images | Supported | Supported | Stripped |
| Tools | XML or native | Native only | None |
| Role alternation | Synthetic user msg first | mergeConsecutiveRoles() | Single message |

---

## 11. Tool Integration & Invisible Content

### Two Execution Paths — `loop.ts`

#### Path 1: Inline Tools (Anthropic/Claude)

`executeWithInlineTools()` — lines 2520-2966

1. Build request with `accumulatedOutput` as prefill
2. Call LLM via `membrane.stream()`
3. Parse completion for `<function_calls>...</function_calls>` blocks
4. If tool call found:
   - Send pre-tool visible text to Discord
   - Execute tool
   - Inject result as `System:\n<results>\n...\n</results>` into accumulated text
   - Increment `toolDepth`, loop back
5. If no tool call or stop sequence → finalize

**Stop sequence handling in tool loop** (lines 2593-2704):
- Stopped on `</function_calls>`: Check for unclosed `<thinking>` → continue past if needed
- Stopped on participant name: Check if inside `<function_calls>` (it's a parameter, not a turn) → continue; otherwise model is hallucinating → stop

#### Path 2: Native Tools (OpenAI, Gemini)

`executeWithNativeTools()` — lines 2126-2503

- Uses `membrane.stream()` with `onToolCalls` callback
- Membrane manages multi-turn tool loop internally
- No XML parsing, no prefill continuation

### Segment Parsing: `parseIntoSegments()` — `loop.ts:225-301`

Splits LLM completion text into visible/invisible regions.

**Regex patterns matched**:
| Pattern | Matches |
|---------|---------|
| `/<thinking>[\s\S]*?<\/thinking>/g` | Thinking blocks |
| `/<function_calls>[\s\S]*?<\/function_calls>/g` | Tool call XML |
| `/System:\s*<results>[\s\S]*?<\/results>/g` | Tool results (System: prefix) |
| `/<function_results>[\s\S]*?<\/function_results>/g` | Tool results (bare) |

**Output** (`ContentSegment[]`):
```typescript
{
  prefix: string    // invisible content before visible text
  visible: string   // text sent to Discord
  suffix?: string   // trailing invisible (only last segment)
}
```

### Segment Sending: `sendSegments()` — `loop.ts:364-425`

- Each segment's `visible` text → Discord message
- First message of segment gets `prefix` association
- Last message gets `suffix` association
- Associations stored in activation record for `preserve_thinking_context`

**Example**:
```
LLM output: "<thinking>hmm</thinking>Hello world<function_calls>...</function_calls>"

Segments: [
  { prefix: "<thinking>hmm</thinking>", visible: "Hello world", suffix: "<function_calls>...</function_calls>" }
]

Discord message: "Hello world"
Stored: { prefix: "<thinking>hmm</thinking>", suffix: "<function_calls>...</function_calls>" }
```

---

## 12. Stop Sequence Generation

### Context Builder Level — `builder.ts:1656-1736`

Generates from recent participants (backwards from end):

1. **Turn end token** (if configured, e.g., `<eot>` for Gemini)
2. **Message delimiter** (if configured)
3. **Recent participant names**: `"\nParticipantName:"` for up to `recent_participant_count` participants
   - **Exception**: When `prefill_thinking: true`, bot's own name excluded (prevents premature stop before visible text after `</thinking>`)
4. **Configured stop sequences** from `config.stop_sequences`
5. **System prefix**: `"\nSystem:"`
6. **Boundary marker**: `"<<HUMAN_CONVERSATION_END>>"`

Participant names collected from message authors AND mentions (`<@username>` format).

### Formatter Level

| Formatter | Stop Sequences |
|-----------|---------------|
| `anthropic-xml` | `"\nParticipantName:"` per recent participant + `"</function_calls>"` + additional |
| `native` | Only additional (manual) |
| `completions` | Both `"\n\nParticipantName:"` and `"\nParticipantName:"` + EOT token + additional |

---

## 13. Data Types Reference

### `ParticipantMessage` — `types.ts:39-46`

```typescript
{
  participant: string           // "Alice", "Claude", "System<[tool_name]"
  content: ContentBlock[]       // text, image, tool_use, tool_result
  timestamp?: Date
  messageId?: string            // Discord message ID (for cache markers)
  cacheBreakpoint?: boolean     // Cache boundary placement
}
```

### `ContentBlock` Union — `types.ts:51-83`

```typescript
TextContent:       { type: 'text', text: string }
ImageContent:      { type: 'image', source: { type: 'base64'|'url', data, media_type } }
ToolUseContent:    { type: 'tool_use', id, name, input }
ToolResultContent: { type: 'tool_result', toolUseId, content, isError? }
```

### `LLMRequest` — `types.ts:16-24`

```typescript
{
  messages: ParticipantMessage[]
  system_prompt?: string
  context_prefix?: string             // First cached assistant message
  prefill_user_message?: string       // Custom synthetic user message
  config: ModelConfig
  tools?: ToolDefinition[]
  stop_sequences?: string[]
}
```

### `BotConfig` — `types.ts:147-241`

| Group | Key Fields |
|-------|-----------|
| Identity | `name` |
| Model | `continuation_model`, `temperature`, `max_tokens`, `top_p?`, `presence_penalty?`, `frequency_penalty?`, `prefill_thinking?`, `debug_thinking?`, `preserve_thinking_context?` |
| Context | `recency_window_messages?`, `recency_window_characters?`, `hard_max_characters?`, `rolling_threshold`, `recent_participant_count`, `authorized_roles[]`, `prompt_caching?`, `cache_ttl?` |
| Images | `include_images`, `max_images`, `max_ephemeral_images?`, `cache_images?`, `generate_images?` |
| Text | `include_text_attachments`, `max_text_attachment_kb`, `include_reply_tags?` |
| Tools | `tools_enabled`, `tool_output_visible`, `max_tool_depth`, `max_mcp_images`, `mcp_servers?`, `tool_plugins?`, `plugin_config?` |
| Stop | `stop_sequences[]`, `message_delimiter?`, `turn_end_token?`, `participant_stop_sequences?` |
| Prompts | `system_prompt?`, `system_prompt_file?`, `context_prefix?`, `context_prefix_file?`, `prefill_user_message?`, `prefill_user_message_file?` |
| Loop | `max_bot_reply_chain_depth`, `bot_reply_chain_depth_emote` |
| Mode | `mode?` (`'chat'` / `'prefill'` / `'base-model'`), `api_only?` |

### `ChannelState` — `types.ts:491-496`

```typescript
{
  toolCache: ToolCall[]
  lastCacheMarker: string | null       // Message ID of cache boundary
  messagesSinceRoll: number            // Messages added since last roll
  cacheOldestMessageId: string | null  // Oldest message when cache created
}
```

### `ContextInjection` — `tools/plugins/types.ts:158-189`

```typescript
{
  id: string
  content: string | ContentBlock[]
  targetDepth: number                  // From anchor (positive = end, negative = start)
  lastModifiedAt?: string | null
  priority?: number                    // Higher = earlier at same depth
  asSystem?: boolean
}
```

---

## Appendix: Environment Variables

| Variable | Purpose |
|----------|---------|
| `NO_MSG_CACHE=1` | Bypass message cache (debugging) |
| `MOCK_LLM=1` | Profile without real LLM calls |
| `EMS_PATH` | Use EMS config layout instead of local |
| `PREFETCH_CHANNELS` | Comma-separated channel IDs to warm cache on startup |
