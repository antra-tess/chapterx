/**
 * PortalConnector: the IConnector backed by the shared portal relay over a
 * WebSocket (portal-client), in place of the bot's own discord.js gateway. The
 * bot connects as a persona, a webhook identity the relay speaks for.
 *
 * It feeds inbound events to the EventQueue through the adapter (adapters.ts);
 * sends, edits, deletes, reacts, uploads attachments and shows typing; builds
 * context with the .history engine (history.ts, context.ts); and reads pins
 * (list_pins) and member roles (list_members).
 *
 * Where the relay offers less than a gateway, the connector does this instead:
 * - a persona can't add native reactions, so its reactions are pseudo-reactions
 *   the relay records and humans don't see;
 * - nothing can pin a message, so pinMessage throws;
 * - nothing fetches a message by id, so it's looked up in the channel's history;
 * - nothing looks a member up by id, so roles come from list_members, which
 *   returns at most 1,000 members.
 */
import { PortalClient, fileFromBytes } from '@animalabs/portal-client'
import type { PortalMessage, PortalEvent } from '@animalabs/portal-protocol'
import { EventQueue } from '../../agent/event-queue.js'
import type { DiscordContext } from '../../types.js'
import { logger } from '../../utils/logger.js'
import type { IConnector, FetchContextParams, TrackedPin, PinnedSteer, SentMessageChunk } from '../types.js'
import { splitPreservingMarkdown, type MarkdownCarry } from '../../utils/discord-markdown.js'
import { queueEventFromPortal, authorOfMessage, type AdapterCtx } from './adapters.js'
import { AttachmentCache } from '../util/attachment-cache.js'
import { buildPortalContext, type ContextDeps } from './context.js'
import { newestFirst, type PortalChannelRef } from './history.js'
import { replyChainDepth } from '../util/reply-chain.js'
import { extractConfigs, extractSteers, extractSleeps } from '../util/pin-extract.js'
import type { BotIdentity } from '../../agent/pin-target.js'

const ROLE_CACHE_TTL_MS = 5 * 60 * 1000

/** PortalMessage → TrackedPin (raw content; snowflake id for stable sort). */
function portalMessageToTrackedPin(pm: PortalMessage): TrackedPin {
  const a = authorOfMessage(pm)
  return {
    id: pm.nativeId,
    content: pm.content,
    authorId: a.id,
    authorBot: a.bot,
    // The relay resolves role mentions to persona ids; carry both so pinned
    // .config/.sleep/.steer can be matched by persona/role mention.
    mentionedPersonaIds: pm.mentions?.personas ? [...pm.mentions.personas] : undefined,
    mentionedRoleIds: pm.mentions?.roles ? [...pm.mentions.roles] : undefined,
  }
}

/** chatperx emits `<@username>`; the relay's outgoing-mention resolver matches
 *  bare `@handle`. Strip the brackets (but leave raw numeric `<@id>` alone — the
 *  relay can't resolve those and Discord would render the snowflake). */
function normalizeOutgoingMentions(content: string): string {
  return content.replace(/<@!?([A-Za-z][\w.]*)>/g, '@$1')
}

export interface PortalConnectorOptions {
  url: string
  token: string
  personaId: string
  cacheDir: string
  maxBackoffMs?: number
}

/** Portal channel types that carry messages. */
function isTextBasedType(type?: string): boolean {
  return type === 'text' || type === 'thread'
}

/** How many messages `seen` remembers. */
const SEEN_CAP = 5000
/** How far back the reply-chain walk pages for a message it replies to, in pages
 *  of 100. The protocol has no fetch by id, so this bounds the RPCs one check
 *  can cost; a link older than this ends the walk, as a deleted message does on
 *  the Discord backend. */
const CHAIN_PAGES = 5
const TYPING_REFRESH_MS = 8000
/** The split target for one message, as DiscordConnector uses: under Discord's
 *  2000-character limit, with room for the splitter's synthetic closers. */
const MESSAGE_CHUNK_CHARS = 1800

