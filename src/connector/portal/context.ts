/**
 * Portal fetchContext assembly + PortalMessage → DiscordMessage conversion.
 *
 * Mirrors DiscordConnector.fetchContext's stages — (1) .history-resolved fetch,
 * (2) thread-parent assembly, (3) cache-anchor stability, (4) attachments — but
 * on PortalMessage, using `nativeId` (snowflake) for all ordering/anchor math
 * while message identity stays the relay id.
 */
import type { PortalMessage } from '@animalabs/portal-protocol'
import type { DiscordContext, DiscordMessage } from '../../types.js'
import type { FetchContextParams } from '../types.js'
import { logger } from '../../utils/logger.js'
import { authorOfMessage, containerOf } from './adapters.js'
import { fetchPortalHistory, snowflakeFromId, type PortalFetchDeps } from './history.js'
import type { AttachmentCache } from '../util/attachment-cache.js'

const DISCORD_EPOCH = 1420070400000
function snowflakeToTimestamp(snowflake: string): number {
  try {
    return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH
  } catch {
    return 0
  }
}
function snowflakeLT(a: string, b: string): boolean {
  try {
    return BigInt(a) < BigInt(b)
  } catch {
    return a < b
  }
}

/** The relay addresses personas via pooled roles named `portal-<name>`, so a
 *  resolved role mention in `cleanContent` reads `@portal-glm52`. Strip that
 *  internal prefix so the model sees `@glm52` — the addressing plumbing is noise
 *  to it. Text-only rewrite of the readable rendering; a no-op on raw `<@&id>`. */
function stripPortalRolePrefix(text: string): string {
  return text.replaceAll('@portal-', '@')
}

/** Full PortalMessage → DiscordMessage. Uses portal's resolved `cleanContent`;
 *  adds the `<reply:@name>` prefix for non-bot authors (matching convertMessage). */
export function portalMessageToDiscordMessage(
  pm: PortalMessage,
  messageMap: Map<string, PortalMessage>,
  _botPersonaId: string,
): DiscordMessage {
  const a = authorOfMessage(pm)
  let content = stripPortalRolePrefix(pm.cleanContent || pm.content)

  if (pm.replyToId && !a.bot) {
    const replied = messageMap.get(pm.replyToId)
    const name = replied ? authorOfMessage(replied).username : 'someone'
    content = `<reply:@${name}> ${content}`
  }

  return {
    id: pm.id,
    channelId: containerOf(pm),
    guildId: pm.guildId ?? '',
    author: { id: a.id, username: a.username, displayName: a.globalName ?? a.username, bot: a.bot },
    content,
    timestamp: new Date(pm.createdAt),
    attachments: pm.attachments.map((att) => ({
      id: att.id,
      url: att.url,
      filename: att.name,
      contentType: att.contentType ?? undefined,
      size: att.size,
    })),
    reactions: pm.reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
    mentions: pm.mentions.users,
    referencedMessage: pm.replyToId,
  }
}

export interface ContextDeps extends PortalFetchDeps {
  attachments: AttachmentCache
  /** Channel meta from the client cache. */
  channelMeta(channelId: string): { guildId: string; isThread: boolean; parentId?: string; native?: string } | null
}

const MAX_ANCHOR_GAP_MS = 24 * 60 * 60 * 1000
const MAX_ANCHOR_EXTEND = 500

