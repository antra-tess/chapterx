/**
 * A reaction emoji in the form the agent loop compares: discord.js gives a
 * custom emoji's bare name, and the portal relay carries one as `name:id` (a
 * unicode emoji as itself). The loop compares reactions and the configured
 * continuation emoji in this form, so either way of writing a custom emoji
 * matches.
 */
export function emojiName(emoji: string): string {
  const custom = /^([^:]+):\d+$/.exec(emoji)
  return custom ? custom[1]! : emoji
}
