import express, { Request, Response, NextFunction } from 'express'
import { DiscordConnector, HISTORY_AND_FILTER_BUFFER } from '../discord/connector.js'
import { displayNameClasses } from '../discord/member-names.js'
import { ConfigSystem } from '../config/system.js'
import { ContextBuilder } from '../context/builder.js'
import { logger } from '../utils/logger.js'

export interface ApiConfig {
  port: number
  bearerToken: string
}

export interface MessageExportRequest {
  last: string
  first?: string
  recencyWindow?: {
    messages?: number
    characters?: number
  }
  maxImages?: number
  ignoreHistory?: boolean
}

export interface MessageExportResponse {
  messages: Array<{
    id: string
    author: {
      id: string
      username: string
      displayName: string
      bot: boolean
    }
    content: string
    timestamp: string
    reactions: Array<{
      emoji: string
      count: number
    }>
    attachments: Array<{
      id: string
      url: string
      filename: string
      contentType?: string
      size: number
      base64Data?: string
      mediaType?: string
    }>
    referencedMessageId?: string
  }>
  metadata: {
    channelId: string
    guildId: string
    firstMessageId: string
    lastMessageId: string
    totalCount: number
    truncated: boolean
  }
}

export class ApiServer {
  private app = express()
  private server: any = null

  constructor(
    private config: ApiConfig,
    private connector: DiscordConnector,
    private configSystem?: ConfigSystem,
    private contextBuilder?: ContextBuilder,
    private botName?: string
  ) {
    this.setupMiddleware()
    this.setupRoutes()
  }

