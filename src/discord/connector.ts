/**
 * Discord Connector
 * Handles all Discord API interactions
 */

import { Attachment, Client, GatewayIntentBits, Message, TextChannel } from 'discord.js'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
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

export interface ConnectorOptions {
  token: string
  cacheDir: string
  maxBackoffMs: number
}

const MAX_TEXT_ATTACHMENT_BYTES = 200_000  // ~200 KB of inline text per attachment

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

  /**
   * Fetch just pinned configs from a channel (fast - single API call)
   * Used to load config BEFORE determining fetch depth
   */
  async fetchPinnedConfigs(channelId: string): Promise<string[]> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) {
        return []
      }
      const pinnedMessages = await channel.messages.fetchPinned(false)
      const sortedPinned = Array.from(pinnedMessages.values()).sort((a, b) => a.id.localeCompare(b.id))
      return this.extractConfigs(sortedPinned)
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to fetch pinned configs')
      return []
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

      // Reset history trackers for this fetch
      this.lastHistoryOriginChannelId = null
      this.lastHistoryDidClear = false

      // Use recursive fetch with automatic .history processing
      // Note: Don't pass firstMessageId to recursive call - each .history has its own boundaries
      // We'll trim to firstMessageId after all recursion completes
      logger.debug({ 
        channelId: channel.id, 
        targetMessageId, 
        depth,
        isThread: channel.isThread(),
        ignoreHistory
      }, 'ABOUT TO CALL fetchMessagesRecursive')
      
      startProfile('messagesFetch')
      let messages = await this.fetchMessagesRecursive(
        channel,
        targetMessageId,
        undefined,  // Let .history commands define their own boundaries
        depth,
        authorized_roles,
        ignoreHistory
      )
      endProfile('messagesFetch')
      
      // For threads: implicitly fetch parent channel context up to the branching point
      // This happens even without an explicit .history message
      // Skip if .history explicitly cleared context
      if (channel.isThread() && this.lastHistoryDidClear) {
        logger.debug('Skipping parent context fetch - .history cleared context')
      } else if (channel.isThread()) {
        startProfile('threadParentFetch')
        const thread = channel as any  // Discord.js ThreadChannel
        const parentChannel = thread.parent as TextChannel
        const threadStartMessageId = thread.id  // Thread ID is the same as the message ID that started it
        
        if (parentChannel && parentChannel.isTextBased()) {
          logger.debug({
            threadId: thread.id,
            parentChannelId: parentChannel.id,
            threadStartMessageId,
            currentMessageCount: messages.length,
            remainingDepth: depth - messages.length
          }, 'Thread detected, fetching parent channel context')
          
          // Fetch from parent channel up to (and including) the thread's starting message
          const parentMessages = await this.fetchMessagesRecursive(
            parentChannel,
            threadStartMessageId,  // End at the message that started the thread
            undefined,
            Math.max(0, depth - messages.length),  // Remaining message budget
            authorized_roles,
            ignoreHistory
          )
          
          logger.debug({
            parentMessageCount: parentMessages.length,
            threadMessageCount: messages.length
          }, 'Fetched parent context for thread')
          
          // Prepend parent messages (they're older than thread messages)
          messages = [...parentMessages, ...messages]
        }
        endProfile('threadParentFetch')
      }
      
      // Extend fetch to include firstMessageId (cache marker) if provided
      // This ensures cache stability - we fetch back far enough to include the cached portion
      // If firstMessageId is specified, ensure it's included by extending fetch if needed
      // NEVER trim data - cache stability should only ADD data, not remove it
      // BUT: Skip if .history cleared context - the cache marker may be intentionally excluded
      if (firstMessageId && this.lastHistoryDidClear) {
        logger.debug({
          firstMessageId,
          currentMessageCount: messages.length
        }, 'Skipping cache marker extension - .history cleared context')
      } else if (firstMessageId) {
        logger.debug({
          currentMessageCount: messages.length,
          lookingFor: firstMessageId
        }, 'Checking if cache marker is in fetch window')
        
        let firstIndex = messages.findIndex(m => m.id === firstMessageId)
        
        // If not found, extend fetch backwards until we find it (or hit limit)
        const oldestMessage = messages[0]
        if (firstIndex < 0 && oldestMessage) {
          const maxExtend = 500  // Maximum additional messages to fetch for cache stability
          let extended = 0
          let currentBefore = oldestMessage.id  // Oldest message in current window
          
          logger.debug({ 
            currentBefore, 
            maxExtend,
            firstMessageId 
          }, 'Cache marker not in window, extending fetch backwards')
          
          while (extended < maxExtend) {
            const batch = await channel.messages.fetch({ limit: 100, before: currentBefore })
            if (batch.size === 0) break
            
            const batchMessages = Array.from(batch.values()).sort((a, b) => a.id.localeCompare(b.id))
            messages = [...batchMessages, ...messages]
            extended += batchMessages.length
            
            // Check if we found the cache marker
            firstIndex = messages.findIndex(m => m.id === firstMessageId)
            if (firstIndex >= 0) {
              logger.debug({ 
                extended, 
                firstIndex,
                totalMessages: messages.length 
              }, 'Found cache marker after extending fetch')
              break
            }
            
            const oldestBatch = batchMessages[0]
            if (!oldestBatch) break
            currentBefore = oldestBatch.id
          }
          
          if (firstIndex < 0) {
            logger.warn({ 
              firstMessageId, 
              extended,
              totalMessages: messages.length,
              oldestId: messages[0]?.id
            }, 'Cache marker not found even after extending fetch - may have been deleted')
          }
        }
        
        // Note: We intentionally do NOT trim to cache marker
        // Cache stability should only add data, never remove it
        if (firstIndex >= 0) {
          logger.debug({ 
            cacheMarkerIndex: firstIndex,
            totalMessages: messages.length,
            firstMessageId
          }, 'Cache marker found in fetch window (no trimming)')
        }
      }
      
      logger.debug({ finalMessageCount: messages.length }, 'Recursive fetch complete with .history processing')

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
      // Fetch pinned messages for config (cache: false to always get fresh data)
      const pinnedMessages = await channel.messages.fetchPinned(false)
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
      if (this.lastHistoryOriginChannelId) {
        inheritanceInfo.historyOriginChannelId = this.lastHistoryOriginChannelId
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

  private parseHistoryCommand(content: string): { first?: string; last: string } | null | false {
    const lines = content.split('\n')

    // Support both ".history" alone and ".history\n---" formats
    // Just ".history" with no other content = clear history
    if (lines.length === 1 || (lines.length === 2 && lines[1]?.trim() === '')) {
      return null  // Empty clear command
    }

    // If there's more content, require --- separator
    if (lines[1] !== '---') {
      return false  // Malformed command (has content but no ---)
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

  /**
   * Track history origin during recursive fetch (reset per fetchContext call)
   */
  private lastHistoryOriginChannelId: string | null = null
  
  /**
   * Track whether .history cleared context (reset per fetchContext call)
   * When true, parent channel context should not be fetched for threads
   */
  private lastHistoryDidClear: boolean = false

  /**
   * Recursively fetch messages with .history support
   * Private helper for fetchContext
   */
  private async fetchMessagesRecursive(
    channel: TextChannel,
    startFromId: string | undefined,
    stopAtId: string | undefined,
    maxMessages: number,
    authorizedRoles?: string[],
    ignoreHistory?: boolean
  ): Promise<Message[]> {
    const results: Message[] = []
    let currentBefore = startFromId
    const batchSize = 100
    let foundHistory = false  // Track if we found .history in current recursion level
    
    // Use a unique key for this fetch call to avoid conflicts with recursive calls
    const fetchId = Math.random().toString(36).substring(7)
    const pendingKey = `_pendingNewerMessages_${fetchId}`

    logger.debug({ 
      channelId: channel.id, 
      channelName: channel.name,
      startFromId, 
      stopAtId, 
      maxMessages,
      resultsLength: results.length,
      willEnterLoop: results.length < maxMessages
    }, 'Starting recursive fetch')

    let isFirstBatch = true  // Track if this is the first batch
    
    while (results.length < maxMessages && !foundHistory) {
      // Fetch a batch
      const fetchOptions: any = { limit: Math.min(batchSize, maxMessages - results.length) }
      if (currentBefore) {
        fetchOptions.before = currentBefore
      }

      logger.debug({ 
        iteration: 'starting', 
        fetchOptions, 
        resultsLength: results.length,
        maxMessages,
        isFirstBatch
      }, 'Fetching batch in while loop')

      const fetched = await channel.messages.fetch(fetchOptions) as any
      
      logger.debug({ fetchedSize: fetched?.size || 0 }, 'Batch fetched')
      
      if (!fetched || fetched.size === 0) {
        logger.debug('No more messages to fetch')
        break
      }

      // IMPORTANT: Processing order explanation
      // - Discord.js fetch returns messages NEWEST-first (largest snowflake ID first)
      // - We reverse() to process OLDEST-first within each batch
      // - This means when we encounter a .history command:
      //   - batchResults contains messages we've ALREADY processed = OLDER than .history
      //   - Remaining messages in the loop = NEWER than .history (these we want to keep)
      // - Batches themselves are fetched newest-first (using `before:` parameter)
      const batchMessages = Array.from(fetched.values()).reverse()
      logger.debug({ batchSize: batchMessages.length }, 'Processing batch messages')

      // Collect messages from this batch (will prepend entire batch to results later)
      const batchResults: Message[] = []
      
      // For first batch, include the startFromId message at the end (it's newest)
      if (isFirstBatch && startFromId) {
        try {
          const startMsg = await channel.messages.fetch(startFromId)
          batchMessages.push(startMsg)  // Add to end of chronological batch
          logger.debug({ startFromId }, 'Added startFrom message to first batch')
        } catch (error) {
          logger.warn({ error, startFromId }, 'Failed to fetch startFrom message')
        }
        isFirstBatch = false
      }

      // Process each message in batch
      for (const msg of batchMessages) {
        const message = msg as any

        /*logger.debug({ 
          messageId: message.id, 
          contentStart: message.content?.substring(0, 30),
          isHistory: message.content?.startsWith('.history')
        }, 'Processing message in recursive fetch')*/

        // Check if we hit the stop point
        if (stopAtId && message.id === stopAtId) {
          batchResults.push(message)
          results.unshift(...batchResults)  // Prepend this batch
          logger.debug({ stopAtId, batchSize: batchResults.length }, 'Reached first message boundary, stopping')
          return results
        }

        // Check for .history command (skip if ignoreHistory is set)
        if (message.content?.startsWith('.history') && !ignoreHistory) {
          logger.debug({ messageId: message.id, content: message.content }, 'Found .history command during traversal')

          // Check authorization
          let authorized = true
          if (authorizedRoles && authorizedRoles.length > 0) {
            const member = message.member
            if (member) {
              const memberRoles = member.roles.cache.map((r: any) => r.name)
              authorized = authorizedRoles.some((role: string) => memberRoles.includes(role))
            } else {
              authorized = false
            }
          }

          if (authorized) {
            const historyRange = this.parseHistoryCommand(message.content)
            
            logger.debug({ 
              historyRange,
              messageId: message.id,
              fullContent: message.content
            }, 'Parsed .history command')

            if (historyRange === null) {
              // Empty .history - clear history BEFORE this point, keep messages AFTER
              // Processing order (see comment at line ~526):
              // - We process OLDEST-first within each batch (after reverse)
              // - batchResults contains OLDER messages (already processed) - DISCARD these
              // - Remaining messages in loop are NEWER - continue to collect them
              // - results contains messages from PREVIOUS batches (which are NEWER) - keep
              logger.debug({
                resultsCount: results.length,
                batchResultsCount: batchResults.length,
                batchResultsIds: batchResults.map((m: any) => m.id).slice(0, 5),
                resultsIds: results.map((m: any) => m.id).slice(0, 5),
                hadPendingNewerMessages: !!(this as any)[pendingKey],
              }, 'Empty .history command - keeping newer messages, discarding older (batchResults will be cleared)')
              this.lastHistoryDidClear = true  // Signal to skip parent fetch for threads
              
              // If we previously processed a .history range in this batch, the historical
              // messages it fetched are now in `results`. Since this .history clear is
              // NEWER than that range, we need to discard those historical messages too.
              if ((this as any)[pendingKey]) {
                // pendingKey has the ACTUAL newer messages we want to keep
                // results has historical messages that should be discarded
                results.length = 0
                results.push(...(this as any)[pendingKey])
                delete (this as any)[pendingKey]
                logger.debug({
                  restoredCount: results.length,
                }, 'Restored newer messages after .history clear overrode earlier .history range')
              }
              
              // Clear batchResults (contains OLDER messages - already processed before hitting .history)
              batchResults.length = 0
              foundHistory = true

              // Continue to collect remaining messages in batch (NEWER than .history)
              continue
            } else if (historyRange) {
              // Recursively fetch from history target
              const targetChannelId = this.extractChannelIdFromUrl(historyRange.last)
              const targetChannel = targetChannelId
                ? await this.client.channels.fetch(targetChannelId) as TextChannel
                : channel

              if (targetChannel && targetChannel.isTextBased()) {
                const histLastId = this.extractMessageIdFromUrl(historyRange.last) || undefined
                const histFirstId = historyRange.first ? (this.extractMessageIdFromUrl(historyRange.first) || undefined) : undefined

                // Track that we jumped from this channel via .history
                // This is used for plugin state inheritance
                this.lastHistoryOriginChannelId = channel.id

                logger.debug({ 
                  historyTarget: historyRange.last,
                  targetChannelId,
                  histLastId,
                  histFirstId,
                  remaining: maxMessages - results.length,
                  historyOriginChannelId: channel.id,
                }, 'Recursively fetching .history target')

                // RECURSIVE CALL - fetch from .history's boundaries
                const historicalMessages = await this.fetchMessagesRecursive(
                  targetChannel,
                  histLastId,      // End point (include this message and older)
                  histFirstId,     // Start point (stop when reached, or undefined)
                  maxMessages - results.length - batchResults.length,  // Account for current batch
                  authorizedRoles,
                  ignoreHistory    // Pass through (though this path only runs when ignoreHistory is false)
                )

                logger.debug({ 
                  historicalCount: historicalMessages.length,
                  currentResultsCount: results.length,
                }, 'Fetched historical messages, combining with current results')

                // Mark that we found .history (stop after this batch)
                foundHistory = true

                // Processing order (see comment at line ~526):
                // - We process OLDEST-first within each batch
                // - batchResults = messages OLDER than .history (already processed) - discard
                // - results = messages from PREVIOUS batches (NEWER than current batch) - keep
                // - Remaining messages in loop = NEWER than .history - continue to collect
                //
                // Save only results (from previous/newer batches), NOT batchResults
                const newerMessages = [...results]

                // Reset results with historical messages
                results.length = 0
                results.push(...historicalMessages)

                // Store newer messages to append after we collect remaining messages
                ;(this as any)[pendingKey] = newerMessages

                // Clear batchResults (older messages we don't want)
                batchResults.length = 0
                logger.debug({
                  historicalAdded: historicalMessages.length,
                  historicalIds: historicalMessages.map((m: any) => m.id).slice(0, 5),
                  newerMessagesSaved: newerMessages.length,
                  newerMessageIds: newerMessages.map((m: any) => m.id).slice(0, 5),
                  batchResultsDiscarded: batchResults.length,
                  batchResultsDiscardedIds: batchResults.map((m: any) => m.id).slice(0, 5),
                }, 'Reset results with historical, saved newer messages, discarded batchResults')

                // Continue to collect remaining messages in batch (NEWER than .history)
                continue
              }
            }
          }

          // This should never be reached if .history was processed above
          // Skip the .history command itself if somehow we get here
          logger.warn({ messageId: message.id }, 'Unexpected: reached .history skip without processing')
          continue
        }

        // Regular message - add to batch
        batchResults.push(message)
      }

      // After processing all messages in batch
      if (foundHistory) {
        // batchResults now contains messages AFTER .history (collected via continue)
        logger.debug({
          batchResultsToAppend: batchResults.length,
          batchResultsIds: batchResults.map((m: any) => m.id),
          currentResultsCount: results.length,
          currentResultsIds: results.map((m: any) => m.id).slice(0, 10),
        }, 'Post-batch: about to append batchResults (messages after .history)')

        results.push(...batchResults)

        // Append previously collected newer messages (from batches processed before finding .history)
        const newerMessages = (this as any)[pendingKey] || []
        delete (this as any)[pendingKey]

        if (newerMessages.length > 0) {
          logger.debug({
            newerMessagesToAppend: newerMessages.length,
            newerMessageIds: newerMessages.map((m: any) => m.id),
          }, 'Post-batch: appending newerMessages from pendingKey')
          results.push(...newerMessages)
        }

        logger.debug({
          finalResultsCount: results.length,
          finalResultsIds: results.map((m: any) => m.id),
        }, 'Post-batch: final results after .history processing')
        break  // Stop fetching older batches
      } else {
        // Regular batch - prepend (older messages go before)
        results.unshift(...batchResults)
        logger.debug({ 
          batchAdded: batchResults.length, 
          totalNow: results.length 
        }, 'Prepended batch to results')
      }

      // Check if we've collected enough
      if (results.length >= maxMessages) {
        logger.debug({ finalCount: results.length }, 'Reached max messages after batch')
        break
      }

      // Move to next batch (oldest message in current batch)
      const oldestMsg = batchMessages[0] as any
      if (!oldestMsg) break
      currentBefore = oldestMsg.id
    }

    logger.debug({ finalCount: results.length }, 'Recursive fetch complete')
    return results
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
      const lastMsg = await channel.messages.fetch(lastMessageId)
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
        const fetched = await channel.messages.fetch({ 
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

  private extractChannelIdFromUrl(url: string): string | null {
    // Discord URL format: https://discord.com/channels/guild_id/channel_id/message_id
    const match = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
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
   * Close the Discord client
   */
  async close(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval)
    }

    await this.client.destroy()
    logger.info('Discord connector closed')
  }

  private setupEventHandlers(): void {
    this.client.on('ready', () => {
      logger.info({ user: this.client.user?.tag }, 'Discord client ready')
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
      
      this.queue.push({
        type: 'message',
        channelId: message.channelId,
        guildId: message.guildId || '',
        data: message,
        timestamp: new Date(),
      })
    })

    this.client.on('messageUpdate', (oldMsg, newMsg) => {
      this.queue.push({
        type: 'edit',
        channelId: newMsg.channelId,
        guildId: newMsg.guildId || '',
        data: { old: oldMsg, new: newMsg },
        timestamp: new Date(),
      })
    })

    this.client.on('messageDelete', (message) => {
      this.queue.push({
        type: 'delete',
        channelId: message.channelId,
        guildId: message.guildId || '',
        data: message,
        timestamp: new Date(),
      })
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

