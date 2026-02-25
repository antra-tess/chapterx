/**
 * Discord Connector
 * Handles all Discord API interactions
 */

import { Attachment, Client, Collection, GatewayIntentBits, Message, PermissionFlagsBits, OAuth2Scopes, TextChannel } from 'discord.js'
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
import {
  fetchChannelMessages,
  type FetchDeps,
} from './context-fetch.js'

export interface ConnectorOptions {
  token: string
  cacheDir: string
  pinCacheDir?: string  // Directory for persisting pinned config cache to disk
  maxBackoffMs: number
}

const MAX_TEXT_ATTACHMENT_BYTES = 200_000  // ~200 KB of inline text per attachment

/** Extract a Unix timestamp (ms) from a Discord snowflake ID */
function snowflakeToTimestamp(id: string): number {
  const DISCORD_EPOCH = 1420070400000
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH
}

export interface FetchContextParams {
  channelId: string
  depth: number  // Max messages
  targetMessageId?: string  // Optional: Fetch backward from this message ID (for API range queries)
  firstMessageId?: string  // Optional: Stop when this message is encountered
  authorized_roles?: string[]
  pinnedConfigs?: string[]  // Optional: Pre-fetched pinned configs (skips fetchPinned call)
  maxImages?: number  // Optional: Cap image fetching to avoid RAM bloat (default: unlimited)
  ignoreHistory?: boolean  // Optional: Skip .history command processing (raw fetch)
}

export class DiscordConnector {
  private client: Client
  private typingIntervals = new Map<string, NodeJS.Timeout>()
  private imageCache = new Map<string, CachedImage>()
  private urlToFilename = new Map<string, string>()  // URL -> filename for disk cache lookup
  private urlMapPath: string  // Path to URL map file

  // Push-based caches (populated from gateway events, avoids API fetches)
  private messageCache = new Map<string, (Message | null)[]>()  // channelId → messages (chronological, nulls are tombstones)
  private messageCacheIndex = new Map<string, Map<string, number>>()  // channelId → (messageId → array index)
  private messageCachePopulated = new Set<string>()  // channels that had initial API fetch
  private pinnedConfigCache = new Map<string, string[]>()  // channelId → pinned config strings
  private pinnedConfigDirty = new Set<string>()  // channels whose pins changed since last fetch

