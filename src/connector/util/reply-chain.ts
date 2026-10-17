/**
 * The reply-chain depth the agent loop limits with `max_bot_reply_chain_depth`,
 * to stop bots answering each other without end.
 */

/** A message as the walk needs it: who wrote it, and what it replies to. */
export interface ChainLink {
  authorId: string | undefined
  bot: boolean
  /** The id of the message this one replies to, if any. */
  replyTo: string | undefined
}

/**
 * Count the bot turns that lead up to `start` through its replies.
 *
 * The walk starts at `start` itself and follows each reply to the message it
 * answers. It stops at the first message from a human, at a message that
 * replies to nothing, or at a reply `lookup` can't find. Consecutive messages
 * from one bot count as one turn. So a human's message scores 0, and a bot's
 * reply to a bot's reply to a human scores 2.
 *
 * This is DiscordConnector.getBotReplyChainDepth's rule, and the portal
 * connector walks by it. Discord fetches any link by id; portal finds each link
 * in the channel's history, back to a bound (its CHAIN_PAGES), so there a chain
 * whose links reach further back is counted up to that bound.
 */
export async function replyChainDepth(
  start: ChainLink,
  lookup: (messageId: string) => Promise<ChainLink | null>,
): Promise<number> {
  let depth = 0
  let lastBot: string | undefined | null = null
  let current: ChainLink | null = start
  while (current && current.bot) {
    if (current.authorId !== lastBot) {
      depth++
      lastBot = current.authorId
    }
    if (!current.replyTo) break
    current = await lookup(current.replyTo)
  }
  return depth
}
