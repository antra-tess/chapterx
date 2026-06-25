/**
 * Backend-agnostic connector contract.
 *
 * Both `DiscordConnector` (own discord.js gateway) and `PortalConnector` (routed
 * through the shared portal-relay) implement `IConnector`. The agent loop, API
 * server, and sleep logic depend only on this interface, so the backend is
 * selectable at runtime (see `CONNECTOR_BACKEND` in main.ts).
 *
 * `ConnectorOptions`, `TrackedPin`, and `FetchContextParams` live here (rather
 * than in discord/connector.ts) so the portal backend can reference them without
 * importing discord.js. connector.ts re-exports them for back-compat.
 */
import type { DiscordContext } from '../types.js'

export interface ConnectorOptions {
  token: string
  cacheDir: string
  maxBackoffMs: number
}

/**
 * A pinned message tracked via gateway/relay events. The minimal set of fields
 * needed to resolve .config / .steer / .sleep without re-hitting a pins endpoint.
 */
export interface TrackedPin {
  id: string
  content: string
  authorId: string
  authorBot: boolean
  /** Relay-resolved persona ids addressed by this pin (portal backend only). */
  mentionedPersonaIds?: string[]
  /** Discord/relay role ids mentioned in this pin (for `<@&roleId>` targeting). */
  mentionedRoleIds?: string[]
}

/** A pinned `.steer` message with its resolved mention context. */
export interface PinnedSteer {
  content: string
  authorId: string
  mentionedPersonaIds?: string[]
  mentionedRoleIds?: string[]
}

export interface FetchContextParams {
  channelId: string
  depth: number // Max messages
  targetMessageId?: string // Fetch backward from this message ID (API range queries)
  firstMessageId?: string // Stop when this message is encountered
  authorized_roles?: string[]
  pinnedConfigs?: string[] // Pre-fetched pinned configs (skips fetchPinned call)
  maxImages?: number // Cap image fetching (default: unlimited)
  ignoreHistory?: boolean // Skip .history command processing (raw fetch)
}

/**
 * The discord.js-`Message`-compatible shape the agent loop reads off the
 * EventQueue's `event.data`. The discord.js backend pushes real `Message`
 * objects (which structurally satisfy this); the portal backend synthesizes it
 * from a `PortalMessage` (see connector/portal/adapters.ts). `event.data` is
 * typed `any`, so this type is documentation + the adapter's construction target.
 */
export interface InboundMessage {
  id: string
  channelId: string
  guildId: string
  content: string
  author: { id: string; username: string; bot: boolean; globalName?: string }
  system?: boolean
  pinned?: boolean
  reference?: { messageId?: string }
  mentions: { has(id: string): boolean; users?: Map<string, unknown> }
  reactions?: { cache: { some(fn: (r: unknown) => boolean): boolean } }
  member?: { roles: { cache: Map<string, { name: string }> } }
  /** Escape hatch: the source PortalMessage, for adapters that need raw fields. */
  _portal?: unknown
}

export interface IConnector {
  // ── Lifecycle ──
  start(): Promise<void>
  close(): Promise<void>

  // ── Identity ──
  getBotUserId(): string | undefined
  /** True for the portal-relay backend (no own Discord account). */
  isPortal(): boolean
  getBotUsername(): string | undefined
  getBotDiscordIdentity(): { userId?: string; username?: string; globalName?: string }
  generateInviteUrl(options?: {
    permissions?: bigint | string[]
    guildId?: string
    disableGuildSelect?: boolean
  }): string | undefined

  // ── Context / history ──
  fetchContext(params: FetchContextParams): Promise<DiscordContext>
  getChannelMeta(channelId: string): Promise<{ name?: string; isThread: boolean; parentChannelId?: string }>
  getParentChannelId(channelId: string): Promise<string | undefined>
  /** Narrowed from discord.js `Message` — callers only read `.id`/`.author`. */
  getMessageBefore(
    channelId: string,
    beforeMessageId: string,
  ): Promise<{ id: string; author: { id: string; bot: boolean } } | null>
  /** Narrowed param — reimplemented over reply chains. */
  getBotReplyChainDepth(
    channelId: string,
    message: { id: string; author?: { id?: string; bot?: boolean }; reference?: { messageId?: string } },
  ): Promise<number>

  // ── Pins (async fetch + sync cache) ──
  fetchPinnedConfigs(channelId: string): Promise<string[]>
  fetchPinnedSteerMessages(channelId: string): Promise<PinnedSteer[]>
  fetchPinnedSleeps(channelId: string): Promise<TrackedPin[]>
  getCachedPinnedConfigs(channelId: string): string[] | null
  getCachedPinnedSteers(channelId: string): PinnedSteer[] | null
  getCachedPinnedSleeps(channelId: string): TrackedPin[] | null
  /** The bot's own role ids in a channel's guild (account bots; null if uncached/portal). */
  getOwnRoleIds(channelId: string): string[] | null

  // ── Send ──
  sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]>
  sendMessageWithAttachment(
    channelId: string,
    content: string,
    attachment: { name: string; content: string },
    replyToMessageId?: string,
  ): Promise<string[]>
  sendImageAttachment(
    channelId: string,
    imageBase64: string,
    mediaType?: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<string[]>
  sendFileAttachment(
    channelId: string,
    fileBuffer: Buffer,
    filename: string,
    contentType: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<string[]>
  sendWebhook(channelId: string, content: string, username: string): Promise<void>

  // ── Edit / react / pin / delete ──
  editMessage(channelId: string, messageId: string, newContent: string): Promise<void>
  findAndEditBotMessage(
    channelId: string,
    contentPrefix: string,
    newContent: string,
    maxMessages?: number,
  ): Promise<boolean>
  deleteMessage(channelId: string, messageId: string): Promise<void>
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>
  reactToLatestMessage(channelId: string, emoji: string): Promise<void>
  pinMessage(channelId: string, messageId: string): Promise<void>

  // ── Typing ──
  startTyping(channelId: string): Promise<void>
  stopTyping(channelId: string): Promise<void>

  // ── Auth ──
  fetchMemberRoles(userId: string, guildId: string): Promise<string[] | null>
}
