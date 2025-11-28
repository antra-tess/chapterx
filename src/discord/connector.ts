/**
 * Discord Connector
 * Handles all Discord API interactions
 */

import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { EventQueue } from '../agent/event-queue.js'
import {
  DiscordContext,
  DiscordMessage,
  CachedImage,
  DiscordError,
} from '../types.js'
import { logger } from '../utils/logger.js'
import { retryDiscord } from '../utils/retry.js'

export interface ConnectorOptions {
  token: string
  cacheDir: string
  maxBackoffMs: number
}

export interface FetchContextParams {
  channelId: string
  depth: number  // Max messages
  targetMessageId?: string  // Optional: Fetch backward from this message ID (for API range queries)
  firstMessageId?: string  // Optional: Stop when this message is encountered
  authorized_roles?: string[]
}

export class DiscordConnector {
  private client: Client
  private typingIntervals = new Map<string, NodeJS.Timeout>()
  private imageCache = new Map<string, CachedImage>()

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
   * Fetch context from Discord (messages, configs, images)
   */
  async fetchContext(params: FetchContextParams): Promise<DiscordContext> {
    const { channelId, depth, targetMessageId, firstMessageId, authorized_roles } = params

    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found or not text-based`)
      }

      // Use recursive fetch with automatic .history processing
      // Note: Don't pass firstMessageId to recursive call - each .history has its own boundaries
      // We'll trim to firstMessageId after all recursion completes
      logger.debug({ 
        channelId: channel.id, 
        targetMessageId, 
        depth,
        isThread: channel.isThread()
      }, 'ABOUT TO CALL fetchMessagesRecursive')
      
      let messages = await this.fetchMessagesRecursive(
        channel,
        targetMessageId,
        undefined,  // Let .history commands define their own boundaries
        depth,
        authorized_roles
      )
      
      // For threads: implicitly fetch parent channel context up to the branching point
      // This happens even without an explicit .history message
      if (channel.isThread()) {
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
            authorized_roles
          )
          
          logger.debug({
            parentMessageCount: parentMessages.length,
            threadMessageCount: messages.length
          }, 'Fetched parent context for thread')
          
          // Prepend parent messages (they're older than thread messages)
          messages = [...parentMessages, ...messages]
        }
      }
      
      // Now trim to firstMessageId if provided (works across all channels after .history)
      if (firstMessageId) {
        logger.debug({
          beforeTrim: messages.length,
          allIds: messages.map(m => m.id),
          lookingFor: firstMessageId
        }, 'About to trim to first boundary')
        
        const firstIndex = messages.findIndex(m => m.id === firstMessageId)
        if (firstIndex >= 0) {
          messages = messages.slice(firstIndex)
          logger.debug({ 
            trimmedFrom: firstIndex, 
            remaining: messages.length,
            firstMessageId,
            foundMessageId: messages[firstIndex]?.id,
            resultIds: messages.map(m => m.id)
          }, 'Trimmed to API first boundary')
        } else {
          // Debug: log first and last few message IDs to see what we got
          const messageIds = messages.map(m => m.id)
          logger.warn({ 
            firstMessageId, 
            totalMessages: messages.length,
            firstFewIds: messageIds.slice(0, 5),
            lastFewIds: messageIds.slice(-5),
            allIds: messageIds.length <= 20 ? messageIds : undefined
          }, 'API first message not found in results')
        }
      }
      
      logger.debug({ finalMessageCount: messages.length }, 'Recursive fetch complete with .history processing')

      // Convert to our format (with reply username lookup)
      const messageMap = new Map(messages.map(m => [m.id, m]))
      const discordMessages: DiscordMessage[] = messages.map((msg) => this.convertMessage(msg, messageMap))

      // Fetch pinned messages for config (cache: false to always get fresh data)
      const pinnedMessages = await channel.messages.fetchPinned(false)
      // Sort by ID (oldest first) so newer pins override older ones in merge
      const sortedPinned = Array.from(pinnedMessages.values()).sort((a, b) => a.id.localeCompare(b.id))
      logger.debug({ pinnedCount: pinnedMessages.size, pinnedIds: sortedPinned.map(m => m.id) }, 'Fetched pinned messages (sorted oldest-first)')
      const pinnedConfigs = this.extractConfigs(sortedPinned)

      // Download and cache images
      const images: CachedImage[] = []
      logger.debug({ messageCount: messages.length }, 'Checking messages for images')
      
      for (const msg of messages) {
        const attachments = Array.from(msg.attachments.values())
        /*logger.debug({ 
          messageId: msg.id, 
          attachmentCount: attachments.length,
          types: attachments.map(a => a.contentType)
        }, 'Message attachments')*/
        
        for (const attachment of attachments) {
          if (attachment.contentType?.startsWith('image/')) {
            logger.debug({ url: attachment.url, type: attachment.contentType }, 'Caching image')
            const cached = await this.cacheImage(attachment.url, attachment.contentType)
            if (cached) {
              images.push(cached)
              logger.debug({ hash: cached.hash, size: cached.data.length }, 'Image cached successfully')
            }
          }
        }
      }
      
      logger.debug({ totalImages: images.length }, 'Image caching complete')

      return {
        messages: discordMessages,
        pinnedConfigs,
        images,
        guildId: channel.guildId,
      }
    }, this.options.maxBackoffMs)
  }

  private parseHistoryCommand(content: string): { first?: string; last: string } | null | false {
    const lines = content.split('\n')
    if (lines.length < 2 || lines[1] !== '---') {
      return false  // Malformed command
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
   * Recursively fetch messages with .history support
   * Private helper for fetchContext
   */
  private async fetchMessagesRecursive(
    channel: TextChannel,
    startFromId: string | undefined,
    stopAtId: string | undefined,
    maxMessages: number,
    authorizedRoles?: string[]
  ): Promise<Message[]> {
    const results: Message[] = []
    let currentBefore = startFromId
    const batchSize = 100
    let foundHistory = false  // Track if we found .history in current recursion level

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

        // Check for .history command
        if (message.content?.startsWith('.history')) {
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
              // Empty .history - clear history, continue with messages after
              logger.debug('Empty .history command - clearing prior history')
              return results
            } else if (historyRange) {
              // Recursively fetch from history target
              const targetChannelId = this.extractChannelIdFromUrl(historyRange.last)
              const targetChannel = targetChannelId
                ? await this.client.channels.fetch(targetChannelId) as TextChannel
                : channel

              if (targetChannel && targetChannel.isTextBased()) {
                const histLastId = this.extractMessageIdFromUrl(historyRange.last) || undefined
                const histFirstId = historyRange.first ? (this.extractMessageIdFromUrl(historyRange.first) || undefined) : undefined

                logger.debug({ 
                  historyTarget: historyRange.last,
                  targetChannelId,
                  histLastId,
                  histFirstId,
                  remaining: maxMessages - results.length
                }, 'Recursively fetching .history target')

                // RECURSIVE CALL - fetch from .history's boundaries
                const historicalMessages = await this.fetchMessagesRecursive(
                  targetChannel,
                  histLastId,      // End point (include this message and older)
                  histFirstId,     // Start point (stop when reached, or undefined)
                  maxMessages - results.length - batchResults.length,  // Account for current batch
                  authorizedRoles
                )

                logger.debug({ 
                  historicalCount: historicalMessages.length,
                  batchSoFar: batchResults.length,
                  remainingInBatch: batchMessages.length - batchMessages.indexOf(msg) - 1,
                  currentResultsCount: results.length
                }, 'Fetched historical messages, will collect rest of batch then combine')

                // Mark that we found .history (stop after this batch)
                foundHistory = true
                
                // Prepend historical messages to results (they're older)
                results.unshift(...historicalMessages)
                
                // IMPORTANT: Clear batchResults - we don't want messages BEFORE .history
                // Only keep messages AFTER .history in the current channel
                batchResults.length = 0
                logger.debug({ clearedBatch: true }, 'Cleared batch before .history, will only keep messages after it')
                
                // Don't add the .history message itself
                // Continue collecting remaining messages in batch (after .history)
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
        // This batch has messages AFTER .history - append them (they're newer than historical)
        results.push(...batchResults)
        logger.debug({ 
          batchAdded: batchResults.length, 
          totalNow: results.length 
        }, 'Appended batch after .history to results')
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
        const members = await channel.guild.members.fetch({ query: username, limit: 5 })
        const member = members.find(m => 
          m.user.username.toLowerCase() === username.toLowerCase() ||
          m.displayName.toLowerCase() === username.toLowerCase()
        )
        
        if (member) {
          result = result.replace(match[0], `<@${member.user.id}>`)
          logger.debug({ username, userId: member.user.id }, 'Resolved mention to user ID')
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
   * Send a webhook message
   * For tool output, creates/reuses a webhook in the channel
   * Falls back to regular message if webhooks aren't supported (e.g., threads)
   */
  async sendWebhook(channelId: string, content: string, username: string): Promise<void> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      // Threads don't support webhooks directly - fall back to regular messages
      if (!channel || !channel.isTextBased() || channel.isThread()) {
        logger.debug({ channelId, isThread: channel?.isThread?.() }, 'Channel does not support webhooks, using regular message')
        await this.sendMessage(channelId, content)
        return
      }

      try {
        // Get or create webhook for this channel
        const webhooks = await (channel as any).fetchWebhooks()
        let webhook = webhooks.find((wh) => wh.name === 'Chapter3-Tools')

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
    
    // If this is a reply (and not from a bot), prepend <reply:@username>
    if (msg.reference?.messageId && !msg.author.bot) {
      // Look up the referenced message to get the author name
      const referencedMsg = messageMap?.get(msg.reference.messageId)
      if (referencedMsg) {
        const replyToName = referencedMsg.author.username
        content = `<reply:@${replyToName}> ${content}`
        /*logger.debug({ 
          messageId: msg.id, 
          replyToId: msg.reference.messageId,
          replyToName 
        }, 'Added reply prefix to message')*/
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
        username: msg.author.username,
        displayName: msg.author.username,  // Use username consistently (chapter2 compatibility)
        bot: msg.author.bot,
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
    // Check cache
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url)!
    }

    try {
      // Download image
      const response = await fetch(url)
      const buffer = Buffer.from(await response.arrayBuffer())

      // Detect actual image format from magic bytes (don't trust Discord's contentType)
      const actualMediaType = this.detectImageType(buffer) || contentType
      
      const hash = createHash('sha256').update(buffer).digest('hex')
      const ext = actualMediaType.split('/')[1] || 'jpg'
      const filename = `${hash}.${ext}`
      const filepath = join(this.options.cacheDir, filename)

      // Save to disk if not exists
      if (!existsSync(filepath)) {
        writeFileSync(filepath, buffer)
      }

      const cached: CachedImage = {
        url,
        data: buffer,
        mediaType: actualMediaType,
        hash,
      }

      this.imageCache.set(url, cached)
      
      logger.debug({ 
        url, 
        discordType: contentType, 
        detectedType: actualMediaType 
      }, 'Cached image with type detection')

      return cached
    } catch (error) {
      logger.warn({ error, url }, 'Failed to cache image')
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