  private setupMiddleware(): void {
    this.app.use(express.json())
    
    this.app.use((req: Request, res: Response, next: NextFunction): void => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      
      if (req.method === 'OPTIONS') {
        res.sendStatus(200)
        return
      }
      next()
    })
    
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/health' || req.method === 'OPTIONS') {
        return next()
      }

      const authHeader = req.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' })
      }

      const token = authHeader.substring(7)
      if (token !== this.config.bearerToken) {
        return res.status(403).json({ error: 'Invalid bearer token' })
      }

      next()
    })
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() })
    })

    this.app.post('/api/messages/export', async (req: Request, res: Response) => {
      try {
        const body = req.body as MessageExportRequest

        if (!body.last) {
          res.status(400).json({ 
            error: 'Bad Request',
            message: 'Missing required parameter: last',
            details: 'The "last" field must contain a Discord message URL'
          })
          return
        }

        const result = await this.exportMessages(body)
        res.json(result)
      } catch (error: any) {
        logger.error({ error, body: req.body }, 'API error in /api/messages/export')
        
        if (error.message?.includes('Invalid Discord message URL')) {
          res.status(400).json({ 
            error: 'Bad Request',
            message: error.message,
            details: 'Expected format: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID'
          })
        } else if (error.message?.includes('not found') || error.message?.includes('Unknown Message')) {
          res.status(404).json({ 
            error: 'Not Found',
            message: error.message,
            details: 'The bot cannot access this channel/message. Check bot permissions.'
          })
        } else if (error.message?.includes('not accessible') || error.message?.includes('Missing Access')) {
          res.status(403).json({ 
            error: 'Forbidden',
            message: error.message,
            details: 'The bot does not have permission to access this channel.'
          })
        } else {
          res.status(500).json({ 
            error: 'Internal Server Error',
            message: error.message || 'An unexpected error occurred'
          })
        }
      }
    })

    this.app.get('/api/users/:userId', async (req: Request, res: Response) => {
      try {
        const userId = req.params.userId
        if (!userId) {
          res.status(400).json({ 
            error: 'Bad Request',
            message: 'Missing userId parameter' 
          })
          return
        }

        const guildId = req.query.guildId as string | undefined
        const userInfo = await this.getUserInfo(userId, guildId)
        res.json(userInfo)
      } catch (error: any) {
        logger.error({ error, userId: req.params.userId }, 'API error in /api/users/:userId')
        
        if (error.message?.includes('not found') || error.message?.includes('Unknown User')) {
          res.status(404).json({ 
            error: 'Not Found',
            message: `User ${req.params.userId} not found`,
            details: 'The user may not exist or the bot cannot see them.'
          })
        } else {
          res.status(500).json({ 
            error: 'Internal Server Error',
            message: error.message || 'Failed to fetch user info'
          })
        }
      }
    })

    this.app.get('/api/users/:userId/avatar', async (req: Request, res: Response) => {
      try {
        const userId = req.params.userId
        if (!userId) {
          res.status(400).json({ 
            error: 'Bad Request',
            message: 'Missing userId parameter' 
          })
          return
        }

        const size = req.query.size ? parseInt(req.query.size as string) : 128
        const avatarUrl = await this.getUserAvatar(userId, size)
        
        if (!avatarUrl) {
          res.status(404).json({ 
            error: 'Not Found',
            message: `User ${userId} not found or has no avatar`
          })
          return
        }

        res.json({ avatarUrl })
      } catch (error: any) {
        logger.error({ error, userId: req.params.userId }, 'API error in /api/users/:userId/avatar')
        
        if (error.message?.includes('Unknown User')) {
          res.status(404).json({ 
            error: 'Not Found',
            message: error.message
          })
        } else {
          res.status(500).json({ 
            error: 'Internal Server Error',
            message: error.message || 'Failed to fetch user avatar'
          })
        }
      }
    })

    this.app.get('/api/channels', async (req: Request, res: Response) => {
      try {
        const guildIdFilter = req.query.guildId as string | undefined
        const sinceParam = req.query.since as string | undefined
        const sinceMs = sinceParam ? new Date(sinceParam).getTime() : 0
        if (sinceParam && Number.isNaN(sinceMs)) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid since parameter — must be ISO 8601 timestamp',
          })
          return
        }

        const client = (this.connector as any).client
        const guilds = guildIdFilter
          ? [client.guilds.cache.get(guildIdFilter)].filter(Boolean)
          : Array.from(client.guilds.cache.values())

        // Discord snowflake → epoch ms: (id >> 22) + Discord epoch
        const DISCORD_EPOCH = 1420070400000n
        const snowflakeToTimestamp = (snowflake: string): number =>
          Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH)

        const channels: any[] = []
        for (const guild of guilds as any[]) {
          for (const ch of guild.channels.cache.values()) {
            if (!ch.isTextBased?.()) continue
            const lastMessageId = ch.lastMessageId as string | null
            const lastActivityAt = lastMessageId
              ? new Date(snowflakeToTimestamp(lastMessageId)).toISOString()
              : null
            if (sinceMs && (!lastMessageId || snowflakeToTimestamp(lastMessageId) < sinceMs)) continue
            channels.push({
              id: ch.id,
              name: ch.name,
              guildId: guild.id,
              guildName: guild.name,
              type: ch.type,  // discord.js ChannelType enum value
              isThread: ch.isThread?.() ?? false,
              parentId: ch.parentId ?? null,
              lastMessageId,
              lastActivityAt,
            })
          }
        }

        channels.sort((a, b) => {
          if (!a.lastMessageId) return 1
          if (!b.lastMessageId) return -1
          return b.lastMessageId.localeCompare(a.lastMessageId)
        })

        res.json({
          channels,
          metadata: {
            count: channels.length,
            guildCount: guilds.length,
            guildIdFilter: guildIdFilter || null,
            since: sinceParam || null,
          },
        })
      } catch (error: any) {
        logger.error({ error }, 'API error in /api/channels')
        res.status(500).json({
          error: 'Internal Server Error',
          message: error.message || 'Failed to list channels',
        })
      }
    })

    this.app.get('/api/channels/:channelId/latest', async (req: Request, res: Response) => {
      try {
        const channelId = req.params.channelId
        if (!channelId || !/^\d+$/.test(channelId)) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'channelId must be a Discord channel ID (numeric)',
          })
          return
        }
        const messages = Math.min(Math.max(parseInt(req.query.messages as string) || 50, 1), 500)
        const maxImages = req.query.maxImages !== undefined
          ? Math.max(parseInt(req.query.maxImages as string) || 0, 0)
          : 50
        const ignoreHistory = req.query.ignoreHistory !== 'false'

        const result = await this.fetchLatestMessages(channelId, messages, maxImages, ignoreHistory)
        res.json(result)
      } catch (error: any) {
        logger.error({ error, channelId: req.params.channelId }, 'API error in /api/channels/:channelId/latest')
        if (error.message?.includes('not found') || error.message?.includes('Unknown')) {
          res.status(404).json({ error: 'Not Found', message: error.message })
        } else if (error.message?.includes('Missing Access') || error.message?.includes('not accessible')) {
          res.status(403).json({ error: 'Forbidden', message: error.message })
        } else {
          res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'Failed to fetch latest messages',
          })
        }
      }
    })

    this.app.post('/api/context/build', async (req: Request, res: Response) => {
      try {
        if (!this.configSystem || !this.contextBuilder || !this.botName) {
          res.status(501).json({
            error: 'Not Available',
            message: 'Context building requires configSystem, contextBuilder, and botName'
          })
          return
        }

        const { channel, messages: messageCount } = req.body as {
          channel: string
          messages?: number
        }

        if (!channel) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'Missing required parameter: channel',
            details: 'Provide a Discord channel URL or channel ID'
          })
          return
        }

        const result = await this.buildFullContext(channel, messageCount)
        res.json(result)
      } catch (error: any) {
        logger.error({ error, body: req.body }, 'API error in /api/context/build')

        if (error.message?.includes('Invalid') || error.message?.includes('Missing')) {
          res.status(400).json({ error: 'Bad Request', message: error.message })
        } else if (error.message?.includes('not found') || error.message?.includes('Unknown')) {
          res.status(404).json({ error: 'Not Found', message: error.message })
        } else if (error.message?.includes('not accessible') || error.message?.includes('Missing Access')) {
          res.status(403).json({ error: 'Forbidden', message: error.message })
        } else {
          res.status(500).json({ error: 'Internal Server Error', message: error.message || 'An unexpected error occurred' })
        }
      }
    })
  }

  private async exportMessages(request: MessageExportRequest): Promise<MessageExportResponse> {
    logger.debug({ last: request.last, first: request.first }, 'Starting exportMessages')
    
    const channelId = this.extractChannelIdFromUrl(request.last)
    const guildId = this.extractGuildIdFromUrl(request.last)
    const lastMessageId = this.extractMessageIdFromUrl(request.last)
    const firstMessageId = request.first ? (this.extractMessageIdFromUrl(request.first) || undefined) : undefined
    
    logger.debug({ channelId, guildId, lastMessageId, firstMessageId }, 'Parsed IDs from URL')
    
    if (!channelId || !guildId || !lastMessageId) {
      throw new Error('Invalid Discord message URL format')
    }

    const recencyWindow = request.recencyWindow || { messages: 50 }
    const maxFetch = recencyWindow.messages ? recencyWindow.messages + HISTORY_AND_FILTER_BUFFER : 1000

    const maxImages = request.maxImages ?? 50
    const ignoreHistory = request.ignoreHistory ?? true
    logger.debug({ channelId, targetMessageId: lastMessageId, firstMessageId, depth: maxFetch, maxImages, ignoreHistory }, 'Calling fetchContext')
    let context
    try {
      context = await this.connector.fetchContext({
        channelId,
        depth: maxFetch,
        targetMessageId: lastMessageId,
        firstMessageId,
        maxImages,
        ignoreHistory,
      })
    } catch (error: any) {
      if (error.code === 50001) {
        throw new Error(`Missing Access: Bot does not have permission to view channel ${channelId}`)
      } else if (error.code === 10003) {
        throw new Error(`Channel ${channelId} not found or bot is not a member of this guild`)
      } else if (error.code === 10008) {
        throw new Error(`Unknown Message: Message not found in channel ${channelId}`)
      }
      throw new Error(`Failed to fetch messages: ${error.message}`)
    }
    
    let messages = context.messages
    const imageCache = new Map(context.images.map(img => [img.url, img]))
    
    logger.debug({ 
      fetchedMessages: messages.length, 
      cachedImages: imageCache.size 
    }, 'fetchContext complete (with .history processing)')

    if (messages.length === 0) {
      throw new Error(`No messages found in channel ${channelId}. The bot may lack access.`)
    }

    if (firstMessageId) {
      const firstIndex = messages.findIndex(m => m.id === firstMessageId)
      if (firstIndex >= 0) {
        messages = messages.slice(firstIndex)
        logger.debug({ 
          trimmedFrom: firstIndex, 
          remaining: messages.length,
          firstMessageId 
        }, 'Trimmed to first message boundary')
      } else {
        logger.warn({ firstMessageId, totalMessages: messages.length }, 'First message not found in fetched range')
      }
    }

    const messagesBeforeTruncation = messages.length

    messages = this.applyRecencyWindow(messages, recencyWindow)
    
    const wasExplicitlyTruncated = !!(request.recencyWindow 
      && messagesBeforeTruncation > messages.length)
    
    if (wasExplicitlyTruncated) {
      logger.debug({ beforeTruncate: messagesBeforeTruncation, afterTruncate: messages.length }, 'Applied recency window')
    }

    messages = this.mergeConsecutiveBotMessages(messages)

    const exportedMessages = messages.map(m => this.toExportMessage(m, imageCache))

    return {
      messages: exportedMessages,
      metadata: {
        channelId,
        guildId,
        firstMessageId: messages[0]?.id || '',
        lastMessageId: messages[messages.length - 1]?.id || '',
        totalCount: messages.length,
        truncated: wasExplicitlyTruncated,
      },
    }
  }

  private toExportMessage(msg: any, imageCache: Map<string, any>): any {
    return {
      id: msg.id,
      author: {
        id: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.displayName,
        bot: msg.author.bot,
      },
      content: msg.content,
      timestamp: msg.timestamp.toISOString(),
      reactions: msg.reactions || [],
      attachments: msg.attachments.map((att: any) => {
        const cached = imageCache.get(att.url)
        return {
          id: att.id,
          url: att.url,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          base64Data: cached ? cached.data.toString('base64') : undefined,
          mediaType: cached ? cached.mediaType : undefined,
        }
      }),
      referencedMessageId: msg.referencedMessage,
    }
  }

  private async fetchLatestMessages(
    channelId: string,
    messageCount: number,
    maxImages: number,
    ignoreHistory: boolean
  ): Promise<any> {
    let context
    try {
      context = await this.connector.fetchContext({
        channelId,
        depth: messageCount,
        maxImages,
        ignoreHistory,
      })
    } catch (error: any) {
      if (error.code === 50001) {
        throw new Error(`Missing Access: Bot does not have permission to view channel ${channelId}`)
      } else if (error.code === 10003) {
        throw new Error(`Channel ${channelId} not found or bot is not a member of this guild`)
      }
      throw new Error(`Failed to fetch messages: ${error.message}`)
    }

    const messages = context.messages
    if (messages.length === 0) {
      throw new Error(`No messages found in channel ${channelId}`)
    }
    const imageCache = new Map(context.images.map(img => [img.url, img]))
    const exportedMessages = messages.map(m => this.toExportMessage(m, imageCache))

    return {
      messages: exportedMessages,
      metadata: {
        channelId,
        firstMessageId: messages[0]?.id || '',
        lastMessageId: messages[messages.length - 1]?.id || '',
        totalCount: messages.length,
        requestedCount: messageCount,
        ignoreHistory,
      },
    }
  }

  private async getUserInfo(userId: string, guildId?: string): Promise<any> {
    const client = (this.connector as any).client
    
    let user
    try {
      user = await client.users.fetch(userId)
    } catch (error: any) {
      if (error.code === 10013) {
        throw new Error(`Unknown User: User ${userId} not found`)
      }
      throw new Error(`Failed to fetch user: ${error.message}`)
    }
    
    if (!user) {
      throw new Error(`Unknown User: User ${userId} not found`)
    }

    let displayName = user.username
    let roles: string[] = []
    
    if (guildId) {
      try {
        const guild = await client.guilds.fetch(guildId)
        const member = await guild.members.fetch(userId)
        displayName = member.displayName || user.username
        roles = member.roles.cache.map((r: any) => r.name).filter((n: string) => n !== '@everyone')
      } catch (error: any) {
        logger.warn({ error, userId, guildId }, 'Failed to fetch guild member info')
        if (error.code === 10004) {
          throw new Error(`Guild ${guildId} not found or bot is not a member`)
        } else if (error.code === 10007) {
          throw new Error(`User ${userId} is not a member of guild ${guildId}`)
        }
        logger.warn({ error, userId, guildId }, 'Using global user info instead of guild-specific')
      }
    }

    return {
      id: user.id,
      username: user.username,
      displayName,
      discriminator: user.discriminator,
      bot: user.bot,
      avatarUrl: user.displayAvatarURL({ size: 128 }),
      roles: guildId ? roles : undefined,
    }
  }

  private async getUserAvatar(userId: string, size: number = 128): Promise<string | null> {
    const client = (this.connector as any).client
    
    try {
      const user = await client.users.fetch(userId)
      if (!user) {
        throw new Error(`Unknown User: User ${userId} not found`)
      }

      return user.displayAvatarURL({ size, extension: 'png' })
    } catch (error: any) {
      if (error.code === 10013) {
        throw new Error(`Unknown User: User ${userId} not found`)
      }
      logger.warn({ error, userId }, 'Failed to fetch user avatar')
      throw error
    }
  }

  private applyRecencyWindow(messages: any[], window: { messages?: number, characters?: number }): any[] {
    let result = messages

    if (window.messages && messages.length > window.messages) {
      result = messages.slice(-window.messages)
    }

    if (window.characters) {
      const kept: any[] = []
      let charCount = 0

      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i] as any
        if (!msg) continue
        
        const msgLength = (msg.content || '').length
        
        if (charCount + msgLength > window.characters && kept.length > 0) {
          break
        }
        
        kept.unshift(msg)
        charCount += msgLength
      }
      
      result = kept
    }

    return result
  }

  private mergeConsecutiveBotMessages(messages: any[]): any[] {
    if (messages.length === 0) return messages

    const merged: any[] = []
    let current: any = null

    for (const msg of messages) {
      if (!msg.author?.bot) {
        if (current) {
          merged.push(current)
          current = null
        }
        merged.push(msg)
        continue
      }

      if (current && current.author?.id === msg.author?.id) {
        current.content = current.content + '\n' + msg.content
        current._mergedIds = current._mergedIds || [current.id]
        current._mergedIds.push(msg.id)
        current.id = msg.id
        current.attachments = [...(current.attachments || []), ...(msg.attachments || [])]
        const existingEmojis = new Set((current.reactions || []).map((r: any) => r.emoji))
        for (const reaction of (msg.reactions || [])) {
          if (!existingEmojis.has(reaction.emoji)) {
            current.reactions = current.reactions || []
            current.reactions.push(reaction)
          }
        }
      } else {
        if (current) {
          merged.push(current)
        }
        current = { ...msg }
      }
    }

    if (current) {
      merged.push(current)
    }

    logger.debug({ 
      originalCount: messages.length, 
      mergedCount: merged.length 
    }, 'Merged consecutive bot messages')

    return merged
  }

  private extractChannelIdFromUrl(url: string): string | null {
    const match = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
    return match ? match[1]! : null
  }

  private extractGuildIdFromUrl(url: string): string | null {
    const match = url.match(/\/channels\/(\d+)\/\d+\/\d+/)
    return match ? match[1]! : null
  }

  private extractMessageIdFromUrl(url: string): string | null {
    const match = url.match(/\/channels\/\d+\/\d+\/(\d+)/)
    return match ? match[1]! : null
  }

  private async buildFullContext(channel: string, messageCount?: number): Promise<any> {
    let channelId: string
    let guildId: string = ''
    const urlMatch = channel.match(/\/channels\/(\d+)\/(\d+)/)
    if (urlMatch) {
      guildId = urlMatch[1]!
      channelId = urlMatch[2]!
    } else if (/^\d+$/.test(channel)) {
      channelId = channel
    } else {
      throw new Error('Invalid channel: provide a Discord channel URL or numeric channel ID')
    }

    const config = this.configSystem!.loadConfig({
      botName: this.botName!,
      guildId,
      channelConfigs: [],
    })

    const fetchMessages = messageCount || config.recency_window_messages || 200
    const fetchDepth = fetchMessages + HISTORY_AND_FILTER_BUFFER

    const discordContext = await this.connector.fetchContext({
      channelId,
      depth: fetchDepth,
      maxImages: config.include_images ? Math.max((config.max_images || 5) * 2, 10) : 0,
      displayNames: displayNameClasses(config),
    })

    const discordFetched = discordContext.messages.length

    if (discordFetched === 0) {
      throw new Error(`No messages found in channel ${channelId}`)
    }

    const overriddenConfig = {
      ...config,
      recency_window_messages: fetchMessages,
      recency_window_characters: Infinity,
      hard_max_characters: Infinity,
    }

    const botUsername = this.connector.getBotUsername()

    const contextResult = await this.contextBuilder!.buildContext({
      discordContext,
      toolCacheWithResults: [],
      lastCacheMarker: null,
      messagesSinceRoll: 0,
      config: overriddenConfig,
      botDiscordUsername: botUsername || undefined,
    })

    const messages = contextResult.request.messages.map(msg => ({
      participant: msg.participant,
      content: msg.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('\n'),
      hasImages: msg.content.some(b => b.type === 'image'),
      imageCount: msg.content.filter(b => b.type === 'image').length,
    }))

    return {
      messages,
      metadata: {
        botName: config.name,
        channelId,
        messageCount: messages.length,
        discordMessagesFetched: discordFetched,
        configuredLimit: config.recency_window_messages,
        requestedLimit: messageCount || null,
        model: config.continuation_model,
        mode: config.mode || 'prefill',
        systemPrompt: config.system_prompt ? config.system_prompt.substring(0, 200) + (config.system_prompt.length > 200 ? '...' : '') : null,
        contextPrefix: config.context_prefix ? config.context_prefix.substring(0, 200) + (config.context_prefix.length > 200 ? '...' : '') : null,
        stopSequences: contextResult.request.stop_sequences,
      },
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        logger.info({ port: this.config.port }, 'API server started')
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('API server stopped')
          resolve()
        })
      })
    }
  }
}