export class PortalConnector implements IConnector {
  private client: PortalClient
  private personaId: string
  private displayName = ''
  private attachments: AttachmentCache
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
  /**
   * Messages this process has seen, by relay id: from events, from history it
   * fetched, and from its own sends. Deletes and reactions carry only a relay
   * id, so this is where their message's author comes from; and the relay id is
   * opaque, so this is where a message's snowflake comes from when the context
   * pipeline needs one. A message from before this process started isn't here.
   */
  private seen = new Map<string, { authorId: string; nativeId?: string }>()
  /** channelId → tracked pins (bootstrapped via list_pins, refreshed on pins_update). */
  private pinnedByChannel = new Map<string, TrackedPin[]>()
  /** channelId → the list_pins load in progress. A refresh asked for while one
   *  is in progress makes it load once more when its reply lands, so replies
   *  apply in the order they were asked for, and everyone waiting on the load
   *  reads the newest pins. */
  private pinLoads = new Map<string, { done: Promise<void>; again: boolean }>()
  /** guildId → (roleId → name) with a fetch timestamp, for name-based auth. */
  private roleNameCache = new Map<string, { map: Map<string, string>; at: number }>()

  constructor(
    private queue: EventQueue,
    opts: PortalConnectorOptions,
  ) {
    this.personaId = opts.personaId
    this.attachments = new AttachmentCache(opts.cacheDir)
    this.client = new PortalClient({
      url: opts.url,
      token: opts.token,
      personaId: opts.personaId,
      maxBackoffMs: opts.maxBackoffMs,
    })
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    this.client.on('event', (e) => this.onEvent(e))
    // A fresh `ready` means the relay couldn't resume the session, so pins_update
    // events in the gap may be lost: drop the pin cache and let each channel
    // refill it on its next read. A resume replays the gap and keeps the cache.
    this.client.on('ready', () => this.pinnedByChannel.clear())
    this.client.on('close', (info) =>
      logger.warn({ code: info.code, willReconnect: info.willReconnect }, 'portal connection closed'),
    )
    this.client.on('error', (err) => logger.error({ err: err.message }, 'portal client error'))
    await this.client.connect()
    this.displayName = this.client.cache.persona?.displayName ?? ''
    logger.info({ personaId: this.personaId, displayName: this.displayName }, 'portal connector ready')
  }

  async close(): Promise<void> {
    for (const t of this.typingIntervals.values()) clearInterval(t)
    this.typingIntervals.clear()
    this.client.close()
  }

  // ── Inbound ──

  private onEvent(e: PortalEvent): void {
    if (e.type === 'message_create' || e.type === 'message_update') this.recordSeen(e.message)
    // Keep the pin cache warm so the hot-path getCachedPinned* getters stay fresh.
    // A thread's pins are cached under the thread, as every other thread event is.
    if (e.type === 'pins_update') void this.bootstrapPins(e.threadId ?? e.channelId)
    const ev = queueEventFromPortal(e, this.adapterCtx())
    if (ev) this.queue.push(ev)
  }

  private adapterCtx(): AdapterCtx {
    return {
      botPersonaId: this.personaId,
      authorOf: (id) => this.seen.get(id)?.authorId,
      guildOf: (channelId) => this.client.cache.getChannel(channelId)?.guildId ?? '',
    }
  }

  private recordSeen(pm: PortalMessage): void {
    this.remember(pm.id, { authorId: authorOfMessage(pm).id, nativeId: pm.nativeId })
  }

