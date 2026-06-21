/**
 * Portal `.history` engine — a port of context-fetch.ts's fetchChannelMessages,
 * operating on PortalMessage instead of discord.js Message.
 *
 * The critical adaptation: discord.js uses `msg.id` for BOTH identity and
 * ordering (it's the snowflake). In portal those split — identity is the relay
 * id (`rm_<container>_<snowflake>`), ordering/boundaries are the Discord
 * snowflake (`pm.nativeId`). So all cursor/boundary math here uses the snowflake
 * (BigInt-compared), while message identity stays the relay id downstream.
 *
 * The pure parsers (parseHistoryCommand / extract*FromUrl) are reused verbatim
 * from context-fetch.ts.
 */
import type { PortalMessage } from '@animalabs/portal-protocol'
import { parseHistoryCommand, extractMessageIdFromUrl, extractChannelIdFromUrl } from '../../discord/context-fetch.js'
import { logger } from '../../utils/logger.js'

const MAX_RECURSION_DEPTH = 5

export interface PortalChannelRef {
  id: string
  isTextBased: boolean
}

export interface PortalFetchDeps {
  /** Fetch a batch strictly before `before` (relay id or snowflake), any order. */
  fetchBatch(channelId: string, opts: { before?: string; limit: number }): Promise<PortalMessage[]>
  /** Fetch a single message whose snowflake === `snowflake`, or null. */
  fetchSingle(channelId: string, snowflake: string): Promise<PortalMessage | null>
  /** Resolve a Discord channel snowflake (from a .history URL) to a portal channel. */
  resolveChannelBySnowflake(snowflake: string): Promise<PortalChannelRef | null>
  /** Author role NAMES of `pm` for .history auth; null when unverifiable. */
  authorRoles(pm: PortalMessage): Promise<string[] | null>
  botPersonaId: string
}

export interface PortalHistoryResult {
  /** Chronological (oldest first). */
  messages: PortalMessage[]
  didClear: boolean
  originChannelId: string | null
}

/** Recover the Discord snowflake from a relay id (`rm_<container>_<snowflake>`)
 *  or pass through a raw snowflake. */
export function snowflakeFromId(id: string): string {
  if (id.startsWith('rm_')) {
    const us = id.lastIndexOf('_')
    if (us > 2) return id.slice(us + 1)
  }
  return id
}

function snowflakeLE(a: string, b: string): boolean {
  try {
    return BigInt(a) <= BigInt(b)
  } catch {
    return a <= b
  }
}

/** Keep only real user/persona messages (drop relay system notices). */
function isKeepable(pm: PortalMessage): boolean {
  return pm.author.kind !== 'system'
}

function isHistoryCommand(content: string): boolean {
  return !!content && content.startsWith('.history') && /^\.history(?:\s|$)/.test(content)
}

/**
 * Fetch messages from a portal channel with .history resolution.
 *
 * @param channelId    portal channel id (thread id ok — relay resolves it)
 * @param startFrom    snowflake to fetch backward from (included); undefined = latest
 * @param stopAt       snowflake boundary (.history range `first:`); included
 */
export async function fetchPortalHistory(
  channelId: string,
  startFrom: string | undefined,
  stopAt: string | undefined,
  maxMessages: number,
  authorizedRoles: string[],
  ignoreHistory: boolean,
  deps: PortalFetchDeps,
  _depth = 0,
): Promise<PortalHistoryResult> {
  if (_depth > MAX_RECURSION_DEPTH) {
    logger.warn({ channelId, depth: _depth }, 'portal .history: max recursion depth — returning empty')
    return { messages: [], didClear: true, originChannelId: null }
  }

  const collected: PortalMessage[] = []
  let cursor = startFrom

  // Include the boundary/trigger message itself (fetchBatch `before` is exclusive).
  if (startFrom) {
    const trigger = await deps.fetchSingle(channelId, startFrom)
    if (trigger) collected.push(trigger)
  }

  let done = false
  while (collected.length < maxMessages && !done) {
    const batchLimit = Math.min(100, maxMessages - collected.length)
    const batch = await deps.fetchBatch(channelId, { before: cursor, limit: batchLimit })
    if (batch.length === 0) break

    // Newest-first by snowflake.
    batch.sort((a, b) => (snowflakeLE(a.nativeId, b.nativeId) ? 1 : -1))

    for (const msg of batch) {
      if (stopAt && snowflakeLE(msg.nativeId, stopAt)) {
        if (msg.nativeId === stopAt) collected.push(msg)
        done = true
        break
      }

      if (!ignoreHistory && isHistoryCommand(msg.content)) {
        const res = await processPortalHistoryCommand(msg, channelId, collected, maxMessages, authorizedRoles, ignoreHistory, deps, _depth)
        if (res) return res
        continue // didn't apply (wrong target / unauthorized / malformed) — skip it
      }

      if (!isKeepable(msg)) continue
      collected.push(msg)
    }

    const oldest = batch[batch.length - 1]
    if (!oldest) break
    cursor = oldest.nativeId
  }

  return { messages: collected.reverse(), didClear: false, originChannelId: null }
}

async function processPortalHistoryCommand(
  msg: PortalMessage,
  currentChannelId: string,
  collectedNewer: PortalMessage[],
  maxMessages: number,
  authorizedRoles: string[],
  ignoreHistory: boolean,
  deps: PortalFetchDeps,
  depth: number,
): Promise<PortalHistoryResult | null> {
  // ── Authorization (by role name) ──
  if (authorizedRoles.length > 0) {
    const roles = await deps.authorRoles(msg)
    if (!roles || !authorizedRoles.some((r) => roles.includes(r))) return null
  }

  // ── Bot targeting: persona role-mention. If targeted and not us, skip. ──
  if (msg.mentions.personas.length > 0 && !msg.mentions.personas.includes(deps.botPersonaId)) {
    return null
  }

  const parsed = parseHistoryCommand(msg.content)
  if (parsed === false) return null // malformed

  if (parsed === null) {
    // Clear: only the messages newer than this command.
    return { messages: collectedNewer.slice().reverse(), didClear: true, originChannelId: null }
  }

  // ── Range ──
  const targetSnowflake = extractChannelIdFromUrl(parsed.last)
  const targetChannel = targetSnowflake ? await deps.resolveChannelBySnowflake(targetSnowflake) : { id: currentChannelId, isTextBased: true }

  if (!targetChannel || !targetChannel.isTextBased) {
    logger.warn({ messageId: msg.id, targetSnowflake }, 'portal .history range: target channel inaccessible — treating as clear')
    return { messages: collectedNewer.slice().reverse(), didClear: true, originChannelId: null }
  }

  const histLast = extractMessageIdFromUrl(parsed.last) ?? undefined
  const histFirst = parsed.first ? (extractMessageIdFromUrl(parsed.first) ?? undefined) : undefined

  const rangeResult = await fetchPortalHistory(
    targetChannel.id,
    histLast,
    histFirst,
    maxMessages - collectedNewer.length,
    authorizedRoles,
    ignoreHistory,
    deps,
    depth + 1,
  )

  return {
    messages: [...rangeResult.messages, ...collectedNewer.slice().reverse()],
    didClear: true,
    originChannelId: currentChannelId,
  }
}
