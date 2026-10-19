/**
 * Tests for turning the model's mentions back into Discord mentions by id.
 *
 * Run with: npx vitest run outgoing-mentions
 */

import { describe, it, expect } from 'vitest'
import { mentionsToIds, type MentionAuthor } from './outgoing-mentions.js'

const jack: MentionAuthor = { id: '111', username: 'jack_h4ndle', displayName: 'Jack', bot: false }
const jackSmith: MentionAuthor = { id: '222', username: 'js.smith', displayName: 'Jack Smith', bot: false }
const otherBot: MentionAuthor = { id: '333', username: 'helperbot', displayName: 'Helper', bot: true }

const byUsername = {}
const byDisplayName = { use_display_names_humans: true }

describe('mentionsToIds', () => {
  it('turns <@username> into a mention by id, as before', () => {
    expect(mentionsToIds('hi <@jack_h4ndle>!', [jack], byUsername)).toBe('hi <@111>!')
    expect(mentionsToIds('hi <@JACK_H4NDLE>', [jack], byUsername)).toBe('hi <@111>')
  })

  it("reads a username's dot as a dot", () => {
    expect(mentionsToIds('<@jsxsmith> <@js.smith>', [jackSmith], byUsername)).toBe('<@jsxsmith> <@222>')
  })

  it('leaves display names alone when people are labelled by username', () => {
    expect(mentionsToIds('@Jack and <@Jack>', [jack], byUsername)).toBe('@Jack and <@Jack>')
    expect(mentionsToIds('@Jack', [jack], { use_display_names: false })).toBe('@Jack')
  })

  it('reads the display-name keys as the context builder does', () => {
    expect(mentionsToIds('@Jack', [jack], { use_display_names: true })).toBe('<@111>')
    expect(mentionsToIds('@Jack', [jack], { use_display_names: true, use_display_names_humans: false })).toBe('@Jack')
    expect(mentionsToIds('@Jack', [jack], { use_display_names_bots: true })).toBe('@Jack')
  })

  it('turns @Display Name and <@Display Name> into mentions by id when people are labelled by display name', () => {
    expect(mentionsToIds('@Jack, look', [jack], byDisplayName)).toBe('<@111>, look')
    expect(mentionsToIds('look, <@Jack>', [jack], byDisplayName)).toBe('look, <@111>')
    expect(mentionsToIds('thanks @jack', [jack], byDisplayName)).toBe('thanks <@111>')
    expect(mentionsToIds('<@jack_h4ndle> still works', [jack], byDisplayName)).toBe('<@111> still works')
  })

  it("reads <@Name> as the display name first, even when it is someone else's username", () => {
    const sam: MentionAuthor = { id: '555', username: 'samuel_k', displayName: 'Sam', bot: false }
    const samUsername: MentionAuthor = { id: '666', username: 'sam', displayName: 'Samantha', bot: false }
    expect(mentionsToIds('<@Sam> and <@sam>', [samUsername, sam], byDisplayName)).toBe('<@555> and <@555>')
    expect(mentionsToIds('<@sam>', [samUsername, sam], byUsername)).toBe('<@666>')
  })

  it('takes the longest name first, and only a whole name', () => {
    expect(mentionsToIds('@Jack Smith and @Jack', [jack, jackSmith], byDisplayName)).toBe('<@222> and <@111>')
    expect(mentionsToIds('@Jackson is someone else', [jack], byDisplayName)).toBe('@Jackson is someone else')
    const ren: MentionAuthor = { id: '777', username: 'ren', displayName: 'Ren', bot: false }
    expect(mentionsToIds('@René, not @Ren!', [ren], byDisplayName)).toBe('@René, not <@777>!')
    // A longer name the conversation doesn't hold can't be known, so its start is read.
    const sam: MentionAuthor = { id: '888', username: 'sam_k', displayName: 'Sam', bot: false }
    expect(mentionsToIds('@Sam Altman', [sam], byDisplayName)).toBe('<@888> Altman')
  })

  it('starts a mention only at the start of a word', () => {
    for (const written of ['mail me at a@Jack.com', 'https://medium.com/@Jack', 'x:@Jack', '<reply:@Jack> hi', 'one,@Jack']) {
      expect(mentionsToIds(written, [jack], byDisplayName)).toBe(written)
    }
    expect(mentionsToIds('(@Jack) **@Jack** "@Jack"\n@Jack', [jack], byDisplayName))
      .toBe('(<@111>) **<@111>** "<@111>"\n<@111>')
  })

  it('leaves code spans and code blocks as written', () => {
    expect(mentionsToIds('`@Jack` and `<@jack_h4ndle>`', [jack], byDisplayName)).toBe('`@Jack` and `<@jack_h4ndle>`')
    expect(mentionsToIds('```\n@Jack\n```\nthen @Jack', [jack], byDisplayName)).toBe('```\n@Jack\n```\nthen <@111>')
  })

  it("reads as code what the splitter or Discord reads as code: a span nothing closes, and a ``` mid-line in a block", () => {
    // The splitter closes the span at the end of the message, so Discord shows it as code.
    expect(mentionsToIds('Example: `x @Jack', [jack], byDisplayName)).toBe('Example: `x @Jack')
    // Discord ends this block at the ``` mid-line, the splitter at its closer line.
    expect(mentionsToIds('```\n@Jack\n``` then @Jack', [jack], byDisplayName)).toBe('```\n@Jack\n``` then @Jack')
    // Discord pairs the next two ``` as a second block, where the splitter reads prose.
    const twoBlocks = '```\ncode ``` text\n```\nmore @Jack ```\nafter @Jack'
    expect(mentionsToIds(twoBlocks, [jack], byDisplayName)).toBe(twoBlocks)
  })

  it('reads text that begins inside a carried span as the splitter sends it, its reopener fused with a backtick the text starts with', () => {
    const span = [{ kind: 'inlineCode' as const, opener: '`', closer: '`' }]
    expect(mentionsToIds('`x @Jack ``y', [jack], byDisplayName, span)).toBe('`x @Jack ``y')
  })

  it('leaves a mention any part of which is code as written, as a backtick template writes one', () => {
    expect(mentionsToIds('hi `Jack`', [jack], { use_display_names_humans: true, mention_format: '`{name}`' })).toBe('hi `Jack`')
  })

  it('leaves a name ending in a backslash as written, since it escapes the character after it', () => {
    const slash: MentionAuthor = { id: '333', username: 'slash_h4ndle', displayName: 'Jack\\', bot: false }
    const text = '@Jack\\` then `<@222222222222222222>`'
    expect(mentionsToIds(text, [slash], byDisplayName)).toBe(text)
  })

  it('reads a backtick escaped with a backslash as text, and a run after it as a span, as the splitter does', () => {
    expect(mentionsToIds('\\`a @Jack` @Jack', [jack], byDisplayName)).toBe('\\`a <@111>` @Jack')
    // An escaped backslash leaves the backtick after it to open a span.
    expect(mentionsToIds('\\\\`a @Jack` @Jack', [jack], byDisplayName)).toBe('\\\\`a @Jack` <@111>')
  })

  it('ends a code span only at a run of backticks as long as the one that opened it', () => {
    expect(mentionsToIds('``a ` @Jack` <@Jack> b`` @Jack', [jack], byDisplayName)).toBe('``a ` @Jack` <@Jack> b`` <@111>')
  })

  it('reads text that begins inside a code block carried open from an earlier message as code up to its closer', () => {
    const fence = [{ kind: 'fence' as const, opener: '```', closer: '```' }]
    expect(mentionsToIds('@Jack, in code\n```\nThanks @Jack', [jack], byDisplayName, fence)).toBe(
      '@Jack, in code\n```\nThanks <@111>',
    )
  })

  it('leaves a mention by id as written, even when someone is shown by that number', () => {
    const numbered: MentionAuthor = { id: '222222222222222222', username: 'num', displayName: '111111111111111111', bot: false }
    expect(mentionsToIds('<@111111111111111111> <@num>', [numbered], byDisplayName)).toBe(
      '<@111111111111111111> <@222222222222222222>',
    )
  })

  it('takes 17 to 20 digits as an id, and a shorter or longer number as a name', () => {
    const shownAs = (digits: number): MentionAuthor => ({
      id: '999999999999999999',
      username: `num${digits}`,
      displayName: '1'.repeat(digits),
      bot: false,
    })
    for (const n of [17, 20]) {
      expect(mentionsToIds(`<@${'1'.repeat(n)}>`, [shownAs(n)], byDisplayName)).toBe(`<@${'1'.repeat(n)}>`)
    }
    for (const n of [16, 21]) {
      expect(mentionsToIds(`<@${'1'.repeat(n)}>`, [shownAs(n)], byDisplayName)).toBe('<@999999999999999999>')
    }
  })

  it('leaves a display name two people share as written, and keeps <@Name> for it from pinging anyone', () => {
    const otherJack: MentionAuthor = { id: '444', username: 'jack2', displayName: 'Jack', bot: false }
    expect(mentionsToIds('@Jack?', [jack, otherJack], byDisplayName)).toBe('@Jack?')
    expect(mentionsToIds('<@Jack>?', [jack, otherJack], byDisplayName)).toBe('@Jack?')
    expect(mentionsToIds('@Jack?', [jack, jack], byDisplayName)).toBe('<@111>?')
  })

  it("doesn't read a longer name it leaves alone as a shorter name", () => {
    const otherSmith: MentionAuthor = { id: '888', username: 'smith2', displayName: 'Jack Smith', bot: false }
    expect(mentionsToIds('@Jack Smith', [jack, jackSmith, otherSmith], byDisplayName)).toBe('@Jack Smith')
    const jackBot: MentionAuthor = { id: '999', username: 'jackbot', displayName: 'Jack Bot', bot: true }
    expect(mentionsToIds('@Jack Bot', [jack, jackBot], byDisplayName)).toBe('@Jack Bot')
  })

  it('pings a bot in the conversation only through <@Name>, by its id, and leaves a name the conversation doesn\'t hold to the connector', () => {
    expect(mentionsToIds('@Helper <@Helper>', [otherBot], byDisplayName)).toBe('@Helper <@333>')
    // Its username too, though the context shows it by its display name, so
    // the connector's lookup, which prefers a person, doesn't get it.
    expect(mentionsToIds('<@helperbot>', [otherBot], byDisplayName)).toBe('<@333>')
    expect(mentionsToIds('<@helperbot>', [otherBot], { use_display_names_bots: false })).toBe('<@333>')
    expect(mentionsToIds('<@somebot>', [otherBot], byDisplayName)).toBe('<@somebot>')
  })

  it("reads <@name> in the form the context shows it, so a bot's username and a person's display name don't meet", () => {
    const botByUsername: MentionAuthor = { id: '161', username: 'chapter', displayName: 'Chapter X', bot: true }
    const person: MentionAuthor = { id: '171', username: 'c_h', displayName: 'Chapter', bot: false }
    const config = { use_display_names_humans: true, use_display_names_bots: false }
    expect(mentionsToIds('<@chapter> @Chapter', [botByUsername, person], config)).toBe('<@161> <@171>')
  })

  it('reads a person whose display name is their username as the context writes them, <@name>, beside anyone else shown that way', () => {
    const sam: MentionAuthor = { id: '221', username: 'sam', displayName: 'sam', bot: false }
    const samBot: MentionAuthor = { id: '231', username: 'sam', displayName: 'Sam Bot', bot: true }
    const config = { use_display_names_humans: true, use_display_names_bots: false }
    expect(mentionsToIds('<@sam>', [sam, samBot], config)).toBe('@sam')
    expect(mentionsToIds('<@sam> @sam', [sam], config)).toBe('<@221> <@221>')
  })

  it("doesn't ping a person for a name a bot also holds", () => {
    const helperPerson: MentionAuthor = { id: '123', username: 'helper_person', displayName: 'Helper', bot: false }
    expect(mentionsToIds('@Helper <@Helper>', [otherBot, helperPerson], byDisplayName)).toBe('@Helper @Helper')
  })

  it("under username labels, reads <@Name> as a person's username before a bot's display name, as main did", () => {
    const helperPerson: MentionAuthor = { id: '125', username: 'helper', displayName: 'Helper Person', bot: false }
    expect(mentionsToIds('<@Helper>', [otherBot, helperPerson], byUsername)).toBe('<@125>')
    // A bot whose display name is its username is written <@helper> too, so the two share that form.
    const helperBot: MentionAuthor = { id: '334', username: 'helper', displayName: 'helper', bot: true }
    expect(mentionsToIds('<@helper>', [helperBot, helperPerson], byUsername)).toBe('@helper')
  })

  it("doesn't mention a webhook, such as an Oblique persona, in either labelling", () => {
    const persona: MentionAuthor = { id: '600', username: 'Persona', displayName: 'Persona', bot: false, webhook: true }
    expect(mentionsToIds('@Persona <@Persona>', [persona], byDisplayName)).toBe('@Persona @Persona')
    expect(mentionsToIds('@Persona <@Persona>', [persona], byUsername)).toBe('@Persona @Persona')
  })

  it('leaves a name a persona and a person share as written, and keeps <@Name> for it from pinging anyone', () => {
    const sam: MentionAuthor = { id: '181', username: 'sam', displayName: 'Sam', bot: false }
    const persona: MentionAuthor = { id: '600', username: 'Sam', displayName: 'Sam', bot: false, webhook: true }
    expect(mentionsToIds('<@sam>', [sam, persona], byUsername)).toBe('@sam')
    expect(mentionsToIds('@Sam <@Sam>', [sam, persona], byDisplayName)).toBe('@Sam @Sam')
  })

  it("holds the bot's own name, config.name, for no one, so a person shown by it isn't pinged", () => {
    const claude: MentionAuthor = { id: '444', username: 'claude_fan', displayName: 'Claude', bot: false }
    const named = (config: object) => ({ name: 'Claude', ...config })
    expect(mentionsToIds('@Claude and <@Claude>', [claude], named(byDisplayName))).toBe('@Claude and @Claude')
    expect(mentionsToIds('<@Claude> <@claude_fan>', [claude], named(byUsername))).toBe('@Claude <@444>')
    // A person whose username is the bot's name, labelled by username as by default.
    const claudeUser: MentionAuthor = { id: '445', username: 'claude', displayName: 'Claude', bot: false }
    expect(mentionsToIds('<@claude>', [claudeUser], named(byUsername))).toBe('@claude')
    expect(mentionsToIds('[Claude]', [claude], named({ ...byDisplayName, mention_format: '[{name}]' }))).toBe('[Claude]')
    expect(mentionsToIds('<@Claude>', [claude], named({ ...byDisplayName, mention_format: '<@{name}>' }))).toBe('@Claude')
    // With no one else of that name, <@config.name> still isn't left to the connector's lookup.
    expect(mentionsToIds('<@Claude>', [jack], named(byDisplayName))).toBe('@Claude')
    // Without config.name, the person is pinged.
    expect(mentionsToIds('@Claude', [claude], byDisplayName)).toBe('<@444>')
  })

  it('never reads @everyone or @here as a name', () => {
    const here: MentionAuthor = { id: '121', username: 'here_person', displayName: 'here', bot: false }
    const everyone: MentionAuthor = { id: '131', username: 'everyone_person', displayName: 'Everyone', bot: false }
    expect(mentionsToIds('@here @everyone', [here, everyone], byDisplayName)).toBe('@here @everyone')
    const hereUsername: MentionAuthor = { id: '191', username: 'here', displayName: 'Here And Now', bot: false }
    expect(mentionsToIds('<@here>', [hereUsername], byUsername)).toBe('<@here>')
  })

  it("leaves the context's reply tag as written, and reads a <@Name> in one like any other", () => {
    expect(mentionsToIds('(replying to @Jack) sure, @Jack', [jack], byDisplayName)).toBe('(replying to @Jack) sure, <@111>')
    expect(mentionsToIds('(replying to [Jack]) ok', [jack], { ...byDisplayName, mention_format: '[{name}]' })).toBe('(replying to [Jack]) ok')
    expect(mentionsToIds('(replying to <@Jack>) ok, <@Jack>', [jack], { ...byDisplayName, mention_format: '<@{name}>' }))
      .toBe('(replying to <@111>) ok, <@111>')
  })

  it('reads a name starting with İ, whose lowercase the regex flags would not fold back', () => {
    const ilayda: MentionAuthor = { id: '221', username: 'ilayda_k', displayName: 'İlayda', bot: false }
    expect(mentionsToIds('@İlayda and <@İlayda>', [ilayda], byDisplayName)).toBe('<@221> and <@221>')
    // Its lowercase, as the model might write it: i and a combining dot.
    expect(mentionsToIds('@i\u0307layda', [ilayda], byDisplayName)).toBe('<@221>')
    // The same name in the <@Name> form the context writes under a <@{name}> template.
    expect(mentionsToIds('<@İlayda>', [ilayda], { ...byDisplayName, mention_format: '<@{name}>' })).toBe('<@221>')
  })

  it('ends a name before a combining mark, so a decomposed accent is part of a longer name', () => {
    const jose: MentionAuthor = { id: '201', username: 'jose', displayName: 'Jose', bot: false }
    expect(mentionsToIds('@Jose\u0301 and @Jose', [jose], byDisplayName)).toBe('@Jose\u0301 and <@201>')
  })

  it('reads the mention_format the context writes names in', () => {
    expect(mentionsToIds('[Jack] hi, and <@Jack>', [jack], { ...byDisplayName, mention_format: '[{name}]' })).toBe('<@111> hi, and <@111>')
    expect(mentionsToIds('x[Jack]', [jack], { ...byDisplayName, mention_format: '[{name}]' })).toBe('x[Jack]')
    expect(mentionsToIds('<@Jack> @Jack', [jack], { ...byDisplayName, mention_format: '<@{name}>' })).toBe('<@111> @Jack')
    expect(mentionsToIds('Jack, <@Jack>', [jack], { ...byDisplayName, mention_format: '{name}' })).toBe('Jack, <@111>')
  })

  it('reads an empty mention_format as unset, as the context does', () => {
    expect(mentionsToIds('@Jack', [jack], { ...byDisplayName, mention_format: '' })).toBe('<@111>')
  })

  it('reads the mention_format for people labelled by username too, since the context writes every name in it', () => {
    expect(mentionsToIds('[jack_h4ndle] hi', [jack], { mention_format: '[{name}]' })).toBe('<@111> hi')
  })

  it("doesn't read a markdown link as a templated name", () => {
    const support: MentionAuthor = { id: '211', username: 'support_team', displayName: 'Support', bot: false }
    const config = { ...byDisplayName, mention_format: '[{name}]' }
    expect(mentionsToIds('[Support](https://example.com)', [support], config)).toBe('[Support](https://example.com)')
    expect(mentionsToIds('see [Support](https://example.com)', [support], config)).toBe('see [Support](https://example.com)')
    // Discord renders no reference links, so [Support][1] is a mention and a footnote mark.
    expect(mentionsToIds('[Support][1]', [support], config)).toBe('<@211>[1]')
    expect(mentionsToIds('[Support] can you look?', [support], config)).toBe('<@211> can you look?')
  })

  it("reads a name in a markdown link's text in the default form, and leaves the link whole", () => {
    expect(mentionsToIds('[@Jack](https://example.com) and [ask @Jack](https://example.com)', [jack], byDisplayName))
      .toBe('[<@111>](https://example.com) and [ask <@111>](https://example.com)')
    expect(mentionsToIds('[docs](https://medium.com/@Jack)', [jack], byDisplayName)).toBe('[docs](https://medium.com/@Jack)')
  })

  it('reads no mention_format with nothing before {name}, since a speaker label looks the same', () => {
    expect(mentionsToIds('Jack: I agree', [jack], { ...byDisplayName, mention_format: '{name}:' })).toBe('Jack: I agree')
    expect(mentionsToIds('<@Jack>', [jack], { ...byDisplayName, mention_format: '{name}:' })).toBe('<@111>')
  })

  it('reads a name holding regular-expression characters as written', () => {
    const sad: MentionAuthor = { id: '141', username: 'sad', displayName: 'Jack :(', bot: false }
    const dotted: MentionAuthor = { id: '151', username: 'dotted', displayName: 'a.b', bot: false }
    expect(mentionsToIds('@Jack :( hi', [sad], byDisplayName)).toBe('<@141> hi')
    expect(mentionsToIds('@aXb @a.b', [dotted], byDisplayName)).toBe('@aXb <@151>')
  })
})