  /** Remember a message, most recent last, keeping at most SEEN_CAP. */
  private remember(id: string, entry: { authorId: string; nativeId?: string }): void {
    this.seen.delete(id)
    this.seen.set(id, entry)
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  /** A message id's Discord snowflake: an id that is all digits already is one
   *  (the API passes snowflakes from Discord URLs); a relay id is looked up in
   *  what this process has seen, since its format isn't the protocol's to
   *  promise. Undefined when neither says. */
  private snowflakeOf(id: string): string | undefined {
    return /^\d+$/.test(id) ? id : this.seen.get(id)?.nativeId
  }

  // ── Identity ──

  getBotUserId(): string | undefined {
    return this.personaId
  }
  isPortal(): boolean {
    return true
  }
  getBotUsername(): string | undefined {
    return this.displayName || undefined
  }
  getBotDiscordIdentity(): { userId?: string; username?: string; globalName?: string } {
    return { userId: this.personaId, username: this.displayName, globalName: this.displayName }
  }
  generateInviteUrl(): string | undefined {
    return undefined // the relay owns the gateway + invite
  }

  // ── Send ──

  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]> {
    const { chunks } = splitPreservingMarkdown(normalizeOutgoingMentions(content), MESSAGE_CHUNK_CHARS)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      ids.push(await this.sendChunk(channelId, chunks[i]!.text, i === 0 ? replyToMessageId : undefined))
    }
    return ids
  }

  async sendSegmentChunks(
    channelId: string,
    content: string,
    replyToMessageId: string | undefined,
    startCarry: MarkdownCarry,
  ): Promise<{ chunks: SentMessageChunk[]; endCarry: MarkdownCarry }> {
    const { chunks, endCarry } = splitPreservingMarkdown(
      normalizeOutgoingMentions(content),
      MESSAGE_CHUNK_CHARS,
      startCarry,
    )
    const sent: SentMessageChunk[] = []
    for (let i = 0; i < chunks.length; i++) {
      const piece = chunks[i]!
      const id = await this.sendChunk(channelId, piece.text, i === 0 ? replyToMessageId : undefined)
      sent.push({ id, bridgeOpen: piece.bridgeOpen, bridgeClose: piece.bridgeClose })
    }
    return { chunks: sent, endCarry }
  }

  /** Send one pre-sized chunk. The relay resolves a thread id passed as channelId
   *  into parent and thread. Only a response's first chunk replies to the trigger,
   *  as on DiscordConnector, so replies don't pile up on the original message. */
  private async sendChunk(channelId: string, content: string, replyToId?: string): Promise<string> {
    const { messageId } = await this.client.sendMessage({ channelId, content, replyToId })
    this.remember(messageId, { authorId: this.personaId })
    return messageId
  }

  async sendMessageWithAttachment(
    channelId: string,
    content: string,
    attachment: { name: string; content: string },
    replyToMessageId?: string,
  ): Promise<string[]> {
    const file = fileFromBytes(attachment.name, Buffer.from(attachment.content, 'utf-8'))
    const { messageId } = await this.client.sendMessage({
      channelId,
      content: content ? normalizeOutgoingMentions(content) : undefined,
      files: [file],
      replyToId: replyToMessageId,
    })
    this.remember(messageId, { authorId: this.personaId })
    return [messageId]
  }

  async sendImageAttachment(
    channelId: string,
    imageBase64: string,
    mediaType = 'image/png',
    caption?: string,
    replyToMessageId?: string,
  ): Promise<string[]> {
    const ext = mediaType.split('/')[1] || 'png'
    const file = fileFromBytes(`image.${ext}`, Buffer.from(imageBase64, 'base64'), { contentType: mediaType })
    const { messageId } = await this.client.sendMessage({
      channelId,
      content: caption ? normalizeOutgoingMentions(caption) : undefined,
      files: [file],
      replyToId: replyToMessageId,
    })
    this.remember(messageId, { authorId: this.personaId })
    return [messageId]
  }

  async sendFileAttachment(
    channelId: string,
    fileBuffer: Buffer,
    filename: string,
    contentType: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<string[]> {
    const file = fileFromBytes(filename, fileBuffer, { contentType })
    const { messageId } = await this.client.sendMessage({
      channelId,
      content: caption ? normalizeOutgoingMentions(caption) : undefined,
      files: [file],
      replyToId: replyToMessageId,
    })
    this.remember(messageId, { authorId: this.personaId })
    return [messageId]
  }

  async sendWebhook(channelId: string, content: string, username: string): Promise<void> {
    // A persona is itself one webhook identity; inline the tool name for attribution.
    await this.sendMessage(channelId, `**${username}:** ${content}`)
  }

  // ── Edit / react / pin / delete ──

  async editMessage(_channelId: string, messageId: string, newContent: string): Promise<void> {
    await this.client.editMessage(messageId, normalizeOutgoingMentions(newContent))
  }

  async findAndEditBotMessage(
    channelId: string,
    contentPrefix: string,
    newContent: string,
    maxMessages = 20,
  ): Promise<boolean> {
    // The newest of our messages with the prefix, as on DiscordConnector.
    const { messages } = await this.client.fetchHistory({ channelId, limit: maxMessages })
    const target = newestFirst(messages).find(
      (m) => m.author.kind === 'persona' && m.author.personaId === this.personaId && m.content.startsWith(contentPrefix),
    )
    if (!target) return false
    await this.client.editMessage(target.id, normalizeOutgoingMentions(newContent))
    return true
  }

  async deleteMessage(_channelId: string, messageId: string): Promise<void> {
    await this.client.deleteMessage(messageId)
  }

  async addReaction(_channelId: string, messageId: string, emoji: string): Promise<void> {
    // Personas can't add native Discord reactions; the relay records a pseudo
    // reaction, which humans don't see.
    await this.client.react(messageId, emoji, false)
  }

  async reactToLatestMessage(channelId: string, emoji: string): Promise<void> {
    // Best effort, as on DiscordConnector: the loop calls this after refusing an
    // `m continue` and returns right after, so a relay error mustn't escape.
    try {
      const { messages } = await this.client.fetchHistory({ channelId, limit: 1 })
      const latest = messages[0]
      if (latest) await this.client.react(latest.id, emoji, false)
    } catch (err) {
      logger.warn({ err: (err as Error).message, channelId, emoji }, 'portal: failed to react to the latest message')
    }
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    // Portal has no pin-mutation RPC (list_pins is read-only). Callers such as
    // the .sleep and config tools pin to make something take effect, so a silent
    // success would tell them it had.
    logger.warn({ channelId, messageId }, 'portal: pinMessage unsupported (no pin-mutation RPC)')
    throw new Error("Pinning isn't available on the portal backend: the relay has no pin RPC, so the message wasn't pinned.")
  }

  // ── Typing ──

  async startTyping(channelId: string): Promise<void> {
    if (this.typingIntervals.has(channelId)) return
    const fire = () =>
      this.client
        .call('set_typing', { channelId })
        .catch((err) => logger.debug({ err: (err as Error).message, channelId }, 'portal: set_typing failed'))
    fire()
    this.typingIntervals.set(channelId, setInterval(fire, TYPING_REFRESH_MS))
  }

  async stopTyping(channelId: string): Promise<void> {
    const t = this.typingIntervals.get(channelId)
    if (t) {
      clearInterval(t)
      this.typingIntervals.delete(channelId)
    }
  }

  // ── Context / history ──

  async fetchContext(params: FetchContextParams): Promise<DiscordContext> {
    return buildPortalContext(params, this.contextDeps())
  }

  /** Build the injected deps for the .history engine + context assembly. */
  private contextDeps(): ContextDeps {
    return {
      botPersonaId: this.personaId,
      attachments: this.attachments,
      // As DiscordConnector's fetch deps do, a failed fetch gives an empty batch
      // or no message, so one RPC error shortens the context instead of failing it.
      fetchBatch: async (channelId, opts) => {
        try {
          const { messages } = await this.client.fetchHistory({ channelId, before: opts.before, limit: opts.limit })
          for (const m of messages) this.recordSeen(m)
          return messages
        } catch (err) {
          logger.warn({ err: (err as Error).message, channelId, opts }, 'portal: fetch_history failed, returning an empty batch')
          return []
        }
      },
      snowflakeOf: (id) => this.snowflakeOf(id),
      fetchSingle: async (channelId, snowflake) => {
        try {
          return await this.fetchSingleBySnowflake(channelId, snowflake)
        } catch (err) {
          logger.warn({ err: (err as Error).message, channelId, snowflake }, 'portal: single fetch failed')
          return null
        }
      },
      resolveChannelBySnowflake: (snowflake) => this.resolveChannelBySnowflake(snowflake),
      authorRoles: (pm) => this.authorRolesOf(pm),
      channelMeta: (channelId) => {
        const ch = this.client.cache.getChannel(channelId)
        if (!ch) return null
        return { guildId: ch.guildId ?? '', isThread: ch.type === 'thread', parentId: ch.parentId, native: ch.native }
      },
    }
  }

  /** Fetch the single message whose snowflake === `snowflake`, or null. Portal
   *  `fetch_history` `before` is exclusive, so ask for the page before snowflake+1. */
  private async fetchSingleBySnowflake(channelId: string, snowflake: string): Promise<PortalMessage | null> {
    let before: string | undefined
    try {
      before = (BigInt(snowflake) + 1n).toString()
    } catch {
      before = undefined
    }
    const { messages } = await this.client.fetchHistory({ channelId, before, limit: 1 })
    const m = messages[0]
    if (!m || m.nativeId !== snowflake) return null
    this.recordSeen(m)
    return m
  }

  /** Resolve a Discord channel snowflake (from a .history URL) to a portal
   *  channel ref, populating the cache via list_channels on a miss. */
  private async resolveChannelBySnowflake(snowflake: string): Promise<PortalChannelRef | null> {
    let ch = this.client.cache.allChannels().find((c) => c.native === snowflake)
    if (!ch) {
      for (const g of this.client.cache.allGuilds()) {
        await this.client.call('list_channels', { guildId: g.id }).catch(() => undefined)
      }
      ch = this.client.cache.allChannels().find((c) => c.native === snowflake)
    }
    return ch ? { id: ch.id, isTextBased: isTextBasedType(ch.type) } : null
  }

  async getChannelMeta(
    channelId: string,
  ): Promise<{ name?: string; isThread: boolean; parentChannelId?: string }> {
    const ch = this.client.cache.getChannel(channelId)
    return {
      name: ch?.name ?? undefined,
      isThread: ch?.type === 'thread',
      parentChannelId: ch?.parentId,
    }
  }

  async getParentChannelId(channelId: string): Promise<string | undefined> {
    return this.client.cache.getChannel(channelId)?.parentId
  }

  async getMessageBefore(
    channelId: string,
    beforeMessageId: string,
  ): Promise<{ id: string; author: { id: string; bot: boolean } } | null> {
    const { messages } = await this.client.fetchHistory({ channelId, before: beforeMessageId, limit: 1 })
    const m = messages[0]
    if (!m) return null
    const a = authorOfMessage(m)
    return { id: m.id, author: { id: a.id, bot: a.bot } }
  }

  async getBotReplyChainDepth(
    channelId: string,
    message: { id: string; author?: { id?: string; bot?: boolean }; reference?: { messageId?: string } },
  ): Promise<number> {
    // The walk starts at the message itself, so a human's message costs no RPC.
    // Each link it needs is looked up in the channel's history, paging back
    // until it's found or CHAIN_PAGES pages have been read. A failed fetch ends
    // the walk where it is, as a failed fetch of a reply's target does on the
    // Discord backend.
    const seen = new Map<string, PortalMessage>()
    let before: string | undefined
    let pages = 0
    let exhausted = false
    const lookup = async (id: string) => {
      while (!seen.has(id) && !exhausted && pages < CHAIN_PAGES) {
        let page: PortalMessage[]
        try {
          page = newestFirst((await this.client.fetchHistory({ channelId, before, limit: 100 })).messages)
        } catch (err) {
          logger.debug({ err: (err as Error).message, channelId }, 'portal: reply-chain fetch failed, ending the walk')
          exhausted = true
          break
        }
        pages++
        for (const m of page) {
          seen.set(m.id, m)
          this.recordSeen(m)
        }
        const oldest = page[page.length - 1]
        if (!oldest) exhausted = true
        else before = oldest.nativeId
      }
      const m = seen.get(id)
      if (!m) return null
      const a = authorOfMessage(m)
      return { authorId: a.id, bot: a.bot, replyTo: m.replyToId }
    }
    return replyChainDepth(
      { authorId: message.author?.id, bot: !!message.author?.bot, replyTo: message.reference?.messageId },
      lookup,
    )
  }

  // ── Pins ──

  /** Bootstrap (or refresh) a channel's pin cache via list_pins, one request at
   *  a time per channel (see pinLoads). A failed request caches nothing, so the
   *  next read asks again. */
  private bootstrapPins(channelId: string): Promise<void> {
    const inProgress = this.pinLoads.get(channelId)
    if (inProgress) {
      inProgress.again = true
      return inProgress.done
    }
    const load = { done: Promise.resolve(), again: true }
    load.done = (async () => {
      try {
        while (load.again) {
          load.again = false
          try {
            const { messages } = await this.client.call('list_pins', { channelId })
            this.pinnedByChannel.set(channelId, messages.map(portalMessageToTrackedPin))
          } catch (err) {
            logger.warn({ err: (err as Error).message, channelId }, 'portal: list_pins failed')
          }
        }
      } finally {
        this.pinLoads.delete(channelId)
      }
    })()
    this.pinLoads.set(channelId, load)
    return load.done
  }

  private async ensurePins(channelId: string): Promise<TrackedPin[]> {
    let pins = this.pinnedByChannel.get(channelId)
    if (!pins) {
      await this.bootstrapPins(channelId)
      pins = this.pinnedByChannel.get(channelId)
    }
    return pins ?? []
  }

  /** Identity the relay-routed persona resolves pin targets against: its persona
   *  id (relay-resolved role mentions) and display name. botId / config name are
   *  matched downstream in config parsing. */
  private pinMatchContext(): { identity: BotIdentity } {
    return {
      identity: {
        botId: '',
        discordUsername: this.getBotUsername() ?? undefined,
        discordUserId: this.getBotUserId() ?? undefined,
      },
    }
  }

  /** Portal personas have no own guild roles; targeting is via persona mention. */
  getOwnRoleIds(_channelId: string): string[] | null {
    return null
  }

  async fetchPinnedConfigs(channelId: string): Promise<string[]> {
    return extractConfigs(await this.ensurePins(channelId), this.pinMatchContext())
  }
  async fetchPinnedSteerMessages(channelId: string): Promise<PinnedSteer[]> {
    return extractSteers(await this.ensurePins(channelId))
  }
  async fetchPinnedSleeps(channelId: string): Promise<TrackedPin[]> {
    return extractSleeps(await this.ensurePins(channelId))
  }
  getCachedPinnedConfigs(channelId: string): string[] | null {
    const pins = this.pinnedByChannel.get(channelId)
    return pins ? extractConfigs(pins, this.pinMatchContext()) : null
  }
  getCachedPinnedSteers(channelId: string): PinnedSteer[] | null {
    const pins = this.pinnedByChannel.get(channelId)
    return pins ? extractSteers(pins) : null
  }
  getCachedPinnedSleeps(channelId: string): TrackedPin[] | null {
    const pins = this.pinnedByChannel.get(channelId)
    return pins ? extractSleeps(pins) : null
  }

  // ── Auth (role names via list_members + list_roles) ──

  /** guildId → (roleId → name), cached with a short TTL. */
  private async rolesFor(guildId: string): Promise<Map<string, string>> {
    const cached = this.roleNameCache.get(guildId)
    if (cached && Date.now() - cached.at < ROLE_CACHE_TTL_MS) return cached.map
    const { roles } = await this.client.call('list_roles', { guildId })
    const map = new Map(roles.map((r) => [r.id, r.name]))
    this.roleNameCache.set(guildId, { map, at: Date.now() })
    return map
  }

  async fetchMemberRoles(userId: string, guildId: string): Promise<string[] | null> {
    try {
      // One list_members call returns at most 1,000 members, and the protocol
      // has no lookup by user id. When the relay's roster is partial
      // (membersAvailable false), a member in it still has their roles read.
      const { members, membersAvailable } = await this.client.call('list_members', { guildId, limit: 1000 })
      const member = members.find((m) => m.userId === userId)
      if (!member) {
        logger.info(
          { userId, guildId, listed: members.length, membersAvailable },
          membersAvailable
            ? 'portal: member not among those list_members returned, so their roles are unverified'
            : "portal: member not in the relay's partial roster, so their roles are unverified",
        )
        return null
      }
      const names = await this.rolesFor(guildId)
      return member.roles.map((id) => names.get(id)).filter((n): n is string => !!n)
    } catch (err) {
      logger.warn({ err: (err as Error).message, userId, guildId }, 'portal: fetchMemberRoles failed')
      return null
    }
  }

  /** Role names of a message's author (for .history auth); null if not a guild user. */
  private async authorRolesOf(pm: PortalMessage): Promise<string[] | null> {
    if (!pm.guildId || pm.author.kind !== 'user') return null
    return this.fetchMemberRoles(pm.author.userId, pm.guildId)
  }
}