  // Cache observability and maintenance
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
    })

    this.setupEventHandlers()

    // Ensure cache directory exists
    if (!existsSync(options.cacheDir)) {
      mkdirSync(options.cacheDir, { recursive: true })
    }
    
    // Load URL to filename map for persistent disk cache
    this.urlMapPath = join(options.cacheDir, 'url-map.json')
    this.loadUrlMap()

    // Initialize disk-based pin cache directory
    if (options.pinCacheDir) {
      if (!existsSync(options.pinCacheDir)) {
        mkdirSync(options.pinCacheDir, { recursive: true })
      }
      this.loadPinCacheFromDisk()
    }
  }

  /**
   * Load all persisted pin caches from disk into memory on startup.
   */
  private loadPinCacheFromDisk(): void {
    const dir = this.options.pinCacheDir
    if (!dir || !existsSync(dir)) return

    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.json'))
      let loaded = 0
      for (const file of files) {
        try {
          const channelId = file.replace('.json', '')
          const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
          if (Array.isArray(data)) {
            this.pinnedConfigCache.set(channelId, data)
            loaded++
          }
        } catch {
          // Skip corrupted files
        }
      }
      if (loaded > 0) {
        logger.info({ loaded, dir }, 'Loaded pinned config cache from disk')
      }
    } catch (error) {
      logger.warn({ error, dir }, 'Failed to read pin cache directory')
    }
  }

  /**
   * Persist pinned configs for a channel to disk.
   */
  private savePinCacheToDisk(channelId: string, configs: string[]): void {
    const dir = this.options.pinCacheDir
    if (!dir) return

    try {
      writeFileSync(join(dir, `${channelId}.json`), JSON.stringify(configs), 'utf-8')
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to write pin cache to disk')
    }
  }
  
  /**
   * Load URL to filename mapping from disk (enables persistent image cache)
   */
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
  
  /**
   * Save URL to filename mapping to disk
   */
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

  /**
   * Start the Discord client
   */
  async start(): Promise<void> {
    try {
      await this.client.login(this.options.token)
      logger.info({ userId: this.client.user?.id, tag: this.client.user?.tag }, 'Discord connector started')

      // Periodic cache stats logging
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

      // Periodic cache eviction (compact tombstones, cap per-channel size)
      this.evictionInterval = setInterval(() => this.evictStaleMessages(), 5 * 60 * 1000)
    } catch (error) {
      logger.error({ error }, 'Failed to start Discord connector')
      throw new DiscordError('Failed to connect to Discord', error)
    }
  }

  /**
   * Get bot's Discord user ID
   */
  getBotUserId(): string | undefined {
    return this.client.user?.id
  }

  /**
   * Get bot's Discord username
   */
  getBotUsername(): string | undefined {
    return this.client.user?.username
  }

  /**
   * Generate a bot invite URL with required permissions
   * 
   * Default permissions include everything needed for a typical ChapterX bot:
   * - View channels, read message history, send messages
   * - Manage messages (for editing own messages, deleting in some cases)
   * - Add reactions, use external emojis
   * - Attach files, embed links
   * - Use slash commands
   */
  generateInviteUrl(options?: {
    /** Override default permissions (bigint or array of permission flags) */
    permissions?: bigint | (keyof typeof PermissionFlagsBits)[];
    /** Pre-select a specific guild */
    guildId?: string;
    /** Disable guild selection (only works with guildId) */
    disableGuildSelect?: boolean;
  }): string | undefined {
    if (!this.client.user) {
      return undefined
    }

    // Default permissions for ChapterX bots
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

    // Calculate permissions
    let permissions: bigint
    if (options?.permissions) {
      if (typeof options.permissions === 'bigint') {
        permissions = options.permissions
      } else {
        // Array of permission names
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

  /**
   * Get channel name by ID (for display purposes)
   */
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

  /**
   * Fetch just pinned configs from a channel (fast - single API call)
   * Used to load config BEFORE determining fetch depth.
   * Falls back to disk cache if API call fails (e.g. Cloudflare 429).
   */
  async fetchPinnedConfigs(channelId: string): Promise<string[]> {
    // Check push-based memory cache first
    const cached = this.getCachedPinnedConfigs(channelId)
    if (cached !== null) {
      logger.debug({ channelId }, 'Pinned config cache hit')
      return cached
    }

    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) {
        return []
      }
      const { messages: pinnedMessages, failed } = await this.fetchPinnedWithTimeout(channel, 10000)

      // Only cache if the fetch actually succeeded (not rate limited/timed out).
      // A successful fetch with 0 pins is valid — channel genuinely has no configs.
      if (!failed) {
        const sortedPinned = Array.from(pinnedMessages.values()).sort((a, b) => a.id.localeCompare(b.id))
        const configs = this.extractConfigs(sortedPinned)

        // Store in memory + disk (also clears dirty flag)
        this.cachePinnedConfigs(channelId, configs)
        this.savePinCacheToDisk(channelId, configs)
        logger.debug({ channelId, configCount: configs.length }, 'Pinned config cache miss - fetched from API')

        return configs
      }

      // Fetch failed (timeout/429) — fall back to disk cache
      return this.loadPinCacheForChannel(channelId)
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to fetch pinned configs')
      return this.loadPinCacheForChannel(channelId)
    }
  }

  /**
   * Load pinned configs for a single channel from disk cache.
   * Returns empty array if no disk cache exists.
   */
  private loadPinCacheForChannel(channelId: string): string[] {
    // Check if memory was populated from disk on startup
    const memCached = this.pinnedConfigCache.get(channelId)
    if (memCached) {
      logger.info({ channelId, configCount: memCached.length }, 'Using disk-cached pinned configs (API unavailable)')
      return memCached
    }

    // Try reading directly from disk
    const dir = this.options.pinCacheDir
    if (!dir) return []
    const filePath = join(dir, `${channelId}.json`)
    if (!existsSync(filePath)) return []

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      if (Array.isArray(data)) {
        this.pinnedConfigCache.set(channelId, data)
        logger.info({ channelId, configCount: data.length }, 'Loaded pinned configs from disk fallback')
        return data
      }
    } catch {
      // Corrupted file
    }
    return []
  }

  /**
   * Build the FetchDeps adapter that bridges the push cache to context-fetch functions.
   */
  private buildFetchDeps(): FetchDeps {
    return {
      fetchBatch: async (ch: TextChannel, opts: { before?: string; limit: number }): Promise<Message[]> => {
        const fetched = await this.cachedFetchMessages(ch, opts) as any
        if (!fetched || fetched.size === 0) return []
        // Normalize to Message[] — fetchChannelMessages handles sorting
        return Array.from(fetched.values()) as Message[]
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

  /**
   * Fetch context from Discord (messages, configs, images)
   */
  async fetchContext(params: FetchContextParams): Promise<DiscordContext> {
    const { channelId, depth, targetMessageId, firstMessageId, authorized_roles, maxImages, ignoreHistory } = params

    // Profiling helper
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

      // ── Stage 1: Fetch channel messages with .history resolution ──
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
        undefined,  // Let .history commands define their own boundaries
        depth,
        authorized_roles ?? [],
        ignoreHistory ?? false,
        deps,
      )
      let messages = fetchResult.messages
      const historyDidClear = fetchResult.didClear
      let historyOriginChannelId = fetchResult.originChannelId
      endProfile('messagesFetch')

      // ── Stage 2: Thread parent assembly ──
      // For threads: implicitly fetch parent channel context up to the branching point
      // Skip if .history explicitly cleared context in the thread
      let threadParentChannel: TextChannel | undefined = undefined
      let threadStartMessageId: string | undefined = undefined

      if (channel.isThread() && historyDidClear) {
        logger.debug('Skipping parent context fetch — .history cleared context')
      } else if (channel.isThread()) {
        startProfile('threadParentFetch')
        const thread = channel as any  // Discord.js ThreadChannel
        threadParentChannel = thread.parent as TextChannel
        threadStartMessageId = thread.id  // Thread ID === message ID that started it

        if (threadParentChannel && threadParentChannel.isTextBased()) {
          logger.debug({
            threadId: thread.id,
            parentChannelId: threadParentChannel.id,
            threadStartMessageId,
            currentMessageCount: messages.length,
            remainingDepth: depth - messages.length
          }, 'Thread detected, fetching parent channel context')

          // Completely independent call — parent's .history only affects parent messages.
          // No shared mutable state between thread and parent fetches.
          const parentResult = await fetchChannelMessages(
            threadParentChannel,
            threadStartMessageId,  // Fetch backward from the thread's starting message
            undefined,
            Math.max(0, depth - messages.length),  // Remaining message budget
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

          // Ensure thread starter message is included.
          // fetchChannelMessages includes startFromId, but if the starter is the very first
          // message in the channel, it may not appear in the backward fetch results.
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

          // Prepend parent messages (they're older than thread messages)
          messages = [...parentMessages, ...messages]

          // Propagate parent's .history origin for plugin state inheritance
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

      // ── Stage 3: Cache stability ──
      // Extend or trim the fetch window to maintain prompt cache anchor stability.
      // Consolidated from the old split between fetchContext + handleActivation.
      let cacheAnchorTrimmed = false
      let activeFirstMessageId = firstMessageId  // Mutable — may be cleared by temporal check
      if (activeFirstMessageId && !historyDidClear) {
        logger.debug({
          currentMessageCount: messages.length,
          lookingFor: activeFirstMessageId
        }, 'Checking if cache anchor is in fetch window')

        let firstIndex = messages.findIndex(m => m.id === activeFirstMessageId)
        const oldestMessage = messages[0]

        // Temporal sanity check: if the anchor is much older than the natural
        // fetch window, don't extend — it's from a different conversation era
        // and would create a feedback loop with hard-limit truncation.
        if (firstIndex < 0 && oldestMessage) {
          const anchorTs = snowflakeToTimestamp(activeFirstMessageId)
          const oldestTs = snowflakeToTimestamp(oldestMessage.id)
          const gapMs = oldestTs - anchorTs
          const MAX_ANCHOR_GAP_MS = 24 * 60 * 60 * 1000  // 24 hours

          if (gapMs > MAX_ANCHOR_GAP_MS) {
            logger.warn({
              firstMessageId: activeFirstMessageId,
              oldestNaturalId: oldestMessage.id,
              gapHours: Math.round(gapMs / (60 * 60 * 1000)),
            }, 'Cache anchor too old — skipping extension to prevent feedback loop')
            activeFirstMessageId = undefined
          }
        }

        // Extend backward if anchor not found
        if (firstIndex < 0 && oldestMessage && activeFirstMessageId) {
          const maxExtend = 500
          let extended = 0
          let currentBefore = oldestMessage.id

          // For threads: extend from parent channel if oldest message is from parent
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

        // Trim overshoot: if anchor is found but not at index 0, trim older messages
        // for cache stability. Only when NO .history was used (overshoot from batch fetching).
        const historyWasUsed = !!historyOriginChannelId
        if (firstIndex > 0 && historyWasUsed) {
          // .history brought in older context — expand anchor (expected behavior)
          logger.debug({
            cacheAnchor: activeFirstMessageId,
            olderMessagesIncluded: firstIndex,
            historyOrigin: historyOriginChannelId,
          }, 'Expanding cache window to include .history context')
        } else if (firstIndex > 0 && !historyWasUsed) {
          // Batch fetch overshot — trim to anchor for stability
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

      startProfile('messageConvert')
      // Convert to our format (with reply username lookup)
      const messageMap = new Map(messages.map(m => [m.id, m]))
      const discordMessages: DiscordMessage[] = messages.map((msg) => this.convertMessage(msg, messageMap))
      endProfile('messageConvert')

      startProfile('pinnedFetch')
      // Use pre-fetched pinned configs if provided, otherwise fetch them
      let pinnedConfigs: string[]
      if (params.pinnedConfigs) {
        pinnedConfigs = params.pinnedConfigs
        logger.debug({ pinnedCount: pinnedConfigs.length }, 'Using pre-fetched pinned configs')
      } else {
      // Fetch pinned messages for config (fallback path — handleActivation normally pre-fetches)
      const { messages: pinnedMessages } = await this.fetchPinnedWithTimeout(channel, 10000)
      // Sort by ID (oldest first) so newer pins override older ones in merge
      const sortedPinned = Array.from(pinnedMessages.values()).sort((a, b) => a.id.localeCompare(b.id))
      logger.debug({ pinnedCount: pinnedMessages.size, pinnedIds: sortedPinned.map(m => m.id) }, 'Fetched pinned messages (sorted oldest-first)')
        pinnedConfigs = this.extractConfigs(sortedPinned)
      }
      endProfile('pinnedFetch')

      startProfile('attachmentProcessing')
      // Download/cache images and fetch text attachments
      const images: CachedImage[] = []
      const documents: CachedDocument[] = []
      let newImagesDownloaded = 0
      logger.debug({ messageCount: messages.length, maxImages }, 'Checking messages for attachments')
      
      // Track whether we've hit the image cap to avoid unnecessary processing
      const imageLimitReached = () => maxImages !== undefined && images.length >= maxImages
      
      // Iterate newest-first so image cap keeps recent images (context builder wants recent ones)
      // Messages array is chronological (oldest-first), so we reverse for image fetching
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!
        const attachments = Array.from(msg.attachments.values())
        
        for (const attachment of attachments) {
          if (attachment.contentType?.startsWith('image/')) {
            // Skip image fetching if we've already hit the cap
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

      // Build inheritance info for plugin state
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

      // Log fetch timings
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

  /**
   * Fetch a range of messages between first and last URLs
   * Public for API access
   */
  async fetchHistoryRange(
    channel: TextChannel,
    firstUrl: string | undefined,
    lastUrl: string,
    maxMessages: number = 1000
  ): Promise<Message[]> {
    // Parse message IDs from URLs
    const lastMessageId = this.extractMessageIdFromUrl(lastUrl)
    if (!lastMessageId) {
      logger.warn({ lastUrl }, 'Failed to parse last message URL')
      return []
    }

    const firstMessageId = firstUrl ? this.extractMessageIdFromUrl(firstUrl) : undefined

    // Fetch messages efficiently using bulk fetch
    // We need to fetch from first (or oldest available) to last
    const allMessages: Message[] = []
    
    // First, fetch the last message
    try {
      const lastMsg = await this.cachedFetchMessages(channel, lastMessageId)
      allMessages.push(lastMsg)
    } catch (error) {
      logger.warn({ error, lastMessageId }, 'Failed to fetch last message')
      return []
    }

    // Then fetch older messages in batches until we reach first (or limit)
    let currentBefore = lastMessageId
    let foundFirst = false

    const maxBatches = Math.ceil(maxMessages / 100)

    for (let batch = 0; batch < maxBatches && !foundFirst; batch++) {
      // Stop if we've already fetched enough
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
        const batchMessages = Array.from(fetched.values()).reverse()
        
        // Add to beginning (older messages go before newer ones)
        allMessages.unshift(...batchMessages)

        // Check if we found the first message
        if (firstMessageId) {
          if (batchMessages.some(m => m.id === firstMessageId)) {
            foundFirst = true
            break
          }
        }

        // Continue from oldest message in this batch
        currentBefore = batchMessages[0]!.id  // Oldest (already reversed)
      } catch (error) {
        logger.warn({ error, batch }, 'Failed to fetch history batch')
        break
      }
    }

    // Trim to first message if specified
    if (firstMessageId) {
      const firstIndex = allMessages.findIndex(m => m.id === firstMessageId)
      if (firstIndex >= 0) {
        return allMessages.slice(firstIndex)
      }
    }

    logger.debug({ messageCount: allMessages.length }, 'Fetched history range')
    return allMessages
  }

  /**
   * Resolve the parent channel ID for a given thread.
   * Returns undefined for regular text channels.
   */
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

  /**
   * Resolve <@username> mentions to <@USER_ID> format for Discord
   * This reverses the conversion done in convertMessage
   */
  private async resolveMentions(content: string, channelId: string): Promise<string> {
    // Find all <@username> patterns (not already numeric IDs)
    const mentionPattern = /<@([^>0-9][^>]*)>/g
    const matches = [...content.matchAll(mentionPattern)]
    
    if (matches.length === 0) {
      return content
    }

    // Get the guild for user lookups
    const channel = await this.client.channels.fetch(channelId) as TextChannel
    if (!channel?.guild) {
      return content
    }

    let result = content
    for (const match of matches) {
      const username = match[1]
      if (!username) continue

      // Try to find user by username in guild members
      try {
        // Search guild members (fetches if not cached)
        const members = await channel.guild.members.fetch({ query: username, limit: 10 })
        
        // Filter to exact matches only
        const exactMatches = members.filter(m => 
          m.user.username.toLowerCase() === username.toLowerCase() ||
          m.displayName.toLowerCase() === username.toLowerCase()
        )
        
        if (exactMatches.size > 0) {
          // Prefer non-bot users over bots (humans are more likely to be mentioned)
          // Also prefer users who have recently been active (not deleted accounts)
          const sortedMatches = [...exactMatches.values()].sort((a, b) => {
            // Non-bots first
            if (a.user.bot !== b.user.bot) return a.user.bot ? 1 : -1
            // Then by join date (more recent = likely more active)
            const aJoined = a.joinedAt?.getTime() || 0
            const bJoined = b.joinedAt?.getTime() || 0
            return bJoined - aJoined
          })
          
          const member = sortedMatches[0]
          if (member) {
            result = result.replace(match[0], `<@${member.user.id}>`)
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

    return result
  }

  /**
   * Send a message to a channel (auto-splits if > 1800 chars)
   * Returns array of message IDs
   */
  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      // Resolve <@username> mentions to <@USER_ID> format
      const resolvedContent = await this.resolveMentions(content, channelId)

      // Split message if too long
      const chunks = this.splitMessage(resolvedContent, 1800)
      const messageIds: string[] = []

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!
        const options: any = {}
        
        // First chunk replies to the triggering message
        if (i === 0 && replyToMessageId) {
          try {
            options.reply = { messageReference: replyToMessageId }
            options.allowedMentions = { repliedUser: false }
            const sent = await channel.send({ content: chunk, ...options })
            messageIds.push(sent.id)
          } catch (error: any) {
            // If reply fails (message deleted), send without reply
            if (error.code === 10008 || error.message?.includes('Unknown message')) {
              logger.warn({ replyToMessageId, channelId }, 'Reply target deleted, sending without reply')
              const sent = await channel.send({ content: chunk })
              messageIds.push(sent.id)
            } else {
              throw error
            }
          }
        } else {
          const sent = await channel.send({ content: chunk, ...options })
          messageIds.push(sent.id)
        }
      }

      logger.debug({ channelId, chunks: chunks.length, messageIds, replyTo: replyToMessageId }, 'Sent message')
      return messageIds
    }, this.options.maxBackoffMs)
  }

  /**
   * Send a message with a text file attachment
   * Used for long content that shouldn't be split
   */
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

      // Resolve <@username> mentions to <@USER_ID> format
      const resolvedContent = await this.resolveMentions(content, channelId)

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
          options.allowedMentions = { repliedUser: false }
          const sent = await channel.send(options)
          logger.debug({ channelId, attachmentName: attachment.name, replyTo: replyToMessageId }, 'Sent message with attachment')
          return [sent.id]
        } catch (error: any) {
          // If reply fails (message deleted), send without reply
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

  /**
   * Send a message with an image attachment (base64 encoded)
   * Used for image generation model outputs
   */
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

      // Determine file extension from media type
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
          options.allowedMentions = { repliedUser: false }
          const sent = await channel.send(options)
          logger.debug({ channelId, filename, replyTo: replyToMessageId }, 'Sent image attachment')
          return [sent.id]
        } catch (error: any) {
          // If reply fails (message deleted), send without reply
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

  /**
   * Send a message with an arbitrary file attachment (from Buffer)
   * Used for uploading files downloaded from URLs (videos, etc.)
   */
  async sendFileAttachment(
    channelId: string,
    fileBuffer: Buffer,
    filename: string,
    _contentType: string,  // Reserved for future use (e.g., content-type headers)
    caption?: string,
    replyToMessageId?: string
  ): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        logger.warn({ channelId }, 'Cannot send file: channel not text-based')
        return []
      }

      const resolvedCaption = caption ? await this.resolveMentions(caption, channelId) : ''

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
          options.allowedMentions = { repliedUser: false }
          const sent = await channel.send(options)
          logger.debug({ channelId, filename, size: fileBuffer.length, replyTo: replyToMessageId }, 'Sent file attachment')
          return [sent.id]
        } catch (error: any) {
          // If reply fails (message deleted), send without reply
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

  /**
   * Send a webhook message
   * For tool output, creates/reuses a webhook in the channel
   * Falls back to regular message if webhooks aren't supported (e.g., threads)
   */
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
      // Get or create webhook for this channel
        const webhooks = await (channel as any).fetchWebhooks()
      let webhook = webhooks.find((wh: any) => wh.name === 'Chapter3-Tools')

      if (!webhook) {
        webhook = await channel.createWebhook({
          name: 'Chapter3-Tools',
          reason: 'Tool output display',
        })
        logger.debug({ channelId, webhookId: webhook.id }, 'Created webhook')
      }

      // Send via webhook
      await webhook.send({
        content,
        username,
        avatarURL: this.client.user?.displayAvatarURL(),
      })

      logger.debug({ channelId, username }, 'Sent webhook message')
      } catch (error: any) {
        // Threads and some channel types don't support webhooks
        // Fall back to regular message
        logger.warn({ channelId, error: error.message }, 'Webhook failed, falling back to regular message')
        await this.sendMessage(channelId, content)
      }
    }, this.options.maxBackoffMs)
  }

  /**
   * Pin a message in a channel
   */
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
   * Start typing indicator (refreshes every 8 seconds)
   */
  async startTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId) as TextChannel

    if (!channel || !channel.isTextBased()) {
      return
    }

    // Send initial typing
    await channel.sendTyping()

    // Set up interval to refresh
    const interval = setInterval(async () => {
      try {
        await channel.sendTyping()
      } catch (error) {
        logger.warn({ error, channelId }, 'Failed to refresh typing')
      }
    }, 8000)

    this.typingIntervals.set(channelId, interval)
  }

  /**
   * Stop typing indicator
   */
  async stopTyping(channelId: string): Promise<void> {
    const interval = this.typingIntervals.get(channelId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(channelId)
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    return retryDiscord(async () => {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        const message = await channel.messages.fetch(messageId)

        // Check if bot has permission to delete messages
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

  /**
   * Edit a message by ID
   */
  async editMessage(channelId: string, messageId: string, newContent: string): Promise<void> {
    return retryDiscord(async () => {
      try {
        const channel = await this.client.channels.fetch(channelId) as TextChannel
        if (!channel || !channel.isTextBased()) {
          throw new DiscordError(`Channel ${channelId} not found`)
        }

        const message = await channel.messages.fetch(messageId)

        // Can only edit own messages
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

  /**
   * Find a recent bot message by content prefix and edit it.
   * Used for TTS interruption - finds the message that starts with the spoken text
   * and truncates it to only contain what was actually spoken.
   *
   * @param channelId - The channel to search in
   * @param contentPrefix - The content the message should start with
   * @param newContent - The new content to replace with (usually same as contentPrefix)
   * @param maxMessages - How many recent messages to search (default: 20)
   * @returns true if message was found and edited, false otherwise
   */
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

        // Fetch recent messages
        const messages = await channel.messages.fetch({ limit: maxMessages })

        // Find the bot's message that starts with contentPrefix
        // Trim whitespace and try both exact match and trimmed match
        const trimmedPrefix = contentPrefix.trim()
        const targetMessage = messages.find(msg => {
          if (msg.author.id !== botUserId) return false
          const content = msg.content
          // Try exact match first
          if (content.startsWith(contentPrefix)) return true
          // Try trimmed match
          if (content.startsWith(trimmedPrefix)) return true
          // Try if message content trimmed matches prefix trimmed
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

        // Edit the message
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

  /**
   * Get the bot reply chain depth for a message.
   * Counts consecutive bot messages in the reply chain.
   * Consecutive messages from the same bot author count as one logical message.
   * Returns the number of logical bot message groups leading up to this message.
   */
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
        // Only increment depth if this is a different bot than the previous one
        // (consecutive messages from the same bot count as one logical message)
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
        // Hit a non-bot message, stop counting
        logger.debug({ 
          messageId: currentMessage.id, 
          authorId: currentMessage.author?.id,
          finalDepth: depth 
        }, 'Non-bot message found, stopping chain')
        break
      }

      // Follow the reply chain
      if (currentMessage.reference?.messageId) {
        try {
          currentMessage = await channel.messages.fetch(currentMessage.reference.messageId)
          logger.debug({ 
            nextMessageId: currentMessage.id 
          }, 'Following reply reference')
        } catch (error) {
          // Referenced message not found, stop the chain
          logger.debug({ 
            error, 
            finalDepth: depth 
          }, 'Referenced message not found, stopping chain')
          break
        }
      } else {
        // No more references, end of chain
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

  /**
   * Add a reaction to a message
   */
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

  /**
   * Add a reaction to the most recent message in a channel.
   * Fetches directly from Discord API (no cache) to get the latest message.
   */
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

  /**
   * Close the Discord client
   */
  async close(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval)
    }
    // Clear cache maintenance intervals
    if (this.cacheStatsInterval) clearInterval(this.cacheStatsInterval)
    if (this.evictionInterval) clearInterval(this.evictionInterval)

    await this.client.destroy()
    logger.info('Discord connector closed')
  }

  // ===========================================================================
  // Push-based Message Cache
  // ===========================================================================

  private pushMessageToCache(channelId: string, message: Message): void {
    const cache = this.messageCache.get(channelId)
    if (!cache) return

    let index = this.messageCacheIndex.get(channelId)
    if (!index) {
      index = new Map()
      this.messageCacheIndex.set(channelId, index)
    }

    // Deduplicate: skip if already cached
    if (index.has(message.id)) return

    // Fast path: message is newer than or equal to newest cached (common case for messageCreate events)
    const last = cache[cache.length - 1]
    if (!last || message.id >= (last as Message).id) {
      const idx = cache.push(message) - 1
      index.set(message.id, idx)
      return
    }

    // Slow path: message is older than newest cached (e.g., single-message fetch for thread start).
    // Must insert in chronological position to maintain cache ordering.
    // Without this, the batch fetch fast path (cache.slice(0, beforeIdx)) returns wrong messages
    // because it assumes chronological ordering.
    let lo = 0, hi = cache.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const midMsg = cache[mid]
      if (!midMsg || (midMsg as Message).id < message.id) lo = mid + 1
      else hi = mid
    }
    cache.splice(lo, 0, message)

    // Rebuild index since splice shifted all positions after insertion point
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
      cache[idx] = null  // tombstone — compacted by evictStaleMessages()
      index.delete(messageId)
    }
  }

  /**
   * Cached wrapper around channel.messages.fetch().
   * After the first API fetch populates the cache, subsequent requests
   * are served from memory. Push events keep the cache current.
   *
   * Supports:
   *   { limit: N }              → last N messages
   *   { limit: N, before: id }  → N messages before given ID
   *   messageId (string)        → single message by ID
   */
  async cachedFetchMessages(channel: TextChannel, options: any): Promise<any> {
    const channelId = channel.id

    // Bypass cache for debugging
    if (process.env.NO_MSG_CACHE) {
      if (typeof options === 'string') return channel.messages.fetch(options)
      return channel.messages.fetch(options)
    }

    // Single message fetch by ID — O(1) via index
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
      // Cache miss for single message - fetch from API
      this.cacheStats.misses++
      this.cacheStats.apiCalls++
      const msg = await channel.messages.fetch(options)
      // Add to cache if we have one
      if (msg && this.messageCache.has(channelId)) {
        this.pushMessageToCache(channelId, msg)
      }
      return msg
    }

    // Batch fetch
    const limit = options.limit || 50
    const before = options.before as string | undefined
    const cache = this.messageCache.get(channelId)

    if (cache && this.messageCachePopulated.has(channelId)) {
      if (before) {
        // Check if query goes beyond the oldest cached message — if so, fall through
        // to API so pagination can extend backwards into channel history
        const oldestCached = cache.find((m): m is Message => m !== null)
        if (oldestCached && before <= oldestCached.id) {
          // Beyond cache boundary — fall through to API fetch below
          logger.debug({ channelId, before, oldestCached: oldestCached.id }, 'Cache pagination boundary — falling through to API')
        } else {
          // Within cache range — serve from cache
          this.cacheStats.hits++
          let filtered: Message[]
          const index = this.messageCacheIndex.get(channelId)
          const beforeIdx = index?.get(before)
          if (beforeIdx !== undefined) {
            // Fast path: slice up to the known position, filter only tombstones.
            // Sanity check: verify the message at beforeIdx actually matches the expected ID.
            // If the cache was corrupted (out-of-order insertion), fall back to comparison.
            const msgAtIdx = cache[beforeIdx]
            if (msgAtIdx && (msgAtIdx as Message).id === before) {
              filtered = cache.slice(0, beforeIdx).filter((m): m is Message => m !== null)
            } else {
              // Index is stale or cache is out of order — use comparison-based filter
              logger.warn({ channelId, before, beforeIdx, actualId: msgAtIdx ? (msgAtIdx as Message).id : 'null' },
                'Cache index mismatch — falling back to comparison-based filter')
              filtered = cache.filter((m): m is Message => m !== null && m.id < before)
            }
          } else {
            // Fallback: before ID not in index (deleted/external), full scan
            filtered = cache.filter((m): m is Message => m !== null && m.id < before)
          }

          const slice = filtered.slice(-limit).reverse()
          const map = new Map(slice.map(m => [m.id, m]))
          ;(map as any).values = map.values.bind(map)
          ;(map as any).first = () => slice[0]
          return map
        }
      } else {
        // No 'before' — return most recent messages from cache
        this.cacheStats.hits++
        const filtered = cache.filter((m): m is Message => m !== null)
        const slice = filtered.slice(-limit).reverse()
        const map = new Map(slice.map(m => [m.id, m]))
        ;(map as any).values = map.values.bind(map)
        ;(map as any).first = () => slice[0]
        return map
      }
    }

    // Cache miss or beyond cache boundary - fetch from API
    this.cacheStats.misses++
    this.cacheStats.apiCalls++
    const fetched = await channel.messages.fetch(options)

    if (!this.messageCachePopulated.has(channelId)) {
      // First population — store as initial cache
      const msgs = Array.from(fetched.values()).reverse() as Message[]  // chronological order
      this.messageCache.set(channelId, msgs)
      const index = new Map<string, number>()
      msgs.forEach((m, i) => index.set(m.id, i))
      this.messageCacheIndex.set(channelId, index)
      this.messageCachePopulated.add(channelId)
      logger.debug({ channelId, count: msgs.length }, 'Message cache populated from API')
    } else if (before && cache) {
      // Extend cache backwards with older messages from API
      const msgs = Array.from(fetched.values()).reverse() as Message[]
      const existingIndex = this.messageCacheIndex.get(channelId) ?? new Map<string, number>()
      const newMsgs = msgs.filter(m => !existingIndex.has(m.id))
      if (newMsgs.length > 0) {
        cache.unshift(...newMsgs)
        // Rebuild index (positions shifted by prepend)
        const newIndex = new Map<string, number>()
        cache.forEach((m, i) => { if (m) newIndex.set(m.id, i) })
        this.messageCacheIndex.set(channelId, newIndex)
        logger.debug({ channelId, extended: newMsgs.length, total: cache.length }, 'Cache extended backwards')
      }
    }

    return fetched
  }

  /**
   * Evict stale messages: compact tombstones and cap per-channel size.
   * Runs periodically via evictionInterval.
   */
  private evictStaleMessages(): void {
    const maxPerChannel = 2000
    let totalEvicted = 0

    for (const [channelId, cache] of this.messageCache) {
      // Step 1: Compact tombstones (filter out nulls)
      const compacted = cache.filter((m): m is Message => m !== null)

      // Step 2: Evict oldest if over cap
      let evicted = 0
      if (compacted.length > maxPerChannel) {
        evicted = compacted.length - maxPerChannel
        compacted.splice(0, evicted)  // remove oldest (array is chronological)
      }

      // Step 3: Rebuild array and index
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

  /**
   * Prefetch channels to warm the message cache on startup.
   * Called fire-and-forget from the ready handler.
   */
  private async prefetchChannels(channelIds: string[]): Promise<void> {
    const concurrency = 5
    const targetMessages = 1000  // Warm cache deep enough for most recency_window_messages configs
    let fetched = 0

    for (let i = 0; i < channelIds.length; i += concurrency) {
      const batch = channelIds.slice(i, i + concurrency)
      await Promise.allSettled(
        batch.map(async (channelId) => {
          try {
            const channel = await this.client.channels.fetch(channelId) as TextChannel
            if (!channel?.isTextBased()) return

            // First batch populates the cache
            await this.cachedFetchMessages(channel, { limit: 100 })
            const cache = this.messageCache.get(channelId)
            if (!cache || cache.length === 0) return

            // Paginate backwards to fill cache up to target
            let totalFetched = cache.length
            while (totalFetched < targetMessages) {
              const oldest = cache.find((m): m is Message => m !== null)
              if (!oldest) break
              const older = await this.cachedFetchMessages(channel, { limit: 100, before: oldest.id })
              if (!older || older.size === 0) break  // Reached beginning of channel
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

  /**
   * Get cached pinned configs, or null if cache is empty/dirty.
   * Does NOT clear the dirty flag — that only happens on successful API fetch
   * (via cachePinnedConfigs). This ensures failed refetches don't lose dirty state.
   */
  getCachedPinnedConfigs(channelId: string): string[] | null {
    if (this.pinnedConfigDirty.has(channelId)) {
      return null  // Force refetch, but keep dirty flag until API succeeds
    }
    return this.pinnedConfigCache.get(channelId) || null
  }

  /**
   * Store pinned configs in cache after API fetch.
   */
  cachePinnedConfigs(channelId: string, configs: string[]): void {
    this.pinnedConfigCache.set(channelId, configs)
    this.pinnedConfigDirty.delete(channelId)
  }

  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      logger.info({ user: this.client.user?.tag }, 'Discord client ready')

      // Optional: prefetch channels to warm the cache on startup
      const prefetchChannels = process.env.PREFETCH_CHANNELS
      if (prefetchChannels) {
        const channelIds = prefetchChannels.split(',').map(s => s.trim()).filter(Boolean)
        this.prefetchChannels(channelIds)  // fire-and-forget
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

      // Update message cache
      this.pushMessageToCache(message.channelId, message)

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
      // Update message cache
      if (newMsg.id && newMsg.channelId) {
        this.updateMessageInCache(newMsg.channelId, newMsg as Message)
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
      // Update message cache
      if (message.id && message.channelId) {
        this.removeMessageFromCache(message.channelId, message.id)
      }

      this.queue.push({
        type: 'delete',
        channelId: message.channelId,
        guildId: message.guildId || '',
        data: message,
        timestamp: new Date(),
      })
    })

    this.client.on('messageReactionAdd', (reaction) => {
      // Refresh cached message so reaction data is up to date
      if (reaction.message.id && reaction.message.channelId) {
        this.updateMessageInCache(reaction.message.channelId, reaction.message as Message)
      }
    })

    this.client.on('messageReactionRemove', (reaction) => {
      if (reaction.message.id && reaction.message.channelId) {
        this.updateMessageInCache(reaction.message.channelId, reaction.message as Message)
      }
    })

    this.client.on('channelPinsUpdate', (channel) => {
      // Proactively fetch new pins on gateway event (like Chapter2).
      // This is safe because pin updates are rare (someone manually pinning/unpinning),
      // unlike the old shouldActivate path which hit the API on every message batch.
      // Small random jitter (0-2s) prevents 80+ bots from fetching simultaneously.
      const channelId = (channel as any).id
      if (!channelId) return

      const jitterMs = Math.random() * 2000
      setTimeout(async () => {
        try {
          const ch = await this.client.channels.fetch(channelId) as TextChannel
          if (!ch || !ch.isTextBased()) return

          const { messages: pinnedMessages, failed } = await this.fetchPinnedWithTimeout(ch, 10000)
          if (!failed) {
            const sortedPinned = Array.from(pinnedMessages.values()).sort((a, b) => a.id.localeCompare(b.id))
            const configs = this.extractConfigs(sortedPinned)
            this.cachePinnedConfigs(channelId, configs)
            this.savePinCacheToDisk(channelId, configs)
            logger.info({ channelId, configCount: configs.length }, 'Pinned configs refreshed via gateway event')
          } else {
            // API failed (e.g., Cloudflare 429) — mark dirty so handleActivation retries
            this.pinnedConfigDirty.add(channelId)
            logger.warn({ channelId }, 'Pins gateway refresh failed — marked dirty for retry')
          }
        } catch (error) {
          this.pinnedConfigDirty.add(channelId)
          logger.warn({ error, channelId }, 'Pins gateway refresh error — marked dirty for retry')
        }
      }, jitterMs)
    })
  }

  /**
   * Extract username from oblique bridge webhook format.
   * Oblique sends messages via webhooks with nickname format: `displayname[oblique:various text]`
   * Returns the extracted displayname, or null if not an oblique message.
   */
  private extractObliqueUsername(username: string): string | null {
    // Match pattern: displayname[oblique:...]
    const obliquePattern = /^(.+?)\[oblique:[^\]]*\]$/
    const match = username.match(obliquePattern)
    if (match && match[1]) {
      return match[1].trim()
    }
    return null
  }

  /**
   * Convert Discord.js Message to DiscordMessage format
   * Public for API access
   */
  convertMessage(msg: Message, messageMap?: Map<string, Message>): DiscordMessage {
    // Replace user ID mentions with username mentions for bot consumption
    // Use actual username (not displayName/nick) to match chapter2 behavior
    let content = msg.content
    for (const [userId, user] of msg.mentions.users.entries()) {
      content = content.replace(new RegExp(`<@!?${userId}>`, 'g'), `<@${user.username}>`)
    }
    
    // Check if this is an oblique bridge message and extract the real username
    const obliqueUsername = this.extractObliqueUsername(msg.author.username)
    const effectiveUsername = obliqueUsername || msg.author.username
    // Oblique messages are from webhooks (technically bots) but should be treated as human messages
    const effectiveBot = obliqueUsername ? false : msg.author.bot
    
    // If this is a reply, prepend <reply:@username>
    // For oblique messages, treat as non-bot (they should get reply prefixes)
    if (msg.reference?.messageId && !effectiveBot) {
      // Look up the referenced message to get the author name
      const referencedMsg = messageMap?.get(msg.reference.messageId)
      if (referencedMsg) {
        // Also extract oblique username from reply target if applicable
        const replyToObliqueUsername = this.extractObliqueUsername(referencedMsg.author.username)
        const replyToName = replyToObliqueUsername || referencedMsg.author.username
        content = `<reply:@${replyToName}> ${content}`
      } else {
        content = `<reply:@someone> ${content}`
        logger.debug({ messageId: msg.id, replyToId: msg.reference.messageId }, 'Reply target not found in message map')
      }
    }
    
    return {
      id: msg.id,
      channelId: msg.channelId,
      guildId: msg.guildId || '',
      author: {
        id: msg.author.id,
        username: effectiveUsername,
        displayName: effectiveUsername,
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
      })),
      reactions: Array.from(msg.reactions.cache.values()).map((reaction) => ({
        emoji: reaction.emoji.name || reaction.emoji.toString(),
        count: reaction.count,
      })),
      mentions: Array.from(msg.mentions.users.keys()),
      referencedMessage: msg.reference?.messageId,
    }
  }

  /**
   * Fetch pinned messages with a timeout to prevent hanging the event loop.
   * Bypasses discord.js REST manager entirely (it hangs on pins endpoints due to
   * Cloudflare Error 1015 rate limiting on servers with many bots sharing one IP).
   * Uses native fetch() to the Discord API directly with AbortController timeout.
   * Returns { messages, failed } so caller can distinguish "no pins" from "fetch failed".
   * Does NOT wait on rate limits — falls through immediately to disk cache instead.
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
            // Fall through immediately so caller can use disk cache.
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

        // The /pins endpoint returns an array of message objects
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

  private extractConfigs(messages: Message[]): string[] {
    const configs: string[] = []

    for (const msg of messages) {
      // Look for .config messages
      // Format: .config [target]
      //         ---
      //         yaml content
      if (msg.content.startsWith('.config')) {
        const lines = msg.content.split('\n')
        if (lines.length > 2 && lines[1] === '---') {
          // Extract target from first line (space-separated after .config)
          const firstLine = lines[0]!
          const target = firstLine.slice('.config'.length).trim() || undefined
          
          const yaml = lines.slice(2).join('\n')
          
          // Prepend target to YAML if present
          if (target) {
            configs.push(`target: ${target}\n${yaml}`)
          } else {
          configs.push(yaml)
          }
        }
      }
    }

    return configs
  }

  /**
   * Detect image type from magic bytes
   */
  private detectImageType(buffer: Buffer): string | null {
    // Check magic bytes for common image formats
    if (buffer.length < 4) return null
    
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png'
    }
    
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg'
    }
    
    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif'
    }
    
    // WEBP: 52 49 46 46 ... 57 45 42 50
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp'
    }
    
    return null
  }

  private async cacheImage(url: string, contentType: string): Promise<CachedImage | null> {
    // 1. Check in-memory cache (fastest)
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url)!
    }

    // 2. Check disk cache using URL map (avoids download)
    const cachedFilename = this.urlToFilename.get(url)
    if (cachedFilename) {
      const filepath = join(this.options.cacheDir, cachedFilename)
      if (existsSync(filepath)) {
        try {
          const buffer = readFileSync(filepath)
          const hash = cachedFilename.split('.')[0] || ''
          const ext = cachedFilename.split('.')[1] || 'jpg'
          const mediaType = `image/${ext}`
          
          // Get image dimensions for token estimation
          let width = 1024, height = 1024
          try {
            const metadata = await sharp(buffer).metadata()
            width = metadata.width || 1024
            height = metadata.height || 1024
          } catch (e) {
            // Use defaults
          }
          
          // Anthropic resizes to max 1568x1568
          const maxDim = 1568
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height)
            width = Math.floor(width * scale)
            height = Math.floor(height * scale)
          }
          
          const tokenEstimate = Math.ceil((width * height) / 750)
          
          const cached: CachedImage = {
            url,
            data: buffer,
            mediaType,
            hash,
            width,
            height,
            tokenEstimate,
          }
          
          // Store in memory for faster subsequent access
          this.imageCache.set(url, cached)
          logger.debug({ url, filename: cachedFilename, tokenEstimate }, 'Loaded image from disk cache')
          return cached
        } catch (error) {
          logger.warn({ error, url, filepath }, 'Failed to read cached image from disk')
          // Fall through to download
        }
      }
    }

    // 3. Download image (cache miss)
    try {
      const response = await fetch(url)
      const buffer = Buffer.from(await response.arrayBuffer())

      // Detect actual image format from magic bytes (don't trust Discord's contentType)
      const actualMediaType = this.detectImageType(buffer) || contentType
      
      const hash = createHash('sha256').update(buffer).digest('hex')
      const ext = actualMediaType.split('/')[1] || 'jpg'
      const filename = `${hash}.${ext}`
      const filepath = join(this.options.cacheDir, filename)

      // Save to disk
      if (!existsSync(filepath)) {
        writeFileSync(filepath, buffer)
      }
      
      // Update URL map (will be persisted by caller after batch)
      this.urlToFilename.set(url, filename)

      // Get image dimensions for token estimation
      let width = 1024, height = 1024  // Default fallback
      try {
        const metadata = await sharp(buffer).metadata()
        width = metadata.width || 1024
        height = metadata.height || 1024
      } catch (e) {
        logger.debug({ url }, 'Could not get image dimensions, using defaults')
      }
      
      // Anthropic resizes to max 1568x1568 (maintaining aspect ratio)
      const maxDim = 1568
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.floor(width * scale)
        height = Math.floor(height * scale)
      }
      
      // Anthropic token formula: (width * height) / 750
      const tokenEstimate = Math.ceil((width * height) / 750)

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

  /**
   * Check if a file is a text file based on content type or extension
   */
  private isTextAttachment(attachment: Attachment): boolean {
    // Common text MIME types
    const textMimeTypes = [
      'text/',  // text/plain, text/html, text/css, text/javascript, etc.
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
    
    // Fall back to extension check
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

  /**
   * Fetch text attachment content with truncation support
   */
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
    if (content.length <= maxLength) {
      return [content]
    }

    const chunks: string[] = []
    let currentChunk = ''

    const lines = content.split('\n')

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk)
          currentChunk = ''
        }

        // If single line is too long, split it
        if (line.length > maxLength) {
          for (let i = 0; i < line.length; i += maxLength) {
            chunks.push(line.substring(i, i + maxLength))
          }
        } else {
          currentChunk = line
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk)
    }

    return chunks
  }
}

