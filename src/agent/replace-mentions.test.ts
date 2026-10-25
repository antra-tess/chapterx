import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentLoop } from './loop.js'
import { characterOverride } from '../context/stages/format-messages.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

type ReplaceMentions = (text: string, messages: unknown[], config: object) => Promise<string>

function replaceMentions(botUserId?: string, botUsername?: string): ReplaceMentions {
  const dir = mkdtempSync(join(tmpdir(), 'replace-mentions-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const unused = {} as never
  const connector = { getBotUsername: () => botUsername } as never
  const loop = new AgentLoop('bot', unused, connector, unused, unused, unused, unused, dir)
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
    expect(await replaceMentions()('@Sam', messages, { use_display_names_humans: true })).toBe('@Sam')
  })

  it("holds a character override's name, so a person shown by the same name pings no one", async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const sam = message('222', 'sam_h4ndle', 'Sam')
    const asJack = message('222', 'sam_h4ndle', 'Sam', { content: '~Jack: I am the other Jack' })
    expect(await replaceMentions()('@Jack', [jack, asJack], { use_display_names_humans: true })).toBe('@Jack')
    expect(await replaceMentions()('@Jack', [jack, sam], { use_display_names_humans: true })).toBe('<@111>')
    expect(await replaceMentions()('<@Jack>', [jack, asJack], {})).toBe('@Jack')
  })

  it("holds an override's name from a message the context drops for showing nothing past it, as it holds an author's", async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const bare = message('222', 'sam_h4ndle', 'Sam', { content: '~Jack:' })
    expect(await replaceMentions()('@Jack', [jack, bare], { use_display_names_humans: true })).toBe('@Jack')
  })

  it('holds an override the context shows with ignore_dotted_messages off, a reaction that would hide it included', async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const hidden = message('222', 'sam_h4ndle', 'Sam', { content: '~Jack: I am the other Jack', reactions: [{ emoji: '🫥' }] })
    expect(await replaceMentions()('@Jack', [jack, hidden], { use_display_names_humans: true, ignore_dotted_messages: false })).toBe('@Jack')
  })

  it('holds an override after a reply tag or mentions, and not one the context hides', async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const humans = { use_display_names_humans: true }
    const afterMention = message('222', 'sam_h4ndle', 'Sam', { content: '<@999> ~Jack: I am the other Jack' })
    expect(await replaceMentions()('@Jack', [jack, afterMention], humans)).toBe('@Jack')
    const hidden = message('222', 'sam_h4ndle', 'Sam', { content: '~Jack: I am the other Jack', reactions: [{ emoji: '🫥' }] })
    expect(await replaceMentions()('@Jack', [jack, hidden], humans)).toBe('<@111>')
  })

  it('holds an override as a person is shown, so its @Name form is held when bots are shown by username', async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const asJack = message('222', 'sam_h4ndle', 'Sam', { content: '~Jack: I am the other Jack' })
    expect(await replaceMentions()('@Jack', [jack, asJack], { use_display_names_humans: true, use_display_names_bots: false })).toBe('@Jack')
  })

  it("reads overrides from the bot's messages as the context joins them", async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const bot = { id: '999', username: 'sam_bot', displayName: 'sam_bot', bot: true }
    const first = { author: bot, content: 'Here is the scene.', attachments: [] }
    const asJack = { author: bot, content: '~Jack: I am the other Jack', attachments: [{ id: 'a2' }] }
    const humans = { use_display_names_humans: true }
    expect(await replaceMentions('999', 'sam_bot')('@Jack', [jack, first, asJack], humans)).toBe('<@111>')
    expect(await replaceMentions('999', 'sam_bot')('@Jack', [jack, asJack], humans)).toBe('@Jack')
    expect(first.attachments).toEqual([])
  })

  it("joins the bot's messages before it hides any, as the context does", async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const bot = { id: '999', username: 'sam_bot', displayName: 'sam_bot', bot: true }
    const hiddenFirst = { author: bot, content: 'Here is the scene.', attachments: [], reactions: [{ emoji: '🫥' }] }
    const asJack = { author: bot, content: '~Jack: I am the other Jack', attachments: [] }
    expect(await replaceMentions('999', 'sam_bot')('@Jack', [jack, hiddenFirst, asJack], { use_display_names_humans: true })).toBe('<@111>')
  })

  it("keeps the bot's messages apart when preserve_thinking_context does, as the context does", async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const bot = { id: '999', username: 'sam_bot', displayName: 'sam_bot', bot: true }
    const first = { author: bot, content: 'Here is the scene.', attachments: [] }
    const asJack = { author: bot, content: '~Jack: I am the other Jack', attachments: [] }
    const config = { use_display_names_humans: true, preserve_thinking_context: true }
    expect(await replaceMentions('999', 'sam_bot')('@Jack', [jack, first, asJack], config)).toBe('@Jack')
  })

  it("joins the bot's messages by config.name while the connector has no username for it", async () => {
    const jack = message('111', 'jack_h4ndle', 'Jack')
    const bot = { id: '999', username: 'sam_bot', displayName: 'sam_bot', bot: true }
    const first = { author: bot, content: 'Here is the scene.', attachments: [] }
    const asJack = { author: bot, content: '~Jack: I am the other Jack', attachments: [] }
    const config = { use_display_names_humans: true, name: 'sam_bot' }
    expect(await replaceMentions('999')('@Jack', [jack, first, asJack], config)).toBe('<@111>')
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
    const loop = new AgentLoop('bot', unused, { getBotUsername: () => undefined } as never, unused, unused, unused, unused, dir)
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

describe('characterOverride', () => {
  it('takes the ~Name: after a reply tag or mentions, and keeps them in the text', () => {
    expect(characterOverride('<@Claude> ~Narrator: scene opens')).toEqual({ name: 'Narrator', text: '<@Claude> scene opens' })
    expect(characterOverride('<reply:@sam> ~Jack: hi')).toEqual({ name: 'Jack', text: '<reply:@sam> hi' })
    expect(characterOverride('no override')).toEqual({ name: '', text: 'no override' })
  })
})
