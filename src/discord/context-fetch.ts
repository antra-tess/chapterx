import { MessageType, type Message, type TextChannel, type GuildMember, type Role } from 'discord.js'
import pino from 'pino'

const logger = pino({ name: 'context-fetch' })

export interface FetchDeps {
  /** Newest-first, as Discord's API returns them. */
  fetchBatch(channel: TextChannel, options: { before?: string; limit: number }): Promise<Message[]>
  fetchSingle(channel: TextChannel, messageId: string): Promise<Message | null>
  resolveChannel(channelId: string): Promise<TextChannel | null>
  botUserId: string
}

export interface HistoryResult {
  messages: Message[]
  didClear: boolean
  originChannelId: string | null
}

export interface HistoryRange {
  first?: string
  last: string
}

export function parseHistoryCommand(content: string): HistoryRange | null | false {
  const lines = content.split('\n')

  if (lines.length < 2 || lines.slice(1).every(l => !l.trim())) {
    return null
  }

  if (lines[1]?.trim() !== '---') {
    return false
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

  if (!last) {
    return null
  }

  return { first, last }
}

export function extractMessageIdFromUrl(url: string): string | null {
  // Discord URL format: https://discord.com/channels/guild_id/channel_id/message_id
  const match = url.match(/\/channels\/\d+\/\d+\/(\d+)/)
  return match ? match[1]! : null
}

export function extractChannelIdFromUrl(url: string): string | null {
  // Discord URL format: https://discord.com/channels/guild_id/channel_id/message_id
  const match = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
  return match ? match[1]! : null
}

const MAX_RECURSION_DEPTH = 5

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

  const collected: Message[] = []
  let cursor = startFromId

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

    batch.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))

    for (const msg of batch) {
      if (stopAtId && msg.id <= stopAtId) {
        if (msg.id === stopAtId) {
          collected.push(msg)
        }
        done = true
        break
      }

      if (!ignoreHistory && msg.content?.startsWith('.history') && /^\.history(?:\s|$)/.test(msg.content)) {
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
          return historyResult
        }
        continue
      }

      if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) continue

      if (!msg.author) {
        logger.warn({
          messageId: msg.id,
          channelId: msg.channelId,
          type: msg.type,
          system: msg.system,
          partial: msg.partial,
          content: msg.content?.slice(0, 100),
          webhookId: msg.webhookId,
          hasAttachments: msg.attachments?.size > 0,
          createdAt: msg.createdTimestamp,
        }, 'Skipping message with null author in context fetch')
        continue
      }

      collected.push(msg)
    }

    const oldest = batch[batch.length - 1]
    if (!oldest) break
    cursor = oldest.id
  }

  return { messages: collected.reverse(), didClear: false, originChannelId: null }
}

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
  if (authorizedRoles.length > 0) {
    const member = msg.member as GuildMember | null
    if (member) {
      const memberRoles = Array.from(member.roles.cache.values()).map((r: Role) => r.name)
      if (!authorizedRoles.some(role => memberRoles.includes(role))) {
        return null
      }
    } else {
      return null
    }
  }

  const mentionMatch = msg.content.match(/^\.history\s+<@!?(\d+)>/)
  const targetBotId = mentionMatch?.[1]
  if (targetBotId && targetBotId !== deps.botUserId) {
    return null
  }

  const parsed = parseHistoryCommand(msg.content)

  if (parsed === false) {
    return null
  }

  if (parsed === null) {
    logger.debug({
      messageId: msg.id,
      channelId: currentChannel.id,
      newerCount: collectedNewer.length,
    }, '.history clear — returning newer messages only')

    return {
      messages: collectedNewer.slice().reverse(),
      didClear: true,
      originChannelId: null,
    }
  }

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

  return {
    messages: [...rangeResult.messages, ...collectedNewer.slice().reverse()],
    didClear: true,
    originChannelId: currentChannel.id,
  }
}
