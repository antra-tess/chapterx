/**
 * Steering state store — per-channel per-bot steering config.
 *
 * Follows the pin cache pattern from connector.ts:
 *   - In-memory Map for fast access (hot path in shouldActivate/handleActivation)
 *   - Disk persistence for surviving restarts
 *   - Key: `${botId}:${channelId}`
 *
 * Disk layout:
 *   {steeringDir}/{channelId}/{botId}.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { logger } from '../utils/logger.js'
import { channelSteeringSchema } from './types.js'
import type { ChannelSteering } from './types.js'

export class SteeringStore {
  private cache = new Map<string, ChannelSteering>()
  private steeringDir: string

  constructor(steeringDir: string) {
    this.steeringDir = steeringDir
    if (!existsSync(steeringDir)) {
      mkdirSync(steeringDir, { recursive: true })
    }
    this.loadFromDisk()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get steering config for a bot in a channel.
   * Returns null if no steering is set.
   */
  get(botId: string, channelId: string): ChannelSteering | null {
    return this.cache.get(this.key(botId, channelId)) ?? null
  }

  /**
   * Set steering config for a bot in a channel.
   * Persists to both memory and disk.
   */
  set(botId: string, channelId: string, config: ChannelSteering): void {
    const k = this.key(botId, channelId)
    this.cache.set(k, config)
    this.saveToDisk(botId, channelId, config)
    logger.info({
      botId,
      channelId,
      interventions: config.interventions.length,
      readout_probes: config.readout_probes.length,
    }, 'Steering config updated')
  }

  /**
   * Clear steering for a bot in a channel.
   * Removes from memory and disk.
   */
  clear(botId: string, channelId: string): void {
    const k = this.key(botId, channelId)
    this.cache.delete(k)
    this.deleteFromDisk(botId, channelId)
    logger.info({ botId, channelId }, 'Steering config cleared')
  }

  /**
   * Check if any steering is active for a bot in a channel.
   */
  has(botId: string, channelId: string): boolean {
    return this.cache.has(this.key(botId, channelId))
  }

  /**
   * List all channels with active steering for a bot.
   */
  listChannels(botId: string): string[] {
    const channels: string[] = []
    for (const k of this.cache.keys()) {
      const [b, c] = k.split(':')
      if (b === botId && c) channels.push(c)
    }
    return channels
  }

  // -------------------------------------------------------------------------
  // Disk persistence
  // -------------------------------------------------------------------------

  private loadFromDisk(): void {
    if (!existsSync(this.steeringDir)) return

    let loaded = 0
    try {
      const channelDirs = readdirSync(this.steeringDir, { withFileTypes: true })
        .filter(d => d.isDirectory())

      for (const dir of channelDirs) {
        const channelId = dir.name
        const channelPath = join(this.steeringDir, channelId)

        try {
          const files = readdirSync(channelPath).filter(f => f.endsWith('.json'))
          for (const file of files) {
            const botId = file.replace('.json', '')
            try {
              const raw = readFileSync(join(channelPath, file), 'utf-8')
              const data = JSON.parse(raw)
              const parsed = channelSteeringSchema.safeParse(data)
              if (parsed.success) {
                this.cache.set(this.key(botId, channelId), parsed.data as ChannelSteering)
                loaded++
              } else {
                logger.warn({ botId, channelId, errors: parsed.error.issues }, 'Invalid steering cache file — skipping')
              }
            } catch {
              // Skip corrupted files
            }
          }
        } catch {
          // Skip unreadable channel dirs
        }
      }

      if (loaded > 0) {
        logger.info({ loaded, dir: this.steeringDir }, 'Loaded steering configs from disk')
      }
    } catch (error) {
      logger.warn({ error, dir: this.steeringDir }, 'Failed to read steering cache directory')
    }
  }

  private saveToDisk(botId: string, channelId: string, config: ChannelSteering): void {
    try {
      const channelDir = join(this.steeringDir, channelId)
      if (!existsSync(channelDir)) {
        mkdirSync(channelDir, { recursive: true })
      }
      writeFileSync(
        join(channelDir, `${botId}.json`),
        JSON.stringify(config, null, 2),
        'utf-8'
      )
    } catch (error) {
      logger.warn({ error, botId, channelId }, 'Failed to persist steering config to disk')
    }
  }

  private deleteFromDisk(botId: string, channelId: string): void {
    try {
      const filePath = join(this.steeringDir, channelId, `${botId}.json`)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
    } catch (error) {
      logger.warn({ error, botId, channelId }, 'Failed to delete steering config from disk')
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private key(botId: string, channelId: string): string {
    return `${botId}:${channelId}`
  }
}
