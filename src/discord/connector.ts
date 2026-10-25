import { Attachment, Client, Collection, GatewayIntentBits, Message, MessageFlags, Partials, PermissionFlagsBits, OAuth2Scopes, TextChannel, type MessageMentionOptions } from 'discord.js'
import { pinAddressesBot } from '../agent/pin-target.js'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import sharp from 'sharp'
import { EventQueue } from '../agent/event-queue.js'
import {
  DiscordContext,
  DiscordMessage,
  CachedImage,
  CachedDocument,
  DiscordError,
} from '../types.js'
import { logger } from '../utils/logger.js'
import { retryDiscord } from '../utils/retry.js'
import { codeRanges, splitPreservingMarkdown, type MarkdownCarry } from '../utils/discord-markdown.js'
import {
  fetchChannelMessages,
  type FetchDeps,
} from './context-fetch.js'
import { AuthorMembers, type DisplayNameClasses } from './member-names.js'

export interface ConnectorOptions {
  token: string
  cacheDir: string
  maxBackoffMs: number
}

export interface TrackedPin {
  id: string
  content: string
  authorId: string
  authorBot: boolean
  mentionedPersonaIds?: string[]
  mentionedRoleIds?: string[]
}

export interface PinnedSteer {
  content: string
  authorId: string
  mentionedPersonaIds?: string[]
  mentionedRoleIds?: string[]
}

function extractMentionedRoleIds(
  mentions?: { roles?: { values(): IterableIterator<{ id: string }> } } | null,
): string[] | undefined {
  const roles = mentions?.roles
  if (!roles) return undefined
  const ids = Array.from(roles.values(), (r) => r.id)
  return ids.length ? ids : undefined
}

const MAX_TEXT_ATTACHMENT_BYTES = 200_000
const DISCORD_MESSAGE_LIMIT = 2000
export const HISTORY_AND_FILTER_BUFFER = 100

function snowflakeToTimestamp(id: string): number {
  const DISCORD_EPOCH = 1420070400000
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH
}

export interface FetchContextParams {
  channelId: string
  depth: number
  targetMessageId?: string
  firstMessageId?: string
  authorized_roles?: string[]
  pinnedConfigs?: string[]
  maxImages?: number
  ignoreHistory?: boolean
  displayNames?: DisplayNameClasses
}

export interface SentMessageChunk {
  id: string
  bridgeOpen?: string
  bridgeClose?: string
}

export const SYSTEM_PLACEHOLDER_ID = 'system'

/** Once a message carries allowed_mentions, Discord pings only what that
 *  field allows (its default of every mention type applies only when the
 *  field is left out), so `repliedUser: false` alone would keep every
 *  mention in a reply silent. */
function replyAllowedMentions(): MessageMentionOptions {
  return { repliedUser: false, parse: ['users'] }
}

export class DiscordConnector {
  private client: Client
  private typingIntervals = new Map<string, NodeJS.Timeout>()
  private closed = false
  private authorMembers = new AuthorMembers()
  private imageCache = new Map<string, CachedImage>()
  private urlToFilename = new Map<string, string>()
  private urlMapPath: string

  private messageCache = new Map<string, (Message | null)[]>()
  private messageCacheIndex = new Map<string, Map<string, number>>()
  private messageCachePopulated = new Set<string>()

  private pinnedByChannel = new Map<string, Map<string, TrackedPin>>()
  private pinCacheDir: string | null = null
  private pinPersistTimers = new Map<string, NodeJS.Timeout>()

  private cacheStats = { hits: 0, misses: 0, apiCalls: 0, evictions: 0 }
  private cacheStatsInterval?: NodeJS.Timeout
  private evictionInterval?: NodeJS.Timeout

