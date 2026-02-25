/**
 * Context fetch pipeline — standalone functions for fetching Discord messages
 * and resolving .history commands.
 *
 * Extracted from connector.ts for clarity and testability. The core insight:
 * process messages in fetch order (newest-first), handle .history as early return,
 * no mutable cross-call state.
 */

import type { Message, TextChannel, GuildMember, Role } from 'discord.js'
import pino from 'pino'

const logger = pino({ name: 'context-fetch' })

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Dependency injection interface — mocked in tests, backed by push cache in production. */
export interface FetchDeps {
  /** Fetch a batch of messages before a cursor (newest-first, matching Discord API order). */
  fetchBatch(channel: TextChannel, options: { before?: string; limit: number }): Promise<Message[]>
  /** Fetch a single message by ID. */
  fetchSingle(channel: TextChannel, messageId: string): Promise<Message | null>
  /** Resolve a channel ID to a TextChannel object. */
  resolveChannel(channelId: string): Promise<TextChannel | null>
  /** The bot's own user ID (for .history bot targeting). */
  botUserId: string
}

/** Result of a channel message fetch with .history resolution. */
export interface HistoryResult {
  /** Messages in chronological order (oldest first). */
  messages: Message[]
  /** Whether a .history clear or range was encountered. */
  didClear: boolean
  /** If .history range was used, the channel ID we jumped from. */
  originChannelId: string | null
}

/** Parsed .history range command. */
export interface HistoryRange {
  first?: string  // Discord message URL — range start (oldest boundary)
  last: string    // Discord message URL — range end (newest boundary)
}

// ────────────────────────────────────────────────────────────────────────────
// Parse helpers (extracted from connector.ts)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a .history command's content.
 *
 * @returns
 *   - `null` — clear context (bare `.history` or body without `last:`)
 *   - `HistoryRange` — range fetch with `last:` (and optionally `first:`) URLs
 *   - `false` — malformed command (has body but no `---` separator)
 */
export function parseHistoryCommand(content: string): HistoryRange | null | false {
  const lines = content.split('\n')

  // Bare .history (or .history <@bot>) with no body = clear context
  if (lines.length < 2 || lines.slice(1).every(l => !l.trim())) {
    return null
  }

  // Must have --- separator for YAML body
  if (lines[1]?.trim() !== '---') {
    return false // Malformed command
  }

  let first: string | undefined
  let last: string | undefined

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]?.trim()
    if (!line) continue

    if (line.startsWith('first:')) {
      first = line.substring(6).trim()
    } else if (line.startsWith('last:')) {
      last = line.substring(5).trim()
    }
  }

  // No last field = empty body = clear history
  if (!last) {
    return null
  }

  return { first, last }
}

/** Extract the message ID from a Discord message URL. */
export function extractMessageIdFromUrl(url: string): string | null {
  // Discord URL format: https://discord.com/channels/guild_id/channel_id/message_id
  const match = url.match(/\/channels\/\d+\/\d+\/(\d+)/)
  return match ? match[1]! : null
}

/** Extract the channel ID from a Discord message URL. */
export function extractChannelIdFromUrl(url: string): string | null {
  // Discord URL format: https://discord.com/channels/guild_id/channel_id/message_id
  const match = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
  return match ? match[1]! : null
}

// ────────────────────────────────────────────────────────────────────────────
// Core fetch functions
// ────────────────────────────────────────────────────────────────────────────

const MAX_RECURSION_DEPTH = 5

/**
 * Fetch messages from a channel with .history resolution.
 *
 * Replaces the old `fetchMessagesRecursive`. Processes messages newest-first
 * (matching Discord API direction), so when a .history command is encountered,
 * the already-collected messages are exactly the "newer" messages to keep.
 *
 * @param channel        The channel to fetch from
 * @param startFromId    Fetch backward from this message (typically the trigger). Included in results.
 * @param stopAtId       Stop when this message ID is reached (for .history range `first:` boundary). Included in results.
 * @param maxMessages    Maximum messages to return
 * @param authorizedRoles  Role names authorized to use .history commands
 * @param ignoreHistory  If true, skip .history processing entirely (for API exports)
 * @param deps           Dependency injection (push cache, channel resolver, bot ID)
 * @param _depth         Internal recursion depth counter (default 0)
 */
