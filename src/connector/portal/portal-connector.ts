/**
 * PortalConnector — IConnector backed by the shared portal-relay over a
 * websocket (portal-client), instead of an own discord.js gateway.
 *
 * Phase 1 scope: connect as a persona, feed inbound events to the EventQueue,
 * send/edit/delete/react/typing. fetchContext is minimal (live history only),
 * pins + role auth + attachment upload land in later phases. Degradations are
 * marked `P1 degrade` / `P-N` below.
 */
import { PortalClient, fileFromBytes } from '@animalabs/portal-client'
import type { PortalMessage, PortalEvent } from '@animalabs/portal-protocol'
import { EventQueue } from '../../agent/event-queue.js'
import type { DiscordContext } from '../../types.js'
import { logger } from '../../utils/logger.js'
import type { IConnector, FetchContextParams, TrackedPin, PinnedSteer } from '../types.js'
import { splitContent } from '../util/split.js'
import { queueEventFromPortal, authorOfMessage, type AdapterCtx } from './adapters.js'
import { AttachmentCache } from '../util/attachment-cache.js'
import { buildPortalContext, type ContextDeps } from './context.js'
import type { PortalChannelRef } from './history.js'
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

const AUTHOR_CAP = 5000
const TYPING_REFRESH_MS = 8000

export class PortalConnector implements IConnector {
  private client: PortalClient
  private personaId: string
  private displayName = ''
  private attachments: AttachmentCache
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
  /** relayId → author id, so deletes/reactions can resolve their author. */
  private authorById = new Map<string, string>()
  /** channelId → tracked pins (bootstrapped via list_pins, refreshed on pins_update). */
  private pinnedByChannel = new Map<string, TrackedPin[]>()
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
    if (e.type === 'message_create' || e.type === 'message_update') this.recordAuthor(e.message)
    // Keep the pin cache warm so the hot-path getCachedPinned* getters stay fresh.
    if (e.type === 'pins_update') void this.bootstrapPins(e.channelId)
    const ev = queueEventFromPortal(e, this.adapterCtx())
    if (ev) this.queue.push(ev)
  }

  private adapterCtx(): AdapterCtx {
    return {
      botPersonaId: this.personaId,
      authorOf: (id) => this.authorById.get(id),
      guildOf: (channelId) => this.client.cache.getChannel(channelId)?.guildId ?? '',
    }
  }

  private recordAuthor(pm: PortalMessage): void {
    this.authorById.set(pm.id, authorOfMessage(pm).id)
    if (this.authorById.size > AUTHOR_CAP) {
      const first = this.authorById.keys().next().value
      if (first !== undefined) this.authorById.delete(first)
    }
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
    const ids: string[] = []
    const chunks = splitContent(normalizeOutgoingMentions(content))
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      // The relay resolves a thread id passed as channelId into parent+thread.
      // Only the first chunk replies to the trigger (matches DiscordConnector);
      // forwarding replyToId on every chunk piles replies on the original message.
      const { messageId } = await this.client.sendMessage({
        channelId,
        content: chunk,
        replyToId: i === 0 ? replyToMessageId : undefined,
      })
      ids.push(messageId)
    }
    return ids
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
      content: content || undefined,
      files: [file],
      replyToId: replyToMessageId,
    })
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
      content: caption || undefined,
      files: [file],
      replyToId: replyToMessageId,
    })
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
      content: caption || undefined,
      files: [file],
      replyToId: replyToMessageId,
    })
    return [messageId]
  }

  async sendWebhook(channelId: string, content: string, username: string): Promise<void> {
    // A persona is itself one webhook identity; inline the tool name for attribution.
    await this.sendMessage(channelId, `**${username}:** ${content}`)
  }

  // ── Edit / react / pin / delete ──

  async editMessage(_channelId: string, messageId: string, newContent: string): Promise<void> {
    await this.client.editMessage(messageId, newContent)
  }

  async findAndEditBotMessage(
    channelId: string,
    contentPrefix: string,
    newContent: string,
    maxMessages = 20,
  ): Promise<boolean> {
    const { messages } = await this.client.fetchHistory({ channelId, limit: maxMessages })
    const target = messages.find(
      (m) => m.author.kind === 'persona' && m.author.personaId === this.personaId && m.content.startsWith(contentPrefix),
    )
    if (!target) return false
    await this.client.editMessage(target.id, newContent)
    return true
  }

  async deleteMessage(_channelId: string, messageId: string): Promise<void> {
    await this.client.deleteMessage(messageId)
  }

  async addReaction(_channelId: string, messageId: string, emoji: string): Promise<void> {
    // Personas can't add native Discord reactions; portal records a pseudo
    // reaction (structured, not shown to humans). Visible feedback is P4.
    await this.client.react(messageId, emoji, false)
  }

  async reactToLatestMessage(channelId: string, emoji: string): Promise<void> {
    const { messages } = await this.client.fetchHistory({ channelId, limit: 1 })
    const latest = messages[0]
    if (latest) await this.client.react(latest.id, emoji, false)
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    // Portal has no pin-mutation RPC (read-only list_pins). No-op + warn.
    logger.warn({ channelId, messageId }, 'portal: pinMessage unsupported (no pin-mutation RPC)')
  }

  // ── Typing ──

  async startTyping(channelId: string): Promise<void> {
    if (this.typingIntervals.has(channelId)) return
    const fire = () => this.client.call('set_typing', { channelId }).catch(() => {})
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
      fetchBatch: async (channelId, opts) => {
        const { messages } = await this.client.fetchHistory({ channelId, before: opts.before, limit: opts.limit })
        return messages
      },
      fetchSingle: (channelId, snowflake) => this.fetchSingleBySnowflake(channelId, snowflake),
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
    return m && m.nativeId === snowflake ? m : null
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
    // Walk the reply chain over a recent window, counting consecutive bot msgs.
    const { messages } = await this.client.fetchHistory({ channelId, limit: 100 })
    const byId = new Map(messages.map((m) => [m.id, m]))
    let depth = 0
    let cursor = message.reference?.messageId
    while (cursor) {
      const m = byId.get(cursor)
      if (!m) break
      const a = authorOfMessage(m)
      if (!a.bot) break
      depth++
      cursor = m.replyToId
    }
    return depth
  }

  // ── Pins ──

  /** Bootstrap (or refresh) a channel's pin cache via list_pins. */
  private async bootstrapPins(channelId: string): Promise<void> {
    try {
      const { messages } = await this.client.call('list_pins', { channelId })
      this.pinnedByChannel.set(channelId, messages.map(portalMessageToTrackedPin))
    } catch (err) {
      logger.warn({ err: (err as Error).message, channelId }, 'portal: list_pins failed')
      if (!this.pinnedByChannel.has(channelId)) this.pinnedByChannel.set(channelId, [])
    }
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
      const { members, membersAvailable } = await this.client.call('list_members', { guildId, limit: 1000 })
      if (!membersAvailable) return null
      const member = members.find((m) => m.userId === userId)
      if (!member) return null
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