  constructor(
    private queue: EventQueue,
    private options: ConnectorOptions
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Reaction],
    })

    this.setupEventHandlers()

    if (!existsSync(options.cacheDir)) {
      mkdirSync(options.cacheDir, { recursive: true })
    }
    
    this.urlMapPath = join(options.cacheDir, 'url-map.json')
    this.loadUrlMap()

    this.pinCacheDir = join(options.cacheDir, 'pins')
    if (!existsSync(this.pinCacheDir)) {
      mkdirSync(this.pinCacheDir, { recursive: true })
    }
    this.loadTrackedPinsFromDisk()
  }

  private getOrCreateChannelPinMap(channelId: string): Map<string, TrackedPin> {
    let m = this.pinnedByChannel.get(channelId)
    if (!m) {
      m = new Map()
      this.pinnedByChannel.set(channelId, m)
    }
    return m
  }

  private trackPin(channelId: string, message: Pick<Message, 'id' | 'content'> & {
    author?: { id?: string; bot?: boolean } | null
    mentions?: { roles?: { values(): IterableIterator<{ id: string }> } } | null
  }): void {
    const pins = this.getOrCreateChannelPinMap(channelId)
    pins.set(message.id, {
      id: message.id,
      content: message.content ?? '',
      authorId: message.author?.id ?? '',
      authorBot: message.author?.bot ?? false,
      mentionedRoleIds: extractMentionedRoleIds(message.mentions),
    })
    this.schedulePinCachePersist(channelId)
  }

  private schedulePinCachePersist(channelId: string): void {
    const existing = this.pinPersistTimers.get(channelId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pinPersistTimers.delete(channelId)
      this.persistTrackedPins(channelId)
    }, 1000)
    this.pinPersistTimers.set(channelId, timer)
  }

  private persistTrackedPins(channelId: string): void {
    if (!this.pinCacheDir) return
    const pins = this.pinnedByChannel.get(channelId)
    if (!pins) return
    try {
      const data: TrackedPin[] = [...pins.values()]
      writeFileSync(join(this.pinCacheDir, `${channelId}.json`), JSON.stringify(data), 'utf-8')
    } catch (err) {
      logger.warn({ err, channelId }, 'Failed to persist tracked-pin cache')
    }
  }

  private loadTrackedPinsFromDisk(): void {
    if (!this.pinCacheDir || !existsSync(this.pinCacheDir)) return
    try {
      const files = readdirSync(this.pinCacheDir).filter(f => f.endsWith('.json'))
      let loaded = 0
      for (const file of files) {
        const channelId = file.replace('.json', '')
        try {
          const raw = readFileSync(join(this.pinCacheDir, file), 'utf-8')
          const data = JSON.parse(raw) as TrackedPin[]
          if (!Array.isArray(data)) continue
          const map = new Map<string, TrackedPin>()
          for (const pin of data) {
            if (pin?.id) map.set(pin.id, pin)
          }
          this.pinnedByChannel.set(channelId, map)
          loaded++
        } catch {
        }
      }
      if (loaded > 0) {
        logger.info({ channels: loaded }, 'Tracked-pin cache loaded from disk')
      }
    } catch (err) {
      logger.warn({ err }, 'Tracked-pin disk load failed')
    }
  }

  private async bootstrapChannelPins(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel | null
      if (!channel || !channel.isTextBased()) {
        this.pinnedByChannel.set(channelId, new Map())
        return
      }
      const { messages: pinnedMessages, failed } = await this.fetchPinnedWithTimeout(channel, 10000)
      if (failed) {
        logger.warn({ channelId }, 'Tracked-pin bootstrap failed — events will populate when pins mutate')
        this.pinnedByChannel.set(channelId, new Map())
        return
      }
      const pins = this.getOrCreateChannelPinMap(channelId)
      for (const msg of pinnedMessages.values()) {
        pins.set(msg.id, {
          id: msg.id,
          content: msg.content ?? '',
          authorId: msg.author?.id ?? '',
          authorBot: msg.author?.bot ?? false,
          mentionedRoleIds: extractMentionedRoleIds(msg.mentions),
        })
      }
      this.schedulePinCachePersist(channelId)
      logger.info({ channelId, pinCount: pins.size }, 'Tracked-pin cache bootstrapped from API')
    } catch (error) {
      logger.warn({ error, channelId }, 'Tracked-pin bootstrap errored')
      this.pinnedByChannel.set(channelId, new Map())
    }
  }

  private extractConfigsFromTrackedPins(pins: Map<string, TrackedPin>, channelId: string): string[] {
    const sorted = [...pins.values()].sort((a, b) => a.id.localeCompare(b.id))
    return this.extractConfigs(sorted, channelId)
  }

  private extractSteersFromTrackedPins(pins: Map<string, TrackedPin>): PinnedSteer[] {
    const sorted = [...pins.values()].sort((a, b) => a.id.localeCompare(b.id))
    const out: PinnedSteer[] = []
    for (const pin of sorted) {
      if (pin.content.startsWith('.steer') && !pin.authorBot) {
        out.push({
          content: pin.content,
          authorId: pin.authorId,
          mentionedPersonaIds: pin.mentionedPersonaIds,
          mentionedRoleIds: pin.mentionedRoleIds,
        })
      }
    }
    return out
  }

  private extractSleepsFromTrackedPins(pins: Map<string, TrackedPin>): TrackedPin[] {
    const sorted = [...pins.values()].sort((a, b) => a.id.localeCompare(b.id))
    return sorted.filter((p) => p.content.startsWith('.sleep'))
  }

  private loadUrlMap(): void {
    try {
      if (existsSync(this.urlMapPath)) {
        const data = readFileSync(this.urlMapPath, 'utf-8')
        const map = JSON.parse(data) as Record<string, string>
        for (const [url, filename] of Object.entries(map)) {
          this.urlToFilename.set(url, filename)
        }
        logger.debug({ count: this.urlToFilename.size }, 'Loaded image URL map from disk')
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load image URL map, starting fresh')
    }
  }
  
  private saveUrlMap(): void {
    try {
      const map: Record<string, string> = {}
      for (const [url, filename] of this.urlToFilename) {
        map[url] = filename
      }
      writeFileSync(this.urlMapPath, JSON.stringify(map))
    } catch (error) {
      logger.warn({ error }, 'Failed to save image URL map')
    }
  }

  async start(): Promise<void> {
    try {
      await this.client.login(this.options.token)
      logger.info({ userId: this.client.user?.id, tag: this.client.user?.tag }, 'Discord connector started')

      this.cacheStatsInterval = setInterval(() => {
        if (this.cacheStats.hits + this.cacheStats.misses > 0) {
          const hitRate = this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses)
          logger.info({
            ...this.cacheStats,
            hitRate: hitRate.toFixed(3),
            channels: this.messageCache.size,
            totalMessages: Array.from(this.messageCache.values()).reduce((sum, msgs) => sum + msgs.filter(m => m !== null).length, 0),
          }, 'Message cache stats')
        }
      }, 5 * 60 * 1000)

      this.evictionInterval = setInterval(() => this.evictStaleMessages(), 5 * 60 * 1000)
    } catch (error) {
      logger.error({ error }, 'Failed to start Discord connector')
      throw new DiscordError('Failed to connect to Discord', error)
    }
  }

  getBotUserId(): string | undefined {
    return this.client.user?.id
  }

  getBotUsername(): string | undefined {
    return this.client.user?.username
  }

  generateInviteUrl(options?: {
    permissions?: bigint | (keyof typeof PermissionFlagsBits)[];
    guildId?: string;
    disableGuildSelect?: boolean;
  }): string | undefined {
    if (!this.client.user) {
      return undefined
    }

    const defaultPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.UseExternalEmojis,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ].reduce((acc, perm) => acc | perm, 0n)

    let permissions: bigint
    if (options?.permissions) {
      if (typeof options.permissions === 'bigint') {
        permissions = options.permissions
      } else {
        permissions = options.permissions.reduce(
          (acc, name) => acc | PermissionFlagsBits[name],
          0n
        )
      }
    } else {
      permissions = defaultPermissions
    }

    return this.client.generateInvite({
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      permissions,
      guild: options?.guildId,
      disableGuildSelect: options?.disableGuildSelect,
    })
  }

  async getChannelName(channelId: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      return channel?.name || undefined
    } catch {
      return undefined
    }
  }

  async getChannelMeta(channelId: string): Promise<{ name?: string; isThread: boolean; parentChannelId?: string }> {
    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel) return { isThread: false }
      const isThread = 'isThread' in channel && typeof channel.isThread === 'function' ? channel.isThread() : false
      return {
        name: 'name' in channel ? (channel.name as string) || undefined : undefined,
        isThread,
        parentChannelId: isThread && 'parentId' in channel ? (channel.parentId as string) || undefined : undefined,
      }
    } catch {
      return { isThread: false }
    }
  }

  async fetchPinnedConfigs(channelId: string): Promise<string[]> {
    let pins = this.pinnedByChannel.get(channelId)
    if (!pins) {
      await this.bootstrapChannelPins(channelId)
      pins = this.pinnedByChannel.get(channelId)
    }
    if (!pins) return []
    return this.extractConfigsFromTrackedPins(pins, channelId)
  }

  async fetchPinnedSteerMessages(channelId: string): Promise<PinnedSteer[]> {
    let pins = this.pinnedByChannel.get(channelId)
    if (!pins) {
      await this.bootstrapChannelPins(channelId)
      pins = this.pinnedByChannel.get(channelId)
    }
    if (!pins) return []
    return this.extractSteersFromTrackedPins(pins)
  }

  async fetchPinnedSleeps(channelId: string): Promise<TrackedPin[]> {
    let pins = this.pinnedByChannel.get(channelId)
    if (!pins) {
      await this.bootstrapChannelPins(channelId)
      pins = this.pinnedByChannel.get(channelId)
    }
    if (!pins) return []
    return this.extractSleepsFromTrackedPins(pins)
  }

  private buildFetchDeps(): FetchDeps {
    return {
      fetchBatch: async (ch: TextChannel, opts: { before?: string; limit: number }): Promise<Message[]> => {
        try {
          const fetched = await this.cachedFetchMessages(ch, opts)
          if (!fetched || (fetched as any).size === 0) return []
          return Array.from((fetched as any).values()) as Message[]
        } catch (error) {
          logger.warn({ error, channelId: ch.id, opts }, 'fetchBatch failed — returning empty batch')
          return []
        }
      },
      fetchSingle: async (ch: TextChannel, id: string): Promise<Message | null> => {
        try {
          const msg = await this.cachedFetchMessages(ch, id)
          return msg as Message | null
        } catch {
          return null
        }
      },
      resolveChannel: async (id: string): Promise<TextChannel | null> => {
        try {
          const ch = await this.client.channels.fetch(id)
          return ch && ch.isTextBased() ? ch as TextChannel : null
        } catch {
          return null
        }
      },
      botUserId: this.client.user?.id ?? '',
    }
  }

  async fetchContext(params: FetchContextParams): Promise<DiscordContext> {
    const { channelId, depth, targetMessageId, firstMessageId, authorized_roles, maxImages, ignoreHistory } = params

    const timings: Record<string, number> = {}
    const startProfile = (name: string) => {
      timings[`_start_${name}`] = Date.now()
    }
    const endProfile = (name: string) => {
      const start = timings[`_start_${name}`]
      if (start) {
        timings[name] = Date.now() - start
        delete timings[`_start_${name}`]
      }
    }

    return retryDiscord(async () => {
      startProfile('channelFetch')
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      endProfile('channelFetch')

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found or not text-based`)
      }

      const deps = this.buildFetchDeps()

      logger.debug({
        channelId: channel.id,
        targetMessageId,
        depth,
        isThread: channel.isThread(),
        ignoreHistory
      }, 'Starting context fetch pipeline')

      startProfile('messagesFetch')
      const fetchResult = await fetchChannelMessages(
        channel,
        targetMessageId,
        undefined,
        depth,
        authorized_roles ?? [],
        ignoreHistory ?? false,
        deps,
      )
      let messages = fetchResult.messages
      const historyDidClear = fetchResult.didClear
      let historyOriginChannelId = fetchResult.originChannelId
      endProfile('messagesFetch')

      let threadParentChannel: TextChannel | undefined = undefined
      let threadStartMessageId: string | undefined = undefined

      if (channel.isThread() && historyDidClear) {
        logger.debug('Skipping parent context fetch — .history cleared context')
      } else if (channel.isThread()) {
        startProfile('threadParentFetch')
        const thread = channel as any
        threadParentChannel = thread.parent as TextChannel
        threadStartMessageId = thread.id  // A thread started from a message shares that message's id

        if (threadParentChannel && threadParentChannel.isTextBased()) {
          logger.debug({
            threadId: thread.id,
            parentChannelId: threadParentChannel.id,
            threadStartMessageId,
            currentMessageCount: messages.length,
            remainingDepth: depth - messages.length
          }, 'Thread detected, fetching parent channel context')

          const parentResult = await fetchChannelMessages(
            threadParentChannel,
            threadStartMessageId,
            undefined,
            Math.max(0, depth - messages.length),
            authorized_roles ?? [],
            ignoreHistory ?? false,
            deps,
          )

          let parentMessages = parentResult.messages

          logger.debug({
            parentMessageCount: parentMessages.length,
            threadMessageCount: messages.length,
            parentDidClear: parentResult.didClear,
          }, 'Fetched parent context for thread')

          if (threadStartMessageId && !parentMessages.some(m => m.id === threadStartMessageId)) {
            try {
              const starterMsg = await deps.fetchSingle(threadParentChannel, threadStartMessageId)
              if (starterMsg) {
                parentMessages.push(starterMsg)
                logger.debug({ threadStartMessageId }, 'Explicitly added missing thread starter to parent context')
              }
            } catch (error) {
              logger.warn({ error, threadStartMessageId }, 'Failed to fetch thread starter message')
            }
          }

          messages = [...parentMessages, ...messages]

          if (parentResult.originChannelId && !historyOriginChannelId) {
            historyOriginChannelId = parentResult.originChannelId
          }

          if (parentResult.didClear) {
            logger.debug({
              parentChannelId: threadParentChannel.id,
              threadId: thread.id,
            }, 'Parent channel had .history clear — parent messages truncated but thread state unaffected')
          }
        }
        endProfile('threadParentFetch')
      }

      let cacheAnchorTrimmed = false
      let activeFirstMessageId = firstMessageId
      if (activeFirstMessageId && !historyDidClear) {
        logger.debug({
          currentMessageCount: messages.length,
          lookingFor: activeFirstMessageId
        }, 'Checking if cache anchor is in fetch window')

        let firstIndex = messages.findIndex(m => m.id === activeFirstMessageId)
        const oldestMessage = messages[0]

        if (firstIndex < 0 && oldestMessage) {
          const anchorTs = snowflakeToTimestamp(activeFirstMessageId)
          const oldestTs = snowflakeToTimestamp(oldestMessage.id)
          const gapMs = oldestTs - anchorTs
          const MAX_ANCHOR_GAP_MS = 24 * 60 * 60 * 1000

          if (gapMs > MAX_ANCHOR_GAP_MS) {
            logger.warn({
              firstMessageId: activeFirstMessageId,
              oldestNaturalId: oldestMessage.id,
              gapHours: Math.round(gapMs / (60 * 60 * 1000)),
            }, 'Cache anchor too old — skipping extension to prevent feedback loop')
            activeFirstMessageId = undefined
          }
        }

        if (firstIndex < 0 && oldestMessage && activeFirstMessageId) {
          const maxExtend = 500
          let extended = 0
          let currentBefore = oldestMessage.id

          const isOldestFromParent = threadStartMessageId && oldestMessage.id < threadStartMessageId
          const extensionChannel = (isOldestFromParent && threadParentChannel) ? threadParentChannel : channel

          logger.debug({
            currentBefore, maxExtend,
            firstMessageId: activeFirstMessageId,
            isThread: channel.isThread(),
            extensionChannelId: extensionChannel.id
          }, 'Cache anchor not in window, extending fetch backwards')

          while (extended < maxExtend) {
            const batch = await deps.fetchBatch(extensionChannel, { limit: 100, before: currentBefore })
            if (batch.length === 0) break

            const batchSorted = [...batch].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            messages = [...batchSorted, ...messages]
            extended += batchSorted.length

            firstIndex = messages.findIndex(m => m.id === activeFirstMessageId)
            if (firstIndex >= 0) {
              logger.debug({ extended, firstIndex, totalMessages: messages.length }, 'Found cache anchor after extending')
              break
            }

            const oldestBatch = batchSorted[0]
            if (!oldestBatch) break
            currentBefore = oldestBatch.id
          }

          if (firstIndex < 0) {
            logger.warn({
              firstMessageId: activeFirstMessageId, extended,
              totalMessages: messages.length, oldestId: messages[0]?.id,
            }, 'Cache anchor not found after extending — may have been deleted')
          }
        }

        const historyWasUsed = !!historyOriginChannelId
        if (firstIndex > 0 && historyWasUsed) {
          logger.debug({
            cacheAnchor: activeFirstMessageId,
            olderMessagesIncluded: firstIndex,
            historyOrigin: historyOriginChannelId,
          }, 'Expanding cache window to include .history context')
        } else if (firstIndex > 0 && !historyWasUsed) {
          logger.debug({
            cacheAnchor: activeFirstMessageId,
            trimmingCount: firstIndex,
            totalBefore: messages.length,
          }, 'Trimming fetch overshoot to maintain cache stability')
          messages = messages.slice(firstIndex)
          cacheAnchorTrimmed = true
        }
      } else if (activeFirstMessageId && historyDidClear) {
        logger.debug({
          firstMessageId: activeFirstMessageId,
          messageCount: messages.length
        }, 'Skipping cache stability — .history cleared context')
      }

      logger.debug({ finalMessageCount: messages.length }, 'Context fetch pipeline complete')

      if (params.displayNames) {
        startProfile('memberNames')
        await this.authorMembers.cacheFor(messages, params.displayNames)
        endProfile('memberNames')
      }

      startProfile('messageConvert')
      const messageMap = new Map(messages.map(m => [m.id, m]))
      const discordMessages: DiscordMessage[] = messages
        .map((msg) => this.convertMessage(msg, messageMap))
        .filter((msg) => msg.content || msg.attachments.length > 0)
      endProfile('messageConvert')

      startProfile('pinnedFetch')
      let pinnedConfigs: string[]
      if (params.pinnedConfigs) {
        pinnedConfigs = params.pinnedConfigs
        logger.debug({ pinnedCount: pinnedConfigs.length }, 'Using pre-fetched pinned configs')
      } else {
        pinnedConfigs = await this.fetchPinnedConfigs(channelId)
        logger.debug({ pinnedCount: pinnedConfigs.length }, 'Resolved pinned configs from tracked-pin cache')
      }
      endProfile('pinnedFetch')

      startProfile('attachmentProcessing')
      const images: CachedImage[] = []
      const documents: CachedDocument[] = []
      let newImagesDownloaded = 0
      logger.debug({ messageCount: messages.length, maxImages }, 'Checking messages for attachments')
      
      const imageLimitReached = () => maxImages !== undefined && images.length >= maxImages
      
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!
        const attachments = Array.from(msg.attachments.values())
        
        for (const attachment of attachments) {
          if (attachment.contentType?.startsWith('image/')) {
            if (imageLimitReached()) {
              continue
            }
            const wasInCache = this.imageCache.has(attachment.url) || this.urlToFilename.has(attachment.url)
            const cached = await this.cacheImage(attachment.url, attachment.contentType)
            if (cached) {
              images.push(cached)
              if (!wasInCache) {
                newImagesDownloaded++
              }
            }
          } else if (this.isTextAttachment(attachment)) {
            const doc = await this.fetchTextAttachment(attachment, msg.id)
            if (doc) {
              documents.push(doc)
            }
          }
        }
      }
      
      if (newImagesDownloaded > 0) {
        this.saveUrlMap()
        logger.debug({ newImagesDownloaded }, 'Saved URL map after new downloads')
      }
      endProfile('attachmentProcessing')
      
      logger.debug({ totalImages: images.length, totalDocuments: documents.length }, 'Attachment processing complete')

      const inheritanceInfo: DiscordContext['inheritanceInfo'] = {}
      if (channel.isThread()) {
        const thread = channel as any
        inheritanceInfo.parentChannelId = thread.parentId
      }
      if (historyOriginChannelId) {
        inheritanceInfo.historyOriginChannelId = historyOriginChannelId
      }
      if (historyDidClear) {
        inheritanceInfo.historyDidClear = true
      }
      if (cacheAnchorTrimmed) {
        inheritanceInfo.cacheAnchorTrimmed = true
      }

        logger.info({
        ...timings,
        messageCount: discordMessages.length,
        imageCount: images.length,
        documentCount: documents.length,
        pinnedCount: pinnedConfigs.length,
      }, '⏱️  PROFILING: fetchContext breakdown (ms)')

      return {
        messages: discordMessages,
        pinnedConfigs,
        images,
        documents,
        guildId: channel.guildId,
        inheritanceInfo: Object.keys(inheritanceInfo).length > 0 ? inheritanceInfo : undefined,
      }
    }, this.options.maxBackoffMs)
  }

  async fetchHistoryRange(
    channel: TextChannel,
    firstUrl: string | undefined,
    lastUrl: string,
    maxMessages: number = 1000
  ): Promise<Message[]> {
    const lastMessageId = this.extractMessageIdFromUrl(lastUrl)
    if (!lastMessageId) {
      logger.warn({ lastUrl }, 'Failed to parse last message URL')
      return []
    }

    const firstMessageId = firstUrl ? this.extractMessageIdFromUrl(firstUrl) : undefined

    const allMessages: Message[] = []
    
    try {
      const lastMsg = await this.cachedFetchMessages(channel, lastMessageId)
      allMessages.push(lastMsg)
    } catch (error) {
      logger.warn({ error, lastMessageId }, 'Failed to fetch last message')
      return []
    }

    let currentBefore = lastMessageId
    let foundFirst = false

    const maxBatches = Math.ceil(maxMessages / 100)

    for (let batch = 0; batch < maxBatches && !foundFirst; batch++) {
      if (allMessages.length >= maxMessages) {
        break
      }

      try {
        const batchSize = Math.min(100, maxMessages - allMessages.length)
        const fetched = await this.cachedFetchMessages(channel, {
          limit: batchSize,
          before: currentBefore
        })

        if (fetched.size === 0) break

        // Discord returns messages newest-first, so reverse for chronological order
        const batchMessages = Array.from(fetched.values()).reverse() as Message[]

        allMessages.unshift(...batchMessages)

        if (firstMessageId) {
          if (batchMessages.some((m: Message) => m.id === firstMessageId)) {
            foundFirst = true
            break
          }
        }

        currentBefore = batchMessages[0]!.id
      } catch (error) {
        logger.warn({ error, batch }, 'Failed to fetch history batch')
        break
      }
    }

    if (firstMessageId) {
      const firstIndex = allMessages.findIndex(m => m.id === firstMessageId)
      if (firstIndex >= 0) {
        return allMessages.slice(firstIndex)
      }
    }

    logger.debug({ messageCount: allMessages.length }, 'Fetched history range')
    return allMessages
  }

  async getParentChannelId(channelId: string): Promise<string | undefined> {
    try {
      const channel: any = await this.client.channels.fetch(channelId)
      if (channel?.isThread?.()) {
        return channel.parentId || undefined
      }
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to resolve parent channel')
    }
    return undefined
  }

  private extractMessageIdFromUrl(url: string): string | null {
    // Discord URL format: https://discord.com/channels/guild_id/channel_id/message_id
    const match = url.match(/\/channels\/\d+\/\d+\/(\d+)/)
    return match ? match[1]! : null
  }

  /** A mention in code is left as written, since Discord shows it raw there. */
  private async resolveMentions(content: string, channelId: string, startCarry: MarkdownCarry = []): Promise<string> {
    const mentionPattern = /<@([^>0-9<\n][^><\n]*)>/g
    const code = codeRanges(content, startCarry)
    const matches = [...content.matchAll(mentionPattern)].filter(
      (match) => !code.some(([start, end]) => match.index < end && match.index + match[0].length > start),
    )
    
    if (matches.length === 0) {
      return content
    }

    const channel = await this.client.channels.fetch(channelId) as TextChannel
    if (!channel?.guild) {
      return content
    }

    const resolved = new Map<number, string>()
    for (const match of matches) {
      const username = match[1]
      if (!username) continue

      try {
        const members = await channel.guild.members.fetch({ query: username, limit: 10 })
        
        const exactMatches = members.filter(m => 
          m.user.username.toLowerCase() === username.toLowerCase() ||
          m.displayName.toLowerCase() === username.toLowerCase()
        )
        
        if (exactMatches.size > 0) {
          const sortedMatches = [...exactMatches.values()].sort((a, b) => {
            if (a.user.bot !== b.user.bot) return a.user.bot ? 1 : -1
            const aJoined = a.joinedAt?.getTime() || 0
            const bJoined = b.joinedAt?.getTime() || 0
            return bJoined - aJoined
          })
          
          const member = sortedMatches[0]
          if (member) {
            resolved.set(match.index, `<@${member.user.id}>`)
            logger.debug({ 
              username, 
              userId: member.user.id, 
              isBot: member.user.bot,
              matchCount: exactMatches.size 
            }, 'Resolved mention to user ID')
          }
        }
      } catch (error) {
        logger.debug({ username, error }, 'Failed to resolve mention')
      }
    }

    let result = ''
    let from = 0
    for (const match of matches) {
      const to = resolved.get(match.index)
      if (to === undefined) continue
      result += content.slice(from, match.index) + to
      from = match.index + match[0].length
    }
    return result + content.slice(from)
  }

  private resolveEmojis(content: string, guild: import('discord.js').Guild): string {
    // Match :word: patterns — Discord custom emoji names are alphanumeric + underscores, 2-32 chars
    return content.replace(/:(\w{2,32}):/g, (match, name) => {
      const emoji = guild.emojis.cache.find(e => e.name === name)
      if (!emoji) return match
      return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`
    })
  }

  /** For when msg.member is null: historical message fetches don't populate member data. */
  async fetchMemberRoles(userId: string, guildId: string): Promise<string[] | null> {
    try {
      const guild = this.client.guilds.cache.get(guildId)
      if (!guild) {
        logger.debug({ userId, guildId }, 'fetchMemberRoles: guild not in cache')
        return null
      }
      const member = await guild.members.fetch(userId)
      return Array.from(member.roles.cache.values()).map(r => r.name)
    } catch (error) {
      logger.debug({ error, userId, guildId }, 'fetchMemberRoles: failed to fetch member')
      return null
    }
  }

  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      let resolvedContent = await this.resolveMentions(content, channelId)

      if (channel.guild) {
        resolvedContent = this.resolveEmojis(resolvedContent, channel.guild)
      }

      const chunks = this.splitMessage(resolvedContent, 1800)
      const messageIds: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        messageIds.push(await this.sendChunk(channel, chunks[i]!, i === 0 ? replyToMessageId : undefined))
      }

      logger.debug({ channelId, chunks: chunks.length, messageIds, replyTo: replyToMessageId }, 'Sent message')
      return messageIds
    }, this.options.maxBackoffMs)
  }

  async sendSegmentChunks(
    channelId: string,
    content: string,
    replyToMessageId: string | undefined,
    startCarry: MarkdownCarry,
  ): Promise<{ chunks: SentMessageChunk[]; endCarry: MarkdownCarry }> {
    const { channel, chunks, endCarry } = await retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      let resolvedContent = await this.resolveMentions(content, channelId, startCarry)
      if (channel.guild) {
        resolvedContent = this.resolveEmojis(resolvedContent, channel.guild)
      }

      const { chunks, endCarry } = splitPreservingMarkdown(resolvedContent, 1800, startCarry)
      return { channel, chunks, endCarry }
    }, this.options.maxBackoffMs)

    const sent: SentMessageChunk[] = []
    for (let i = 0; i < chunks.length; i++) {
      const piece = chunks[i]!
      const id = await retryDiscord(
        () => this.sendChunk(channel, piece.text, i === 0 ? replyToMessageId : undefined),
        this.options.maxBackoffMs,
      )
      sent.push({ id, bridgeOpen: piece.bridgeOpen, bridgeClose: piece.bridgeClose })
    }

    logger.debug({ channelId, chunks: sent.length, replyTo: replyToMessageId }, 'Sent markdown segment')
    return { chunks: sent, endCarry }
  }

  private async sendChunk(channel: TextChannel, content: string, replyToMessageId?: string): Promise<string> {
    if (content.length > DISCORD_MESSAGE_LIMIT) {
      logger.warn({ channelId: channel.id, length: content.length }, 'Chunk exceeds Discord message limit')
    }
    if (replyToMessageId) {
      try {
        const sent = await channel.send({
          content,
          reply: { messageReference: replyToMessageId },
          allowedMentions: replyAllowedMentions(),
        })
        return sent.id
      } catch (error: any) {
        if (error.code === 10008 || error.message?.includes('Unknown message')) {
          logger.warn({ replyToMessageId, channelId: channel.id }, 'Reply target deleted, sending without reply')
          const sent = await channel.send({ content, allowedMentions: replyAllowedMentions() })
          return sent.id
        }
        throw error
      }
    }
    const sent = await channel.send({ content })
    return sent.id
  }

  async sendMessageWithAttachment(
    channelId: string, 
    content: string, 
    attachment: { name: string; content: string },
    replyToMessageId?: string
  ): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      let resolvedContent = await this.resolveMentions(content, channelId)

      if (channel.guild) {
        resolvedContent = this.resolveEmojis(resolvedContent, channel.guild)
      }

      const options: any = {
        content: resolvedContent,
        files: [{
          name: attachment.name,
          attachment: Buffer.from(attachment.content, 'utf-8'),
        }],
      }

      if (replyToMessageId) {
        try {
          options.reply = { messageReference: replyToMessageId }
          options.allowedMentions = replyAllowedMentions()
          const sent = await channel.send(options)
          logger.debug({ channelId, attachmentName: attachment.name, replyTo: replyToMessageId }, 'Sent message with attachment')
          return [sent.id]
        } catch (error: any) {
          if (error.code === 10008 || error.message?.includes('Unknown message')) {
            logger.warn({ replyToMessageId, channelId }, 'Reply target deleted, sending without reply')
            delete options.reply
            const sent = await channel.send(options)
            return [sent.id]
          } else {
            throw error
          }
        }
      } else {
        const sent = await channel.send(options)
        logger.debug({ channelId, attachmentName: attachment.name }, 'Sent message with attachment')
        return [sent.id]
      }
    }, this.options.maxBackoffMs)
  }

  async sendImageAttachment(
    channelId: string,
    imageBase64: string,
    mediaType: string = 'image/png',
    caption?: string,
    replyToMessageId?: string
  ): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      const extMap: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
      }
      const ext = extMap[mediaType] || 'png'
      const filename = `generated_${Date.now()}.${ext}`

      const options: any = {
        content: caption || '',
        files: [{
          name: filename,
          attachment: Buffer.from(imageBase64, 'base64'),
        }],
      }

      if (replyToMessageId) {
        try {
          options.reply = { messageReference: replyToMessageId }
          options.allowedMentions = replyAllowedMentions()
          const sent = await channel.send(options)
          logger.debug({ channelId, filename, replyTo: replyToMessageId }, 'Sent image attachment')
          return [sent.id]
        } catch (error: any) {
          if (error.code === 10008 || error.message?.includes('Unknown message')) {
            logger.warn({ replyToMessageId, channelId }, 'Reply target deleted, sending without reply')
            delete options.reply
            const sent = await channel.send(options)
            return [sent.id]
          } else {
            throw error
          }
        }
      } else {
        const sent = await channel.send(options)
        logger.debug({ channelId, filename }, 'Sent image attachment')
        return [sent.id]
      }
    }, this.options.maxBackoffMs)
  }

  async sendFileAttachment(
    channelId: string,
    fileBuffer: Buffer,
    filename: string,
    _contentType: string,
    caption?: string,
    replyToMessageId?: string
  ): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        logger.warn({ channelId }, 'Cannot send file: channel not text-based')
        return []
      }

      let resolvedCaption = caption ? await this.resolveMentions(caption, channelId) : ''

      if (resolvedCaption && channel.guild) {
        resolvedCaption = this.resolveEmojis(resolvedCaption, channel.guild)
      }

      const options: any = {
        content: resolvedCaption,
        files: [{
          name: filename,
          attachment: fileBuffer,
        }],
      }

      if (replyToMessageId) {
        try {
          options.reply = { messageReference: replyToMessageId }
          options.allowedMentions = replyAllowedMentions()
          const sent = await channel.send(options)
          logger.debug({ channelId, filename, size: fileBuffer.length, replyTo: replyToMessageId }, 'Sent file attachment')
          return [sent.id]
        } catch (error: any) {
          if (error.code === 10008 || error.message?.includes('Unknown message')) {
            logger.warn({ replyToMessageId, channelId }, 'Reply target deleted, sending without reply')
            delete options.reply
            const sent = await channel.send(options)
            return [sent.id]
          } else {
            throw error
          }
        }
      } else {
        const sent = await channel.send(options)
        logger.debug({ channelId, filename, size: fileBuffer.length }, 'Sent file attachment')
        return [sent.id]
      }
    }, this.options.maxBackoffMs)
  }

  async sendWebhook(channelId: string, content: string, username: string): Promise<void> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      // Threads don't support webhooks directly - fall back to regular messages
      const isThread = 'isThread' in channel && typeof channel.isThread === 'function' ? channel.isThread() : false
      if (!channel || !channel.isTextBased() || isThread) {
        logger.debug({ channelId, isThread }, 'Channel does not support webhooks, using regular message')
        await this.sendMessage(channelId, content)
        return
      }

      try {
        const webhooks = await (channel as any).fetchWebhooks()
      let webhook = webhooks.find((wh: any) => wh.name === 'Chapter3-Tools')

      if (!webhook) {
        webhook = await channel.createWebhook({
          name: 'Chapter3-Tools',
          reason: 'Tool output display',
        })
        logger.debug({ channelId, webhookId: webhook.id }, 'Created webhook')
      }

      await webhook.send({
        content,
        username,
        avatarURL: this.client.user?.displayAvatarURL(),
      })

      logger.debug({ channelId, username }, 'Sent webhook message')
      } catch (error: any) {
        logger.warn({ channelId, error: error.message }, 'Webhook failed, falling back to regular message')
        await this.sendMessage(channelId, content)
      }
    }, this.options.maxBackoffMs)
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      const message = await channel.messages.fetch(messageId)
      await message.pin()
      logger.debug({ channelId, messageId }, 'Pinned message')
    }, this.options.maxBackoffMs)
  }

  /**
   * Discord's typing state expires after ~10s, so the indicator lasts only
   * through the refresh interval below.
   */
  async startTyping(channelId: string): Promise<void> {
    if (this.closed) {
      return
    }

    this.clearTypingInterval(channelId)

    const tick = async (): Promise<void> => {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        if (!channel || !channel.isTextBased()) {
          return
        }
        // Sending can't be un-sent and setInterval doesn't wait for a slow tick, so a
        // refresh already in flight can leave a stray indicator, which Discord expires
        // by itself in ~10s.
        if (this.typingIntervals.get(channelId) !== interval) {
          return
        }
        await channel.sendTyping()
      } catch (error) {
        logger.warn({ error, channelId }, 'Failed to refresh typing')
      }
    }

    const interval = setInterval(tick, 8000)
    this.typingIntervals.set(channelId, interval)
    void tick()
  }

  async stopTyping(channelId: string): Promise<void> {
    this.clearTypingInterval(channelId)
  }

  private clearTypingInterval(channelId: string): void {
    const interval = this.typingIntervals.get(channelId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(channelId)
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    return retryDiscord(async () => {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        const message = await channel.messages.fetch(messageId)

        const permissions = channel.permissionsFor(this.client.user!)
        if (!permissions?.has('ManageMessages')) {
          logger.error({ channelId, messageId }, 'Bot lacks MANAGE_MESSAGES permission to delete message')
          throw new Error('Missing MANAGE_MESSAGES permission')
        }

        await message.delete()
        logger.info({ channelId, messageId, author: message.author?.username }, 'Successfully deleted m command message')
      } catch (error: any) {
        logger.error({
          error: error.message,
          code: error.code,
          channelId,
          messageId
        }, 'Failed to delete message')
        throw error
      }
    }, this.options.maxBackoffMs)
  }

  async editMessage(channelId: string, messageId: string, newContent: string): Promise<void> {
    return retryDiscord(async () => {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        if (!channel || !channel.isTextBased()) {
          throw new DiscordError(`Channel ${channelId} not found`)
        }

        const message = await channel.messages.fetch(messageId)

        if (message.author.id !== this.client.user?.id) {
          throw new DiscordError(`Cannot edit message ${messageId} - not authored by bot`)
        }

        await message.edit(newContent)
        logger.debug({ channelId, messageId, newLength: newContent.length }, 'Edited message')
      } catch (error: any) {
        logger.error({
          error: error.message,
          code: error.code,
          channelId,
          messageId
        }, 'Failed to edit message')
        throw error
      }
    }, this.options.maxBackoffMs)
  }

  async findAndEditBotMessage(
    channelId: string,
    contentPrefix: string,
    newContent: string,
    maxMessages: number = 20
  ): Promise<boolean> {
    return retryDiscord(async () => {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        if (!channel || !channel.isTextBased()) {
          throw new DiscordError(`Channel ${channelId} not found`)
        }

        const botUserId = this.client.user?.id
        if (!botUserId) {
          throw new DiscordError('Bot user ID not available')
        }

        const messages = await channel.messages.fetch({ limit: maxMessages })

        const trimmedPrefix = contentPrefix.trim()
        const targetMessage = messages.find(msg => {
          if (msg.author.id !== botUserId) return false
          const content = msg.content
          if (content.startsWith(contentPrefix)) return true
          if (content.startsWith(trimmedPrefix)) return true
          if (content.trim().startsWith(trimmedPrefix)) return true
          return false
        })

        if (!targetMessage) {
          logger.warn(
            { channelId, prefixLength: contentPrefix.length, searched: messages.size },
            'Could not find bot message matching content prefix'
          )
          return false
        }

        await targetMessage.edit(newContent)
        logger.info(
          { channelId, messageId: targetMessage.id, oldLength: targetMessage.content.length, newLength: newContent.length },
          'Found and edited bot message by content prefix'
        )
        return true
      } catch (error: any) {
        logger.error({
          error: error.message,
          code: error.code,
          channelId,
          prefixLength: contentPrefix.length
        }, 'Failed to find and edit bot message')
        throw error
      }
    }, this.options.maxBackoffMs)
  }

  async getBotReplyChainDepth(channelId: string, message: any): Promise<number> {
    let depth = 0
    let currentMessage = message
    let lastBotAuthorId: string | null = null

    const channel = await this.client.channels.fetch(channelId) as TextChannel
    if (!channel || !channel.isTextBased()) {
      return 0
    }

    logger.debug({ 
      messageId: message.id, 
      authorId: message.author?.id,
      authorBot: message.author?.bot,
      hasReference: !!message.reference?.messageId
    }, 'Starting bot reply chain depth calculation')

    while (currentMessage) {
      const isBot = currentMessage.author?.bot

      if (isBot) {
        const currentBotId = currentMessage.author?.id
        if (currentBotId !== lastBotAuthorId) {
          depth++
          lastBotAuthorId = currentBotId
          logger.debug({ 
            messageId: currentMessage.id, 
            botId: currentBotId,
            depth 
          }, 'Bot message found, incremented depth')
        } else {
          logger.debug({ 
            messageId: currentMessage.id, 
            botId: currentBotId 
          }, 'Same bot consecutive message, not incrementing depth')
        }
      } else {
        logger.debug({ 
          messageId: currentMessage.id, 
          authorId: currentMessage.author?.id,
          finalDepth: depth 
        }, 'Non-bot message found, stopping chain')
        break
      }

      if (currentMessage.reference?.messageId) {
        try {
          currentMessage = await channel.messages.fetch(currentMessage.reference.messageId)
          logger.debug({ 
            nextMessageId: currentMessage.id 
          }, 'Following reply reference')
        } catch (error) {
          logger.debug({ 
            error, 
            finalDepth: depth 
          }, 'Referenced message not found, stopping chain')
          break
        }
      } else {
        logger.debug({ finalDepth: depth }, 'No more references, chain ended')
        break
      }
    }

    logger.debug({ 
      messageId: message.id, 
      finalDepth: depth 
    }, 'Bot reply chain depth calculation complete')
    return depth
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) {
        return
      }
      const message = await channel.messages.fetch(messageId)
      await message.react(emoji)
      logger.debug({ channelId, messageId, emoji }, 'Added reaction')
    } catch (error) {
      logger.warn({ error, channelId, messageId, emoji }, 'Failed to add reaction')
    }
  }

  async reactToLatestMessage(channelId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) return
      const recent = await channel.messages.fetch({ limit: 1 })
      const lastMsg = recent.first()
      if (lastMsg) {
        await lastMsg.react(emoji)
        logger.debug({ channelId, messageId: lastMsg.id, emoji }, 'Reacted to latest message')
      }
    } catch (error) {
      logger.warn({ error, channelId, emoji }, 'Failed to react to latest message')
    }
  }

  async getMessageBefore(channelId: string, beforeMessageId: string): Promise<Message | null> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) return null
      const fetched = await channel.messages.fetch({ limit: 1, before: beforeMessageId })
      return fetched.first() ?? null
    } catch (error) {
      logger.warn({ error, channelId, beforeMessageId }, 'Failed to fetch message before')
      return null
    }
  }

  async close(): Promise<void> {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval)
    }
    this.typingIntervals.clear()
    this.closed = true
    if (this.cacheStatsInterval) clearInterval(this.cacheStatsInterval)
    if (this.evictionInterval) clearInterval(this.evictionInterval)

    await this.client.destroy()
    logger.info('Discord connector closed')
  }

  private pushMessageToCache(channelId: string, message: Message): void {
    const cache = this.messageCache.get(channelId)
    if (!cache) return

    let index = this.messageCacheIndex.get(channelId)
    if (!index) {
      index = new Map()
      this.messageCacheIndex.set(channelId, index)
    }

    if (index.has(message.id)) return

    const last = cache[cache.length - 1]
    if (!last || message.id >= (last as Message).id) {
      const idx = cache.push(message) - 1
      index.set(message.id, idx)
      return
    }

    const oldestCached = cache.find((m): m is Message => m !== null)
    if (oldestCached) {
      const gapMs = oldestCached.createdTimestamp - message.createdTimestamp
      if (gapMs > 60 * 60 * 1000) {
        logger.warn({
          channelId,
          messageId: message.id,
          messageTimestamp: new Date(message.createdTimestamp).toISOString(),
          oldestCachedId: oldestCached.id,
          oldestCachedTimestamp: new Date(oldestCached.createdTimestamp).toISOString(),
          gapHours: (gapMs / 3600000).toFixed(1),
          stack: new Error().stack,
        }, 'Inserting message significantly older than cache window — potential cache poisoning')
      }
    }

    let lo = 0, hi = cache.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const midMsg = cache[mid]
      if (!midMsg || (midMsg as Message).id < message.id) lo = mid + 1
      else hi = mid
    }
    cache.splice(lo, 0, message)

    const newIndex = new Map<string, number>()
    cache.forEach((m, i) => { if (m) newIndex.set((m as Message).id, i) })
    this.messageCacheIndex.set(channelId, newIndex)

    logger.debug({
      channelId,
      messageId: message.id,
      insertedAt: lo,
      cacheSize: cache.length,
    }, 'Inserted out-of-order message into cache (maintained chronological order)')
  }

  private updateMessageInCache(channelId: string, message: Message): void {
    const index = this.messageCacheIndex.get(channelId)
    const cache = this.messageCache.get(channelId)
    if (!index || !cache) return
    const idx = index.get(message.id)
    if (idx !== undefined && cache[idx] !== null) {
      cache[idx] = message
    }
  }

  private removeMessageFromCache(channelId: string, messageId: string): void {
    const index = this.messageCacheIndex.get(channelId)
    const cache = this.messageCache.get(channelId)
    if (!index || !cache) return
    const idx = index.get(messageId)
    if (idx !== undefined) {
      cache[idx] = null
      index.delete(messageId)
    }
  }

  async cachedFetchMessages(channel: TextChannel, options: any): Promise<any> {
    const channelId = channel.id

    if (process.env.NO_MSG_CACHE) {
      if (typeof options === 'string') return channel.messages.fetch(options)
      return channel.messages.fetch(options)
    }

    if (typeof options === 'string') {
      const index = this.messageCacheIndex.get(channelId)
      const cache = this.messageCache.get(channelId)
      if (index && cache) {
        const idx = index.get(options)
        if (idx !== undefined && cache[idx] !== null) {
          this.cacheStats.hits++
          return cache[idx]
        }
      }
      this.cacheStats.misses++
      this.cacheStats.apiCalls++
      return channel.messages.fetch(options)
    }

    const limit = options.limit || 50
    const before = options.before as string | undefined
    const cache = this.messageCache.get(channelId)

    if (cache && this.messageCachePopulated.has(channelId)) {
      if (before) {
        const oldestCached = cache.find((m): m is Message => m !== null)
        if (oldestCached && before <= oldestCached.id) {
          logger.debug({ channelId, before, oldestCached: oldestCached.id }, 'Cache pagination boundary — falling through to API')
        } else {
          this.cacheStats.hits++
          let filtered: Message[]
          const index = this.messageCacheIndex.get(channelId)
          const beforeIdx = index?.get(before)
          if (beforeIdx !== undefined) {
            const msgAtIdx = cache[beforeIdx]
            if (msgAtIdx && (msgAtIdx as Message).id === before) {
              filtered = cache.slice(0, beforeIdx).filter((m): m is Message => m !== null)
            } else {
              logger.warn({ channelId, before, beforeIdx, actualId: msgAtIdx ? (msgAtIdx as Message).id : 'null' },
                'Cache index mismatch — falling back to comparison-based filter')
              filtered = cache.filter((m): m is Message => m !== null && m.id < before)
            }
          } else {
            filtered = cache.filter((m): m is Message => m !== null && m.id < before)
          }

          const slice = filtered.slice(-limit).reverse()
          const map = new Map(slice.map(m => [m.id, m]))
          ;(map as any).values = map.values.bind(map)
          ;(map as any).first = () => slice[0]
          return map
        }
      } else {
        this.cacheStats.hits++
        const filtered = cache.filter((m): m is Message => m !== null)
        const slice = filtered.slice(-limit).reverse()
        const map = new Map(slice.map(m => [m.id, m]))
        ;(map as any).values = map.values.bind(map)
        ;(map as any).first = () => slice[0]
        return map
      }
    }

    this.cacheStats.misses++
    this.cacheStats.apiCalls++
    const fetched = await channel.messages.fetch(options) as unknown as Collection<string, Message>

    if (!this.messageCachePopulated.has(channelId)) {
      const boundaryMsg = before ? channel.messages.cache.get(before) : undefined
      if (before) {
        const lastId = channel.lastMessageId
        if (!lastId || before < lastId || !boundaryMsg) {
          logger.debug({ channelId, before, lastMessageId: lastId, haveBoundary: !!boundaryMsg },
            'Skipping cache population from before-fetch (stale window or missing boundary message)')
          return fetched
        }
      }
      const msgs = Array.from(fetched.values()).reverse()
      if (boundaryMsg) {
        msgs.push(boundaryMsg)
      }
      this.messageCache.set(channelId, msgs)
      const index = new Map<string, number>()
      msgs.forEach((m, i) => index.set(m.id, i))
      this.messageCacheIndex.set(channelId, index)
      this.messageCachePopulated.add(channelId)
      logger.debug({ channelId, count: msgs.length }, 'Message cache populated from API')
    } else if (before && cache) {
      const oldestCachedMsg = cache.find((m): m is Message => m !== null)
      if (oldestCachedMsg && before === oldestCachedMsg.id) {
        const msgs = Array.from(fetched.values()).reverse()
        const existingIndex = this.messageCacheIndex.get(channelId) ?? new Map<string, number>()
        const newMsgs = msgs.filter(m => !existingIndex.has(m.id))
        if (newMsgs.length > 0) {
          cache.unshift(...newMsgs)
          const newIndex = new Map<string, number>()
          cache.forEach((m, i) => { if (m) newIndex.set(m.id, i) })
          this.messageCacheIndex.set(channelId, newIndex)
          logger.debug({ channelId, extended: newMsgs.length, total: cache.length }, 'Cache extended backwards')
        }
      } else {
        logger.debug({ channelId, before, oldestCached: oldestCachedMsg?.id },
          'Skipping backwards cache extension — query window disjoint from cache')
      }
    }

    return fetched
  }

  private evictStaleMessages(): void {
    const maxPerChannel = 2000
    let totalEvicted = 0

    for (const [channelId, cache] of this.messageCache) {
      const compacted = cache.filter((m): m is Message => m !== null)

      let evicted = 0
      if (compacted.length > maxPerChannel) {
        evicted = compacted.length - maxPerChannel
        compacted.splice(0, evicted)
      }

      this.messageCache.set(channelId, compacted)
      const newIndex = new Map<string, number>()
      compacted.forEach((m, i) => newIndex.set(m.id, i))
      this.messageCacheIndex.set(channelId, newIndex)

      totalEvicted += evicted
    }

    if (totalEvicted > 0) {
      this.cacheStats.evictions += totalEvicted
      logger.debug({ evicted: totalEvicted, channels: this.messageCache.size }, 'Cache eviction complete')
    }
  }

  private async prefetchChannels(channelIds: string[]): Promise<void> {
    const concurrency = 5
    const targetMessages = 1000
    let fetched = 0

    for (let i = 0; i < channelIds.length; i += concurrency) {
      const batch = channelIds.slice(i, i + concurrency)
      await Promise.allSettled(
        batch.map(async (channelId) => {
          try {
            const channel = await this.client.channels.fetch(channelId) as TextChannel
            if (!channel?.isTextBased()) return

            await this.cachedFetchMessages(channel, { limit: 100 })
            const cache = this.messageCache.get(channelId)
            if (!cache || cache.length === 0) return

            let totalFetched = cache.length
            while (totalFetched < targetMessages) {
              const oldest = cache.find((m): m is Message => m !== null)
              if (!oldest) break
              const older = await this.cachedFetchMessages(channel, { limit: 100, before: oldest.id })
              if (!older || older.size === 0) break
              totalFetched += older.size
            }

            fetched++
            logger.debug({ channelId, messages: cache.length }, 'Channel prefetch complete')
          } catch (error) {
            logger.warn({ channelId, error }, 'Failed to prefetch channel')
          }
        })
      )
    }

    logger.info({ requested: channelIds.length, fetched, targetMessages }, 'Channel prefetch complete')
  }

  getCachedPinnedConfigs(channelId: string): string[] | null {
    const pins = this.pinnedByChannel.get(channelId)
    if (!pins) return null
    return this.extractConfigsFromTrackedPins(pins, channelId)
  }

  getCachedPinnedSteers(channelId: string): PinnedSteer[] | null {
    const pins = this.pinnedByChannel.get(channelId)
    if (!pins) return null
    return this.extractSteersFromTrackedPins(pins)
  }

  getCachedPinnedSleeps(channelId: string): TrackedPin[] | null {
    const pins = this.pinnedByChannel.get(channelId)
    if (!pins) return null
    return this.extractSleepsFromTrackedPins(pins)
  }

  getOwnRoleIds(channelId: string): string[] | null {
    const channel: any = this.client.channels.cache.get(channelId)
    const me = channel?.guild?.members?.me
    if (!me) return null
    return Array.from(me.roles.cache.values()).map((r: any) => r.id)
  }

  getBotDiscordIdentity(): { userId?: string; username?: string; globalName?: string } {
    const u = this.client.user
    if (!u) return {}
    return {
      userId: u.id,
      username: u.username,
      globalName: u.globalName ?? undefined,
    }
  }

  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      logger.info({ user: this.client.user?.tag }, 'Discord client ready')

      const prefetchChannels = process.env.PREFETCH_CHANNELS
      if (prefetchChannels) {
        const channelIds = prefetchChannels.split(',').map(s => s.trim()).filter(Boolean)
        this.prefetchChannels(channelIds)
      }
    })

    this.client.on('messageCreate', (message) => {
      logger.debug(
        {
          messageId: message.id,
          channelId: message.channelId,
          author: message.author.username,
          content: message.content.substring(0, 50),
        },
        'Received messageCreate event'
      )

      this.pushMessageToCache(message.channelId, message)

      // Discord can deliver a message already pinned (rare: webhook-delivered or boosts).
      if (message.pinned === true && message.channelId) {
        this.trackPin(message.channelId, message)
        logger.info({ channelId: message.channelId, messageId: message.id }, 'Tracked pin from messageCreate')
      }

      this.queue.push({
        type: 'message',
        channelId: message.channelId,
        guildId: message.guildId || '',
        data: message,
        timestamp: new Date(),
        receivedAt: Date.now(),
      })
    })

    this.client.on('messageUpdate', (oldMsg, newMsg) => {
      if (newMsg.id && newMsg.channelId && !newMsg.partial) {
        this.updateMessageInCache(newMsg.channelId, newMsg as Message)
      }

      if (newMsg.id && newMsg.channelId) {
        const channelPins = this.getOrCreateChannelPinMap(newMsg.channelId)
        const wasTracked = channelPins.has(newMsg.id)
        const isPinned = newMsg.pinned === true

        if (isPinned) {
          this.trackPin(newMsg.channelId, newMsg as Message)
          if (!wasTracked) {
            logger.info({ channelId: newMsg.channelId, messageId: newMsg.id }, 'Tracked pin added via messageUpdate')
          }
        } else if (wasTracked) {
          channelPins.delete(newMsg.id)
          this.schedulePinCachePersist(newMsg.channelId)
          logger.info({ channelId: newMsg.channelId, messageId: newMsg.id }, 'Tracked pin removed via messageUpdate')
        }
      }

      this.queue.push({
        type: 'edit',
        channelId: newMsg.channelId,
        guildId: newMsg.guildId || '',
        data: { old: oldMsg, new: newMsg },
        timestamp: new Date(),
      })
    })

    this.client.on('messageDelete', (message) => {
      if (message.id && message.channelId) {
        this.removeMessageFromCache(message.channelId, message.id)
      }

      // MESSAGE_DELETE doesn't say whether the message was pinned.
      if (message.id && message.channelId) {
        const channelPins = this.pinnedByChannel.get(message.channelId)
        if (channelPins?.delete(message.id)) {
          this.schedulePinCachePersist(message.channelId)
          logger.info({ channelId: message.channelId, messageId: message.id }, 'Tracked pin dropped via messageDelete')
        }
      }

      this.queue.push({
        type: 'delete',
        channelId: message.channelId,
        guildId: message.guildId || '',
        data: message,
        timestamp: new Date(),
      })
    })

    this.client.on('messageReactionAdd', async (reaction, user) => {
      // Resolve partial messages so reaction data reaches our cache.
      // Without this, reactions on older messages (outside Discord.js's
      // internal ~200-message cache) never update our custom cache.
      let message = reaction.message
      if (message.partial) {
        try {
          message = await message.fetch()
        } catch (e) {
          logger.debug({ messageId: message.id, error: e }, 'Failed to fetch partial message for reaction')
        }
      }

      if (message.id && message.channelId && !message.partial) {
        this.updateMessageInCache(message.channelId, message as Message)
      }

      if (reaction.message.channelId && user.id) {
        this.queue.push({
          type: 'reaction',
          channelId: reaction.message.channelId,
          guildId: reaction.message.guild?.id || '',
          data: {
            messageId: reaction.message.id,
            emoji: reaction.emoji.name,
            userId: user.id,
            messageAuthorId: (message.author?.id || reaction.message.author?.id),
          },
          timestamp: new Date(),
          receivedAt: Date.now(),
        })
      }
    })

    this.client.on('messageReactionRemove', async (reaction) => {
      let message = reaction.message
      if (message.partial) {
        try {
          message = await message.fetch()
        } catch (e) {
          logger.debug({ messageId: message.id, error: e }, 'Failed to fetch partial message for reaction remove')
          return
        }
      }
      if (message.id && message.channelId && !message.partial) {
        this.updateMessageInCache(message.channelId, message as Message)
      }
    })

    this.client.on('channelPinsUpdate', (channel) => {
      logger.debug({ channelId: (channel as any)?.id }, 'channelPinsUpdate seen (no-op)')
    })

    this.client.on('shardReady', (shardId, unavailableGuilds) => {
      logger.info({ shardId, unavailableGuilds: unavailableGuilds?.size ?? 0 }, 'Shard ready')
    })
    this.client.on('shardResume', (shardId, replayedEvents) => {
      logger.info({ shardId, replayedEvents }, 'Shard resumed — events replayed')
    })
    this.client.on('shardDisconnect', (event, shardId) => {
      logger.warn({ shardId, code: event.code, reason: event.reason }, 'Shard disconnected')
    })
  }

  /** Oblique sends messages through webhooks named `displayname[oblique:various text]`. */
  private extractObliqueUsername(username: string): string | null {
    const obliquePattern = /^(.+?)\[oblique:[^\]]*\]$/
    const match = username.match(obliquePattern)
    if (match && match[1]) {
      return match[1].trim()
    }
    return null
  }

  convertMessage(msg: Message, messageMap?: Map<string, Message>): DiscordMessage {
    if (!msg.author) {
      return {
        id: msg.id,
        channelId: msg.channelId,
        guildId: msg.guildId || '',
        author: { id: SYSTEM_PLACEHOLDER_ID, username: 'system', displayName: 'system', bot: true },
        content: '',
        timestamp: msg.createdAt,
        attachments: [],
        reactions: [],
        mentions: [],
      }
    }

    // Historical messages, oblique/webhook content and cross-guild references
    // commonly miss msg.mentions.users but are present in the client-wide user cache.
    let content = (msg.content ?? '').replace(/<@!?(\d+)>/g, (_match, userId) => {
      const user = msg.mentions.users.get(userId)
        ?? msg.client.users.cache.get(userId)
        ?? msg.guild?.members.cache.get(userId)?.user
      return user?.username ? `<@${user.username}>` : '@unknown-user'
    })

    content = content.replace(/<a?:(\w+):\d+>/g, ':$1:')

    content = content.replace(/<#(\d+)>/g, (_match, channelId) => {
      const channel = msg.guild?.channels.cache.get(channelId)
      return channel && 'name' in channel ? `#${channel.name}` : `#unknown-channel`
    })

    // The portal relay prefixes its pool roles with `portal-`; stripping it reads a
    // portal persona addressed by its role as @glm52, not @portal-glm52.
    content = content.replace(/<@&(\d+)>/g, (_match, roleId) => {
      const role = msg.mentions.roles.get(roleId) ?? msg.guild?.roles.cache.get(roleId)
      if (!role?.name) return '@unknown-role'
      return `@${role.name.startsWith('portal-') ? role.name.slice('portal-'.length) : role.name}`
    })
    
    if (!msg.author) {
      logger.warn({
        messageId: msg.id,
        type: msg.type,
        partial: msg.partial,
        webhookId: msg.webhookId,
      }, 'convertMessage called with null author — this should not happen')
      throw new Error(`Message ${msg.id} has null author (partial=${msg.partial}, type=${msg.type}, webhookId=${msg.webhookId})`)
    }

    const obliqueUsername = this.extractObliqueUsername(msg.author.username)
    const effectiveUsername = obliqueUsername || msg.author.username
    // Oblique messages are from webhooks (technically bots) but should be treated as human messages
    const effectiveBot = obliqueUsername ? false : msg.author.bot

    const effectiveDisplayName = obliqueUsername
      || msg.member?.nickname
      || msg.author.globalName
      || msg.author.username
    
    if (msg.reference?.messageId && !effectiveBot) {
      const referencedMsg = messageMap?.get(msg.reference.messageId)
      if (referencedMsg) {
        const replyToObliqueUsername = this.extractObliqueUsername(referencedMsg.author.username)
        const replyToName = replyToObliqueUsername || referencedMsg.author.username
        content = `<reply:@${replyToName}> ${content}`
      } else {
        content = `<reply:@someone> ${content}`
        logger.debug({ messageId: msg.id, replyToId: msg.reference.messageId }, 'Reply target not found in message map')
      }
    }
    
    const voiceMessage = msg.flags.has(MessageFlags.IsVoiceMessage)

    return {
      id: msg.id,
      channelId: msg.channelId,
      guildId: msg.guildId || '',
      author: {
        id: msg.author.id,
        username: effectiveUsername,
        displayName: effectiveDisplayName,
        bot: effectiveBot,
      },
      content,
      timestamp: msg.createdAt,
      attachments: Array.from(msg.attachments.values()).map((att) => ({
        id: att.id,
        url: att.url,
        filename: att.name,
        contentType: att.contentType || undefined,
        size: att.size,
        width: att.width || undefined,
        height: att.height || undefined,
        ...(att.duration != null ? { duration: att.duration } : {}),
        ...(voiceMessage ? { voiceMessage: true } : {}),
      })),
      reactions: Array.from(msg.reactions.cache.values()).map((reaction) => ({
        emoji: reaction.emoji.name || reaction.emoji.toString(),
        count: reaction.count,
      })),
      authorRoles: msg.member ? Array.from(msg.member.roles.cache.values()).map(r => r.name) : undefined,
      mentions: Array.from(msg.mentions.users.keys()),
      referencedMessage: msg.reference?.messageId,
      webhookId: msg.webhookId ?? undefined,
    }
  }

  /**
   * Bypasses discord.js's REST manager, which hangs on the pins endpoints under
   * Cloudflare Error 1015 rate limiting on servers with many bots sharing one IP.
   */
  private async fetchPinnedWithTimeout(channel: TextChannel, timeoutMs: number = 10000): Promise<{ messages: Collection<string, Message>, failed: boolean }> {
    const empty = new Collection<string, Message>()

    const token = this.client.token
    if (!token) {
      logger.error({ channelId: channel.id }, 'No bot token available for direct pins fetch')
      return { messages: empty, failed: true }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(
          `https://discord.com/api/v10/channels/${channel.id}/pins`,
          {
            headers: {
              Authorization: `Bot ${token}`,
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
          }
        )
        clearTimeout(timer)

        if (!response.ok) {
          if (response.status === 429) {
            const retryAfter = parseFloat(response.headers.get('retry-after') || '0')
            // Don't wait — Cloudflare 1015 bans can be hours long.
            logger.warn({
              channelId: channel.id,
              retryAfterSec: retryAfter,
              attempt,
              server: response.headers.get('server'),
            }, 'Pins fetch rate limited (Cloudflare 1015) — falling back to disk cache')
            return { messages: empty, failed: true }
          }
          logger.warn({
            channelId: channel.id,
            status: response.status,
            statusText: response.statusText,
            attempt,
          }, 'Direct pins fetch returned error')
          continue
        }

        const data = await response.json() as any

        const rawMessages = Array.isArray(data) ? data : (data?.items?.map((item: any) => item.message) ?? data?.items ?? [])

        const messages = new Collection<string, Message>()
        for (const raw of rawMessages) {
          // Use discord.js's internal _add to construct Message objects
          const msg = (channel.messages as any)._add(raw, false)
          messages.set(msg.id, msg)
        }

        logger.debug({
          channelId: channel.id,
          count: messages.size,
          attempt,
        }, 'Fetched pinned messages via direct API')
        return { messages, failed: false }
      } catch (error: any) {
        clearTimeout(timer)
        if (error.name === 'AbortError') {
          logger.warn({
            channelId: channel.id,
            timeoutMs,
            attempt,
          }, 'Direct pins fetch timed out — retrying')
        } else {
          logger.warn({
            channelId: channel.id,
            error: error.message,
            attempt,
          }, 'Direct pins fetch failed — retrying')
        }
      }
    }

    logger.error({
      channelId: channel.id,
    }, 'Pins fetch failed after retries — will use disk cache if available')
    return { messages: empty, failed: true }
  }

  private extractConfigs(
    pins: Array<Pick<TrackedPin, 'content' | 'mentionedPersonaIds' | 'mentionedRoleIds'>>,
    channelId: string,
  ): string[] {
    const configs: string[] = []

    const ident = this.getBotDiscordIdentity()
    const identity = {
      botId: '',
      discordUsername: ident.username,
      discordGlobalName: ident.globalName,
      discordUserId: ident.userId ?? this.getBotUserId() ?? undefined,
    }
    const ownRoleIds = this.getOwnRoleIds(channelId) ?? undefined

    for (const pin of pins) {
      if (pin.content.startsWith('.config')) {
        const lines = pin.content.split('\n')
        if (lines.length > 2 && lines[1] === '---') {
          const firstLine = lines[0]!
          const target = firstLine.slice('.config'.length).trim() || undefined

          const yaml = lines.slice(2).join('\n')

          const addressesMe = pinAddressesBot(
            { targetText: target, mentionedPersonaIds: pin.mentionedPersonaIds, mentionedRoleIds: pin.mentionedRoleIds },
            identity,
            ownRoleIds,
          )

          if (target && !addressesMe) {
            configs.push(`target: ${target}\n${yaml}`)
          } else {
            configs.push(yaml)
          }
        }
      }
    }

    return configs
  }

  private detectImageType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null
    
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png'
    }
    
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg'
    }
    
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif'
    }
    
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp'
    }
    
    return null
  }

  private async cacheImage(url: string, contentType: string): Promise<CachedImage | null> {
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url)!
    }

    const cachedFilename = this.urlToFilename.get(url)
    if (cachedFilename) {
      const filepath = join(this.options.cacheDir, cachedFilename)
      if (existsSync(filepath)) {
        try {
          const buffer = readFileSync(filepath)
          const hash = cachedFilename.split('.')[0] || ''
          const ext = cachedFilename.split('.')[1] || 'jpg'
          const mediaType = `image/${ext}`
          
          let width: number | undefined
          let height: number | undefined
          try {
            const metadata = await sharp(buffer).metadata()
            width = metadata.width
            height = metadata.height
          } catch (e) {
            logger.warn({ url, filename: cachedFilename }, 'Could not read image dimensions from disk cache')
          }

          // An estimate. Anthropic downscales an image whose long edge is over 1568 px or whose cost would be over 1568 visual tokens (2576 px and 4784 tokens on Claude 4.7 and later models), and charges ceil(width / 28) * ceil(height / 28) tokens.
          const estW = Math.min(width || 1024, 1568)
          const estH = Math.min(height || 1024, 1568)
          const tokenEstimate = Math.ceil((estW * estH) / 750)

          const cached: CachedImage = {
            url,
            data: buffer,
            mediaType,
            hash,
            width,
            height,
            tokenEstimate,
          }
          
          this.imageCache.set(url, cached)
          logger.debug({ url, filename: cachedFilename, tokenEstimate }, 'Loaded image from disk cache')
          return cached
        } catch (error) {
          logger.warn({ error, url, filepath }, 'Failed to read cached image from disk')
        }
      }
    }

    try {
      const response = await fetch(url)

      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'Image download failed (non-200 status)')
        return null
      }

      const buffer = Buffer.from(await response.arrayBuffer())

      // Detect actual image format from magic bytes (don't trust Discord's contentType)
      const detectedType = this.detectImageType(buffer)

      // Reject non-image data (e.g., HTML error pages from expired CDN URLs)
      if (!detectedType) {
        logger.warn({ url, bufferSize: buffer.length }, 'Downloaded data has no valid image magic bytes, skipping')
        return null
      }

      const actualMediaType = detectedType
      
      const hash = createHash('sha256').update(buffer).digest('hex')
      const ext = actualMediaType.split('/')[1] || 'jpg'
      const filename = `${hash}.${ext}`
      const filepath = join(this.options.cacheDir, filename)

      if (!existsSync(filepath)) {
        writeFileSync(filepath, buffer)
      }
      
      this.urlToFilename.set(url, filename)

      let width: number | undefined
      let height: number | undefined
      try {
        const metadata = await sharp(buffer).metadata()
        width = metadata.width
        height = metadata.height
      } catch (e) {
        logger.warn({ url }, 'Could not get image dimensions for downloaded image')
      }

      // An estimate. Anthropic downscales an image whose long edge is over 1568 px or whose cost would be over 1568 visual tokens (2576 px and 4784 tokens on Claude 4.7 and later models), and charges ceil(width / 28) * ceil(height / 28) tokens.
      const estW = Math.min(width || 1024, 1568)
      const estH = Math.min(height || 1024, 1568)
      const tokenEstimate = Math.ceil((estW * estH) / 750)

      const cached: CachedImage = {
        url,
        data: buffer,
        mediaType: actualMediaType,
        hash,
        width,
        height,
        tokenEstimate,
      }

      this.imageCache.set(url, cached)
      
      logger.debug({ 
        url, 
        discordType: contentType, 
        detectedType: actualMediaType,
        width,
        height,
        tokenEstimate,
      }, 'Downloaded and cached new image')

      return cached
    } catch (error) {
      logger.warn({ error, url }, 'Failed to cache image')
      return null
    }
  }

  private isTextAttachment(attachment: Attachment): boolean {
    const textMimeTypes = [
      'text/',
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/yaml',
      'application/x-sh',
      'application/x-python',
    ]
    
    if (attachment.contentType) {
      for (const mime of textMimeTypes) {
        if (attachment.contentType.startsWith(mime)) {
          return true
        }
      }
    }
    
    const textExtensions = [
      '.txt', '.md', '.markdown', '.rst',
      '.py', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
      '.json', '.yaml', '.yml', '.toml', '.xml',
      '.html', '.htm', '.css', '.scss', '.sass', '.less',
      '.sh', '.bash', '.zsh', '.fish',
      '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx',
      '.java', '.rs', '.go', '.rb', '.php',
      '.sql', '.graphql', '.gql',
      '.lua', '.perl', '.pl', '.r', '.R',
      '.swift', '.kt', '.kts', '.scala',
      '.vim', '.el', '.lisp', '.clj', '.cljs',
      '.ini', '.cfg', '.conf', '.config',
      '.log', '.csv', '.tsv',
    ]
    
    const name = attachment.name?.toLowerCase() || ''
    return textExtensions.some(ext => name.endsWith(ext))
  }

  private async fetchTextAttachment(attachment: Attachment, messageId: string): Promise<CachedDocument | null> {
    if (attachment.size && attachment.size > MAX_TEXT_ATTACHMENT_BYTES * 4) {
      logger.warn({ size: attachment.size, url: attachment.url }, 'Skipping oversized text attachment')
      return null
    }

    try {
      const response = await fetch(attachment.url)
      if (!response.ok) {
        logger.warn({ status: response.status, url: attachment.url }, 'Failed to fetch text attachment')
        return null
      }

      const arrayBuffer = await response.arrayBuffer()
      let buffer = Buffer.from(arrayBuffer)
      let truncated = false

      if (buffer.length > MAX_TEXT_ATTACHMENT_BYTES) {
        buffer = buffer.slice(0, MAX_TEXT_ATTACHMENT_BYTES)
        truncated = true
      }

      const text = buffer.toString('utf-8')

      return {
        messageId,
        url: attachment.url,
        filename: attachment.name || 'attachment.txt',
        contentType: attachment.contentType || 'text/plain',
        size: attachment.size,
        text,
        truncated,
      }
    } catch (error) {
      logger.warn({ error, url: attachment.url }, 'Failed to download text attachment')
      return null
    }
  }

  private splitMessage(content: string, maxLength: number): string[] {
    return splitPreservingMarkdown(content, maxLength).chunks.map((c) => c.text)
  }
}