export async function fetchChannelMessages(
  channel: TextChannel,
  startFromId: string | undefined,
  stopAtId: string | undefined,
  maxMessages: number,
  authorizedRoles: string[],
  ignoreHistory: boolean,
  deps: FetchDeps,
  _depth: number = 0,
): Promise<HistoryResult> {
  if (_depth > MAX_RECURSION_DEPTH) {
    logger.warn({ channelId: channel.id, depth: _depth }, 'Max .history recursion depth reached — returning empty')
    return { messages: [], didClear: true, originChannelId: null }
  }

  // Collected messages in newest-first order (reversed to chronological at return)
  const collected: Message[] = []
  let cursor = startFromId

  // Include the trigger message itself
  if (startFromId) {
    const triggerMsg = await deps.fetchSingle(channel, startFromId)
    if (triggerMsg) {
      collected.push(triggerMsg)
    }
  }

  let done = false

  while (collected.length < maxMessages && !done) {
    const batchLimit = Math.min(100, maxMessages - collected.length)
    const batch = cursor
      ? await deps.fetchBatch(channel, { before: cursor, limit: batchLimit })
      : await deps.fetchBatch(channel, { limit: batchLimit })

    if (batch.length === 0) break

    // Ensure batch is in newest-first order (matching Discord API)
    // Sort descending by ID for consistency regardless of data source
    batch.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))

    for (const msg of batch) {
      // Check stop boundary (for .history range `first:` parameter)
      if (stopAtId && msg.id <= stopAtId) {
        if (msg.id === stopAtId) {
          collected.push(msg)
        }
        done = true
        break
      }

      // Check for .history command
      // Match ".history" followed by end-of-string, whitespace, or newline
      // to avoid false positives like ".historybook" or ".history-lesson"
      if (!ignoreHistory && msg.content && /^\.history(?:\s|$)/m.test(msg.content)) {
        const historyResult = await processHistoryCommand(
          msg,
          channel,
          collected,
          maxMessages,
          authorizedRoles,
          ignoreHistory,
          deps,
          _depth,
        )
        if (historyResult) {
          // .history was processed — return immediately
          return historyResult
        }
        // .history didn't apply to us (wrong bot target, unauthorized, malformed) — skip it
        continue
      }

      collected.push(msg)
    }

    // Move cursor to oldest message in batch for next iteration
    const oldest = batch[batch.length - 1]
    if (!oldest) break
    cursor = oldest.id
  }

  // Reverse to chronological order (oldest first)
  return { messages: collected.reverse(), didClear: false, originChannelId: null }
}

/**
 * Process a .history command encountered during message fetching.
 *
 * @returns
 *   - `HistoryResult` — the .history was processed (clear or range). Caller should return this.
 *   - `null` — the .history doesn't apply to this bot (wrong target, unauthorized, malformed). Caller should skip it.
 */
export async function processHistoryCommand(
  msg: Message,
  currentChannel: TextChannel,
  collectedNewer: Message[],
  maxMessages: number,
  authorizedRoles: string[],
  ignoreHistory: boolean,
  deps: FetchDeps,
  depth: number,
): Promise<HistoryResult | null> {
  // ── Authorization check ──
  if (authorizedRoles.length > 0) {
    const member = msg.member as GuildMember | null
    if (member) {
      const memberRoles = Array.from(member.roles.cache.values()).map((r: Role) => r.name)
      if (!authorizedRoles.some(role => memberRoles.includes(role))) {
        return null // Unauthorized — skip
      }
    } else {
      return null // Can't verify — skip
    }
  }

  // ── Bot targeting check ──
  // .history <@botId> targets a specific bot; skip if it's not us
  const mentionMatch = msg.content.match(/^\.history\s+<@!?(\d+)>/)
  const targetBotId = mentionMatch?.[1]
  if (targetBotId && targetBotId !== deps.botUserId) {
    return null // Targeted at a different bot — skip
  }

  // ── Parse the command ──
  const parsed = parseHistoryCommand(msg.content)

  if (parsed === false) {
    // Malformed .history (body without --- separator) — skip entirely
    return null
  }

  if (parsed === null) {
    // Clear: return only the messages newer than this .history
    logger.debug({
      messageId: msg.id,
      channelId: currentChannel.id,
      newerCount: collectedNewer.length,
    }, '.history clear — returning newer messages only')

    return {
      messages: collectedNewer.slice().reverse(), // Chronological order
      didClear: true,
      originChannelId: null,
    }
  }

  // ── Range: fetch linked messages ──
  const targetChannelId = extractChannelIdFromUrl(parsed.last)
  const targetChannel = targetChannelId
    ? await deps.resolveChannel(targetChannelId)
    : currentChannel

  if (!targetChannel || !targetChannel.isTextBased()) {
    logger.warn({
      messageId: msg.id,
      targetChannelId,
    }, '.history range — cannot access target channel, treating as clear')
    return {
      messages: collectedNewer.slice().reverse(),
      didClear: true,
      originChannelId: null,
    }
  }

  const histLastId = extractMessageIdFromUrl(parsed.last) ?? undefined
  const histFirstId = parsed.first ? (extractMessageIdFromUrl(parsed.first) ?? undefined) : undefined

  logger.debug({
    messageId: msg.id,
    channelId: currentChannel.id,
    targetChannelId: targetChannel.id,
    histLastId,
    histFirstId,
    newerCount: collectedNewer.length,
    depth: depth + 1,
  }, '.history range — recursively fetching linked messages')

  // Recursive fetch of the linked range
  const rangeResult = await fetchChannelMessages(
    targetChannel,
    histLastId,
    histFirstId,
    maxMessages - collectedNewer.length,
    authorizedRoles,
    ignoreHistory,
    deps,
    depth + 1,
  )

  // Combine: [historical range messages] + [messages newer than .history in current channel]
  return {
    messages: [...rangeResult.messages, ...collectedNewer.slice().reverse()],
    didClear: true,
    originChannelId: currentChannel.id,
  }
}
