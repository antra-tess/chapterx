/**
 * Pure adapters: PortalMessage / PortalEvent → chatperx's internal shapes.
 *
 * These are the unit-test target. No I/O, no portal-client — just shape
 * translation. The agent loop reads discord.js-`Message`-compatible objects off
 * `event.data` (see connector/types.ts `InboundMessage`), so we synthesize that
 * duck type faithfully.
 */
import type { PortalMessage, PortalEvent } from '@animalabs/portal-protocol'
import type { Event } from '../../types.js'
import type { InboundMessage } from '../types.js'

/** Context the event adapter needs that isn't on the event itself. */
export interface AdapterCtx {
  botPersonaId: string
  /** relayId → author id (persona/user) of a previously-seen message. */
  authorOf(messageId: string): string | undefined
  /** channelId (or threadId) → guild id, from the client cache. */
  guildOf(channelId: string): string
}

/** The immediate channel a message lives in (thread when threaded). */
export function containerOf(pm: { channelId: string; threadId?: string }): string {
  return pm.threadId ?? pm.channelId
}

/** Resolve a PortalMessage author to a discord.js-ish `{id,username,bot}`. */
export function authorOfMessage(pm: PortalMessage): {
  id: string
  username: string
  bot: boolean
  globalName?: string
} {
  const a = pm.author
  if (a.kind === 'persona') return { id: a.personaId, username: a.displayName, bot: true, globalName: a.displayName }
  if (a.kind === 'user') return { id: a.userId, username: a.username, bot: a.bot, globalName: a.displayName }
  return { id: 'system', username: 'system', bot: true }
}

/**
 * PortalMessage → the discord.js-`Message`-compatible object the loop reads off
 * `event.data`. `mentions.has(id)` translates a persona role-mention into a
 * "bot mentioned" signal (botUserId === personaId). `address` carries the relay's
 * per-recipient addressing reasons (role_mention / reply / subscription); a
 * reply-ping can only be detected via `reasons`, since webhook personas never
 * appear in `mentions`.
 */
export function inboundFromPortal(
  pm: PortalMessage,
  _botPersonaId: string,
  address?: { addressedToMe: boolean; reasons: string[] },
): InboundMessage {
  const author = authorOfMessage(pm)
  const mentionedIds = new Set<string>([...pm.mentions.personas, ...pm.mentions.users])
  const users = new Map<string, unknown>(pm.mentions.users.map((id) => [id, { id }]))
  return {
    id: pm.id,
    channelId: containerOf(pm),
    guildId: pm.guildId ?? '',
    content: pm.content,
    author,
    system: pm.author.kind === 'system',
    reference: pm.replyToId ? { messageId: pm.replyToId } : undefined,
    _address: address,
    mentions: {
      has: (id: string) => mentionedIds.has(id),
      users,
    },
    // Back the show-reaction override with the message's real reactions. The
    // loop calls `r.emoji?.name` — Portal carries the unicode/`name:id` string,
    // so wrap each as `{ emoji: { name } }`.
    reactions: {
      cache: {
        some: (fn: (r: unknown) => boolean) => pm.reactions.some((r) => fn({ emoji: { name: r.emoji } })),
      },
    },
    // member.roles unavailable inbound (P1); role-gated user features degrade.
    member: undefined,
    _portal: pm,
  }
}

/** A PortalEvent → an EventQueue `Event`, or null when it shouldn't enqueue. */
export function queueEventFromPortal(e: PortalEvent, ctx: AdapterCtx): Event | null {
  switch (e.type) {
    case 'message_create': {
      const inbound = inboundFromPortal(e.message, ctx.botPersonaId, {
        addressedToMe: e.addressedToMe,
        reasons: e.reasons,
      })
      return {
        type: 'message',
        channelId: inbound.channelId,
        guildId: inbound.guildId,
        data: inbound,
        timestamp: new Date(e.message.createdAt),
        receivedAt: Date.now(),
      }
    }
    case 'message_update': {
      const inbound = inboundFromPortal(e.message, ctx.botPersonaId, {
        addressedToMe: e.addressedToMe,
        reasons: e.reasons,
      })
      return {
        type: 'edit',
        channelId: inbound.channelId,
        guildId: inbound.guildId,
        data: { old: undefined, new: inbound },
        timestamp: new Date(e.message.editedAt ?? e.message.createdAt),
      }
    }
    case 'message_delete': {
      const channelId = e.threadId ?? e.channelId
      return {
        type: 'delete',
        channelId,
        guildId: ctx.guildOf(channelId),
        data: { id: e.messageId, author: { id: ctx.authorOf(e.messageId) ?? 'unknown' } },
        timestamp: new Date(),
      }
    }
    case 'reaction_add': {
      const channelId = e.threadId ?? e.channelId
      const reactorId = e.reaction.by[0]?.id
      // Can't attribute a reaction with no known reactor — drop it. Emitting
      // userId:undefined would bypass the loop's skip-own-reaction check
      // (userId === botUserId is false for undefined), letting the bot react to
      // its own reaction / process an unattributable trigger.
      if (!reactorId) return null
      return {
        type: 'reaction',
        channelId,
        guildId: ctx.guildOf(channelId),
        data: {
          messageId: e.messageId,
          emoji: e.reaction.emoji,
          userId: reactorId,
          messageAuthorId: ctx.authorOf(e.messageId),
        },
        timestamp: new Date(),
        receivedAt: Date.now(),
      }
    }
    // reaction_remove is observability-only in the discord backend (no enqueue);
    // typing/pins/structural/persona events are handled by the cache, not the loop.
    default:
      return null
  }
}
