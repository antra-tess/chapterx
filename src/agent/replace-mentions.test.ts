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
  content: 'hi',
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
    const messages = [{ author: bot, content: 'hi' }, message('111', 'sam_h4ndle', 'Sam')]
    expect(await replaceMentions('999')('@Sam', messages, { use_display_names_humans: true })).toBe('<@111>')
    // Without its own id, the loop can't tell, and the name reads as shared.
    expect(await replaceMentions()('@Sam', messages, { use_display_names_humans: true })).toBe('@Sam')
  })

  it("keeps another bot's messages, so its <@Name> goes to its id", async () => {
    const self = { id: '999', username: 'sam_bot', displayName: 'Sam', bot: true }
    const helper = { id: '333', username: 'helperbot', displayName: 'Helper', bot: true }
    const messages = [{ author: self, content: 'hi' }, { author: helper, content: 'hi' }]
    expect(await replaceMentions('999')('<@Helper> <@helperbot>', messages, {})).toBe('<@333> <@333>')
  })

  it("passes the bot's config.name on, which is held by no one", async () => {
    const messages = [message('444', 'claude_fan', 'Claude')]
    const humans = { use_display_names_humans: true }
    expect(await replaceMentions('999')('@Claude', messages, { ...humans, name: 'Claude' })).toBe('@Claude')
    expect(await replaceMentions('999')('@Claude', messages, humans)).toBe('<@444>')
  })

  it('leaves out a message with no author', async () => {
    const messages = [{ author: null, content: 'hi' }, message('111', 'jack_h4ndle', 'Jack')]
    expect(await replaceMentions()('<@jack_h4ndle>', messages, {})).toBe('<@111>')
  })

  it("leaves out messages the context hides, so a name only they carry isn't shared", async () => {
    const messages = [message('111', 'jack_one', 'Jack'), message('112', 'jack_two', 'Jack', { content: '.note to self' })]
    const humans = { use_display_names_humans: true }
    expect(await replaceMentions()('@Jack', messages, humans)).toBe('<@111>')
    // When the context shows dot messages, the second Jack is in the conversation too.
    expect(await replaceMentions()('@Jack', messages, { ...humans, ignore_dotted_messages: false })).toBe('@Jack')
  })

  it('counts a .steer message only when steer_visible shows it, as the context does', async () => {
    const messages = [message('111', 'jack_one', 'Jack'), message('112', 'jack_two', 'Jack', { content: '.steer be brief' })]
    const humans = { use_display_names_humans: true }
    expect(await replaceMentions()('@Jack', messages, humans)).toBe('<@111>')
    expect(await replaceMentions()('@Jack', messages, { ...humans, steer_visible: true })).toBe('@Jack')
  })

  it('reads the reactions that hide or show a message, as the context does', async () => {
    const humans = { use_display_names_humans: true }
    const hidden = [message('111', 'jack_one', 'Jack'), message('112', 'jack_two', 'Jack', { reactions: [{ emoji: '🫥' }] })]
    expect(await replaceMentions()('@Jack', hidden, humans)).toBe('<@111>')
    const shown = [
      message('111', 'jack_one', 'Jack'),
      message('112', 'jack_two', 'Jack', { content: '.note to self', reactions: [{ emoji: '👁️‍🗨️' }] }),
    ]
    expect(await replaceMentions()('@Jack', shown, humans)).toBe('@Jack')
  })

  it("leaves out the connector's placeholder for a message without an author, which isn't anyone", async () => {
    const placeholder = { author: { id: 'system', username: 'system', displayName: 'system', bot: true }, content: '' }
    const messages = [message('111', 'sys_h4ndle', 'system'), placeholder]
    expect(await replaceMentions()('@system', messages, { use_display_names_humans: true })).toBe('<@111>')
  })
})

describe('AgentLoop.replaceMentionsInSegments', () => {
  type Segment = { prefix: string; visible: string }
  type InSegments = (segments: Segment[], messages: unknown[], config: object, carry: unknown[]) => Promise<void>

  it('reads each segment from the code block the segment before it left open, as they are sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replace-mentions-test-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const unused = {} as never
    const loop = new AgentLoop('bot', unused, unused, unused, unused, unused, unused, dir)
    const inSegments = (loop as unknown as { replaceMentionsInSegments: InSegments }).replaceMentionsInSegments.bind(loop)
    const segments: Segment[] = [
      { prefix: '', visible: 'see:\n```\n@Jack' },
      { prefix: '', visible: '' },
      { prefix: '', visible: '```\nThanks @Jack' },
    ]
    await inSegments(segments, [message('111', 'jack_h4ndle', 'Jack')], { use_display_names_humans: true }, [])
    expect(segments.map((s) => s.visible)).toEqual(['see:\n```\n@Jack', '', '```\nThanks <@111>'])
  })
})
