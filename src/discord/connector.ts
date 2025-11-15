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
    const { channelId, depth, authorized_roles } = params

    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found or not text-based`)
      }

      // Fetch messages (in batches if depth > 100)
      let messages: Message[] = []
      let remainingToFetch = depth
      let beforeId: string | undefined
      
      while (remainingToFetch > 0 && messages.length < depth) {
        const batchSize = Math.min(remainingToFetch, 100)
        const fetchOptions: any = { limit: batchSize }
        if (beforeId) {
          fetchOptions.before = beforeId
        }
        
        const fetchedCollection = await channel.messages.fetch(fetchOptions) as any
        if (!fetchedCollection || fetchedCollection.size === 0) break
        
        // Discord returns newest-first, reverse to get chronological order
        const batchMessages = Array.from(fetchedCollection.values()).reverse()
        
        // PREPEND older messages (we're fetching backwards in time)
        messages.unshift(...(batchMessages as Message[]))
        
        beforeId = (batchMessages[0] as any)?.id  // Oldest in this batch
        if (!beforeId) break
        
        remainingToFetch -= fetchedCollection.size
      }
      
      logger.debug({ requested: depth, fetched: messages.length }, 'Fetched messages from channel')

      // Check for .history commands (only in most recent 10 messages)
      const recentMessages = messages.slice(-10)
      const historyCommands = recentMessages.filter((msg) => msg.content.startsWith('.history'))
      
      if (historyCommands.length > 0) {
        // Process history commands (most recent takes precedence)
        const historyCmd = historyCommands[historyCommands.length - 1]!
        const historyCmdIndex = messages.findIndex(m => m.id === historyCmd.id)
        
        // Messages after the .history command (current conversation)
        const messagesAfterHistory = historyCmdIndex >= 0 
          ? messages.slice(historyCmdIndex + 1)  // Everything after .history
          : []
        
        // Check authorization if roles are specified
        let authorized = true
        if (authorized_roles && authorized_roles.length > 0) {
          const member = historyCmd.member
          if (member) {
            const memberRoles = member.roles.cache.map(r => r.name)
            authorized = authorized_roles.some(role => memberRoles.includes(role))
          } else {
            authorized = false
          }
          
          if (!authorized) {
            logger.warn(
              { 
                userId: historyCmd.author.id, 
                username: historyCmd.author.username,
                requiredRoles: authorized_roles
              }, 
              'User not authorized for .history command'
            )
          }
        }
        
        if (authorized) {
          const historyRange = this.parseHistoryCommand(historyCmd.content)
          
          if (historyRange === null) {
            // Empty history command (no body) - clear history, keep messages after
            logger.debug({ messagesAfter: messagesAfterHistory.length }, 'Clearing history (empty .history command)')
            messages = messagesAfterHistory
          } else if (historyRange) {
            logger.debug({ historyRange, messagesAfter: messagesAfterHistory.length }, 'Processing .history command')
            
            // Parse channel ID from URL (history might point to different channel)
            const targetChannelId = this.extractChannelIdFromUrl(historyRange.last)
            const targetChannel = targetChannelId 
              ? await this.client.channels.fetch(targetChannelId) as TextChannel
              : channel
            
            if (!targetChannel || !targetChannel.isTextBased()) {
              logger.warn({ targetChannelId }, 'Target channel for .history not found')
              messages = messagesAfterHistory  // Keep messages after on error
            } else {
              // Fetch messages from history range
              const historyMessages = await this.fetchHistoryRange(
                targetChannel,
                historyRange.first,
                historyRange.last
              )
              
              logger.debug({ 
                historyMessages: historyMessages.length,
                messagesAfter: messagesAfterHistory.length
              }, 'Combining history with messages after')
              
              // Combine: history + messages after .history command
              messages = [...historyMessages, ...messagesAfterHistory] as Message<true>[]
              
              logger.debug({ totalMessages: messages.length }, 'Final message count after history processing')
            }
          }
        }
      }

      // Convert to our format (with reply username lookup)
      const messageMap = new Map(messages.map(m => [m.id, m]))
      const discordMessages: DiscordMessage[] = messages.map((msg) => this.convertMessage(msg, messageMap))

      // Fetch pinned messages for config
      const pinnedMessages = await channel.messages.fetchPinned()
      const pinnedConfigs = this.extractConfigs(Array.from(pinnedMessages.values()))

      // Download and cache images
      const images: CachedImage[] = []
      logger.debug({ messageCount: messages.length }, 'Checking messages for images')
      
      for (const msg of messages) {
        const attachments = Array.from(msg.attachments.values())
        logger.debug({ 
          messageId: msg.id, 
          attachmentCount: attachments.length,
          types: attachments.map(a => a.contentType)
        }, 'Message attachments')
        
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

  private async fetchHistoryRange(
    channel: TextChannel,
    firstUrl: string | undefined,
    lastUrl: string
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
    
    for (let batch = 0; batch < 10 && !foundFirst; batch++) {
      try {
        const fetched = await channel.messages.fetch({ 
          limit: 100, 
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
   * Send a message to a channel (auto-splits if > 1800 chars)
   * Returns array of message IDs
   */
  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased()) {
        throw new DiscordError(`Channel ${channelId} not found`)
      }

      // Split message if too long
      const chunks = this.splitMessage(content, 1800)
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
   * Send a webhook message
   * For tool output, creates/reuses a webhook in the channel
   */
  async sendWebhook(channelId: string, content: string, username: string): Promise<void> {
    return retryDiscord(async () => {
      const channel = await this.client.channels.fetch(channelId) as TextChannel

      if (!channel || !channel.isTextBased() || !('createWebhook' in channel)) {
        logger.warn({ channelId }, 'Channel does not support webhooks')
        // Fall back to regular message
        await this.sendMessage(channelId, content)
        return
      }

      // Get or create webhook for this channel
      const webhooks = await channel.fetchWebhooks()
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

  private convertMessage(msg: Message, messageMap?: Map<string, Message>): DiscordMessage {
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
        logger.debug({ 
          messageId: msg.id, 
          replyToId: msg.reference.messageId,
          replyToName 
        }, 'Added reply prefix to message')
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
      mentions: Array.from(msg.mentions.users.keys()),
      referencedMessage: msg.reference?.messageId,
    }
  }

  private extractConfigs(messages: Message[]): string[] {
    const configs: string[] = []

    for (const msg of messages) {
      // Look for .config messages
      if (msg.content.startsWith('.config')) {
        const lines = msg.content.split('\n')
        if (lines.length > 2 && lines[1] === '---') {
          const yaml = lines.slice(2).join('\n')
          configs.push(yaml)
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

