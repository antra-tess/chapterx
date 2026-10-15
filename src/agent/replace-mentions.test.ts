/**
 * Tests that the agent loop's replaceMentions gives mentionsToIds the
 * conversation's authors, marking a webhook's, keeping other bots' and
 * leaving out the bot's own, and passes the bot's config on, config.name
 * included.
 *
 * The loop is built with stand-ins for everything it holds, since
 * replaceMentions uses none of them.
 *
 * Run with: npx vitest run replace-mentions
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentLoop } from './loop.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

type ReplaceMentions = (text: string, messages: unknown[], config: object) => Promise<string>

/** The loop's replaceMentions, on a loop that knows its bot's user id if one is given. */
function replaceMentions(botUserId?: string): ReplaceMentions {
  const dir = mkdtempSync(join(tmpdir(), 'replace-mentions-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const unused = {} as never
  const loop = new AgentLoop('bot', unused, unused, unused, unused, unused, unused, dir)
  if (botUserId) loop.setBotUserId(botUserId)
  const helper = (loop as unknown as { replaceMentions: ReplaceMentions }).replaceMentions
  return helper.bind(loop)
}

const message = (id: string, username: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  author: { id, username, displayName, bot: false },
  ...extra,
})

describe('AgentLoop.replaceMentions', () => {
  it('passes the config on, so labelling people by display name reads @Name', async () => {
    const messages = [message('111', 'jack_h4ndle', 'Jack')]
    expect(await replaceMentions()('@Jack', messages, { use_display_names_humans: true })).toBe('<@111>')
    expect(await replaceMentions()('@Jack', messages, {})).toBe('@Jack')
  })

  it("marks a webhook's messages, so a persona's name isn't pinged", async () => {
    const messages = [message('600', 'Persona', 'Persona', { webhookId: '600' })]
    expect(await replaceMentions()('<@Persona>', messages, {})).toBe('@Persona')
    expect(await replaceMentions()('<@Persona>', [message('600', 'Persona', 'Persona')], {})).toBe('<@600>')
  })

  it("leaves out the bot's own messages, which the context shows by its config name", async () => {
    const bot = { id: '999', username: 'sam_bot', displayName: 'Sam', bot: true }
    const messages = [{ author: bot }, message('111', 'sam_h4ndle', 'Sam')]
    expect(await replaceMentions('999')('@Sam', messages, { use_display_names_humans: true })).toBe('<@111>')
    // Without its own id, the loop can't tell, and the name reads as shared.
    expect(await replaceMentions()('@Sam', messages, { use_display_names_humans: true })).toBe('@Sam')
  })

  it("keeps another bot's messages, so its <@Name> goes to its id", async () => {
    const self = { id: '999', username: 'sam_bot', displayName: 'Sam', bot: true }
    const helper = { id: '333', username: 'helperbot', displayName: 'Helper', bot: true }
    const messages = [{ author: self }, { author: helper }]
    expect(await replaceMentions('999')('<@Helper> <@helperbot>', messages, {})).toBe('<@333> <@333>')
  })

  it("passes the bot's config.name on, which is held by no one", async () => {
    const messages = [message('444', 'claude_fan', 'Claude')]
    const humans = { use_display_names_humans: true }
    expect(await replaceMentions('999')('@Claude', messages, { ...humans, name: 'Claude' })).toBe('@Claude')
    expect(await replaceMentions('999')('@Claude', messages, humans)).toBe('<@444>')
  })

  it('leaves out a message with no author', async () => {
    const messages = [{ author: null }, message('111', 'jack_h4ndle', 'Jack')]
    expect(await replaceMentions()('<@jack_h4ndle>', messages, {})).toBe('<@111>')
  })
})
