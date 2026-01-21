/**
 * HTTP API Server
 * Provides REST endpoints for accessing Discord conversation history
 */

import express, { Request, Response, NextFunction } from 'express'
import { DiscordConnector } from '../discord/connector.js'
import { logger } from '../utils/logger.js'

export interface ApiConfig {
  port: number
  bearerToken: string
}

export interface MessageExportRequest {
  last: string  // Discord message URL (required)
  first?: string  // Discord message URL to stop at (optional)
  recencyWindow?: {
    messages?: number
    characters?: number
  }
  maxImages?: number  // Max images to fetch (default: 50)
}

export interface MessageExportResponse {
  messages: Array<{
    id: string
    author: {
      id: string
      username: string
      displayName: string
      bot: boolean
      // Future: mappedParticipant?: string
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
      base64Data?: string  // Base64-encoded image data
      mediaType?: string   // Detected MIME type
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
    private connector: DiscordConnector
  ) {
    this.setupMiddleware()
    this.setupRoutes()
  }

  private setupMiddleware(): void {
    this.app.use(express.json())
    
    // CORS headers for cross-origin requests
    this.app.use((req: Request, res: Response, next: NextFunction): void => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      
      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        res.sendStatus(200)
        return
      }
      next()
    })
    
    // Bearer token authentication
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip auth for health check and OPTIONS
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
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() })
    })

    // Export messages endpoint
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
        
        // Map known errors to appropriate status codes
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

    // Get user info
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

    // Get user avatar
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
  }

  private async exportMessages(request: MessageExportRequest): Promise<MessageExportResponse> {
    logger.debug({ last: request.last, first: request.first }, 'Starting exportMessages')
    
    // Parse URLs to extract IDs
    const channelId = this.extractChannelIdFromUrl(request.last)
    const guildId = this.extractGuildIdFromUrl(request.last)
    const lastMessageId = this.extractMessageIdFromUrl(request.last)
    const firstMessageId = request.first ? (this.extractMessageIdFromUrl(request.first) || undefined) : undefined
    
    logger.debug({ channelId, guildId, lastMessageId, firstMessageId }, 'Parsed IDs from URL')
    
    if (!channelId || !guildId || !lastMessageId) {
      throw new Error('Invalid Discord message URL format')
    }

    // Determine recency window (default: 50 messages)
    const recencyWindow = request.recencyWindow || { messages: 50 }
    const maxFetch = recencyWindow.messages ? recencyWindow.messages + 100 : 1000

    // Use connector.fetchContext() which automatically:
    // - Recursively handles .history commands during traversal
    // - Downloads and caches images
    // - Converts to DiscordMessage format
    const maxImages = request.maxImages ?? 50  // Default to 50 to prevent RAM bloat
    logger.debug({ channelId, targetMessageId: lastMessageId, firstMessageId, depth: maxFetch, maxImages }, 'Calling fetchContext')
    let context
    try {
      context = await this.connector.fetchContext({
        channelId,
        depth: maxFetch,
        targetMessageId: lastMessageId,  // Start from the 'last' URL
        firstMessageId,  // Stop at 'first' URL if provided
        maxImages,
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

    // Trim to 'first' message if specified (works across channels after .history traversal)
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

    // Track original count before applying recency window
    const messagesBeforeTruncation = messages.length

    // Apply recency window
    messages = this.applyRecencyWindow(messages, recencyWindow)
    
    // Track if recency window actually truncated (before merge which also reduces count)
    const wasExplicitlyTruncated = !!(request.recencyWindow 
      && messagesBeforeTruncation > messages.length)
    
    if (wasExplicitlyTruncated) {
      logger.debug({ beforeTruncate: messagesBeforeTruncation, afterTruncate: messages.length }, 'Applied recency window')
    }

    // Merge consecutive messages from the same bot
    messages = this.mergeConsecutiveBotMessages(messages)

    // Transform to export format (from DiscordMessage to API format)
    const exportedMessages = messages.map((msg: any) => ({
      id: msg.id,
      author: {
        id: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.displayName,
        bot: msg.author.bot,
        // Future: mappedParticipant will go here
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
    }))

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

  private async getUserInfo(userId: string, guildId?: string): Promise<any> {
    const client = (this.connector as any).client
    
    // Fetch user from Discord
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

    // Get guild-specific info if guildId provided
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
        // Don't throw for guild fetch failures - just use global info
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

    // Apply message limit
    if (window.messages && messages.length > window.messages) {
      result = messages.slice(-window.messages)
    }

    // Apply character limit
    if (window.characters) {
      const kept: any[] = []
      let charCount = 0

      // Work backwards from most recent
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

  /**
   * Merge consecutive messages from the same bot into a single message
   * This helps with bots that split responses across multiple Discord messages
   */
  private mergeConsecutiveBotMessages(messages: any[]): any[] {
    if (messages.length === 0) return messages

    const merged: any[] = []
    let current: any = null

    for (const msg of messages) {
      // Only merge bot messages
      if (!msg.author?.bot) {
        if (current) {
          merged.push(current)
          current = null
        }
        merged.push(msg)
        continue
      }

      // Check if this bot message should be merged with the previous
      if (current && current.author?.id === msg.author?.id) {
        // Same bot - merge content
        current.content = current.content + '\n' + msg.content
        // Track all merged IDs, use the LAST message's ID for the merged result
        current._mergedIds = current._mergedIds || [current.id]
        current._mergedIds.push(msg.id)
        current.id = msg.id  // Use latest message's ID
        // Merge attachments
        current.attachments = [...(current.attachments || []), ...(msg.attachments || [])]
        // Merge reactions (dedupe by emoji)
        const existingEmojis = new Set((current.reactions || []).map((r: any) => r.emoji))
        for (const reaction of (msg.reactions || [])) {
          if (!existingEmojis.has(reaction.emoji)) {
            current.reactions = current.reactions || []
            current.reactions.push(reaction)
          }
        }
      } else {
        // Different bot or first bot message
        if (current) {
          merged.push(current)
        }
        current = { ...msg }
      }
    }

    // Don't forget the last message
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