/** Assemble a DiscordContext from portal history + attachments. */
export async function buildPortalContext(params: FetchContextParams, deps: ContextDeps): Promise<DiscordContext> {
  const { channelId, depth, targetMessageId, firstMessageId, authorized_roles, maxImages, ignoreHistory } = params
  const meta = deps.channelMeta(channelId)

  // ── Stage 1: channel messages with .history ──
  const result = await fetchPortalHistory(
    channelId,
    targetMessageId ? snowflakeFromId(targetMessageId) : undefined,
    undefined,
    depth,
    authorized_roles ?? [],
    ignoreHistory ?? false,
    deps,
  )
  let messages = result.messages
  const historyDidClear = result.didClear
  let historyOriginChannelId = result.originChannelId

  // ── Stage 2: thread-parent assembly ──
  if (meta?.isThread && !historyDidClear && meta.parentId) {
    const starterSnowflake = meta.native // thread id === starter message snowflake
    const parentResult = await fetchPortalHistory(
      meta.parentId,
      starterSnowflake,
      undefined,
      Math.max(0, depth - messages.length),
      authorized_roles ?? [],
      ignoreHistory ?? false,
      deps,
    )
    const parentMessages = parentResult.messages
    if (starterSnowflake && !parentMessages.some((m) => m.nativeId === starterSnowflake)) {
      const starter = await deps.fetchSingle(meta.parentId, starterSnowflake)
      if (starter) parentMessages.push(starter)
    }
    messages = [...parentMessages, ...messages]
    if (parentResult.originChannelId && !historyOriginChannelId) historyOriginChannelId = parentResult.originChannelId
  }

  // ── Stage 3: cache-anchor stability (snowflake-based) ──
  let cacheAnchorTrimmed = false
  let anchor = firstMessageId
  if (anchor && !historyDidClear) {
    const anchorSnow = snowflakeFromId(anchor)
    let firstIndex = messages.findIndex((m) => m.id === anchor || m.nativeId === anchorSnow)
    const oldest = messages[0]

    // Temporal sanity: skip extension if the anchor is far older than the window.
    if (firstIndex < 0 && oldest) {
      const gap = snowflakeToTimestamp(oldest.nativeId) - snowflakeToTimestamp(anchorSnow)
      if (gap > MAX_ANCHOR_GAP_MS) {
        logger.warn({ anchor, gapHours: Math.round(gap / 3.6e6) }, 'portal: cache anchor too old — skipping extension')
        anchor = undefined
      }
    }

    if (firstIndex < 0 && oldest && anchor) {
      const extendChannel = meta?.isThread && meta.parentId && oldest.nativeId === meta.native ? meta.parentId : channelId
      let extended = 0
      let before = oldest.nativeId
      while (extended < MAX_ANCHOR_EXTEND) {
        const batch = await deps.fetchBatch(extendChannel, { before, limit: 100 })
        if (batch.length === 0) break
        const sorted = [...batch].sort((a, b) => (snowflakeLT(a.nativeId, b.nativeId) ? -1 : 1))
        messages = [...sorted, ...messages]
        extended += sorted.length
        firstIndex = messages.findIndex((m) => m.id === anchor || m.nativeId === anchorSnow)
        if (firstIndex >= 0) break
        before = sorted[0]!.nativeId
      }
    }

    const historyWasUsed = !!historyOriginChannelId
    if (firstIndex > 0 && !historyWasUsed) {
      messages = messages.slice(firstIndex)
      cacheAnchorTrimmed = true
    }
  }

  // ── Convert + filter ──
  const messageMap = new Map(messages.map((m) => [m.id, m]))
  const discordMessages = messages
    .map((m) => portalMessageToDiscordMessage(m, messageMap, deps.botPersonaId))
    .filter((m) => m.content || m.attachments.length > 0)

  // ── Stage 4: attachments (newest-first so the image cap keeps recent ones) ──
  const images = []
  const documents = []
  let newDownloads = 0
  const capReached = () => maxImages !== undefined && images.length >= maxImages
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const att of messages[i]!.attachments) {
      if (att.contentType?.startsWith('image/')) {
        if (capReached()) continue
        const had = deps.attachments.has(att.url)
        const cached = await deps.attachments.cacheImage(att.url, att.contentType)
        if (cached) {
          images.push(cached)
          if (!had) newDownloads++
        }
      } else if (deps.attachments.isTextAttachment({ url: att.url, name: att.name, contentType: att.contentType, size: att.size })) {
        const doc = await deps.attachments.fetchTextAttachment(
          { url: att.url, name: att.name, contentType: att.contentType, size: att.size },
          messages[i]!.id,
        )
        if (doc) documents.push(doc)
      }
    }
  }
  if (newDownloads > 0) deps.attachments.saveUrlMap()

  const inheritanceInfo: DiscordContext['inheritanceInfo'] = {}
  if (meta?.isThread && meta.parentId) inheritanceInfo.parentChannelId = meta.parentId
  if (historyOriginChannelId) inheritanceInfo.historyOriginChannelId = historyOriginChannelId
  if (historyDidClear) inheritanceInfo.historyDidClear = true
  if (cacheAnchorTrimmed) inheritanceInfo.cacheAnchorTrimmed = true

  return {
    messages: discordMessages,
    pinnedConfigs: params.pinnedConfigs ?? [],
    images,
    documents,
    guildId: meta?.guildId ?? '',
    inheritanceInfo: Object.keys(inheritanceInfo).length > 0 ? inheritanceInfo : undefined,
  }
}
