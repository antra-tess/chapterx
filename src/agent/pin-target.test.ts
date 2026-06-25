import { describe, it, expect } from 'vitest'
import { pinAddressesBot, type BotIdentity, type PinTarget } from './pin-target.js'

const ID: BotIdentity = {
  botId: 'glm52',
  configName: 'GLM-5.2',
  discordUsername: 'glm5.2',
  discordGlobalName: 'GLM 5.2',
  discordUserId: '100200300',  // account user id OR portal persona id
}

const t = (targetText?: string, extra: Partial<PinTarget> = {}): PinTarget => ({ targetText, ...extra })

describe('pinAddressesBot — bare command', () => {
  it('applies to every bot when there is no target and no mentions', () => {
    expect(pinAddressesBot(t(undefined), ID)).toBe(true)
    expect(pinAddressesBot(t('   '), ID)).toBe(true)
  })
})

describe('pinAddressesBot — text identity match', () => {
  it('matches each identity form (case-insensitive)', () => {
    expect(pinAddressesBot(t('glm52'), ID)).toBe(true)        // botId
    expect(pinAddressesBot(t('glm-5.2'), ID)).toBe(true)      // configName, lc
    expect(pinAddressesBot(t('glm5.2'), ID)).toBe(true)       // username
    expect(pinAddressesBot(t('GLM 5.2'), ID)).toBe(true)      // global name (spaces)
    expect(pinAddressesBot(t('<@100200300>'), ID)).toBe(true) // user id mention
    expect(pinAddressesBot(t('<@!100200300>'), ID)).toBe(true)
    expect(pinAddressesBot(t('@glm5.2'), ID)).toBe(true)      // bare @username
  })
  it('does not match an unrelated target', () => {
    expect(pinAddressesBot(t('haiku45'), ID)).toBe(false)
    expect(pinAddressesBot(t('<@999>'), ID)).toBe(false)
  })
})

describe('pinAddressesBot — portal persona mention', () => {
  it('matches when our persona id is in the resolved persona mentions', () => {
    // target text is the role mention, which text-matching cannot resolve…
    expect(pinAddressesBot(t('<@&555>', { mentionedPersonaIds: ['100200300'] }), ID)).toBe(true)
  })
  it('does not match when a different persona was addressed', () => {
    expect(pinAddressesBot(t('<@&555>', { mentionedPersonaIds: ['999'] }), ID)).toBe(false)
  })
})

describe('pinAddressesBot — account role mention', () => {
  it('matches when a mentioned role is one of the bot’s own roles', () => {
    expect(pinAddressesBot(t('<@&555>', { mentionedRoleIds: ['555'] }), ID, ['555', '777'])).toBe(true)
  })
  it('does not match when the mentioned role is not ours', () => {
    expect(pinAddressesBot(t('<@&555>', { mentionedRoleIds: ['555'] }), ID, ['777'])).toBe(false)
  })
  it('ignores role mentions when the bot has no own roles passed (portal)', () => {
    expect(pinAddressesBot(t('<@&555>', { mentionedRoleIds: ['555'] }), ID)).toBe(false)
  })
  it('supports multi-target role mentions (text has spaces, role match still works)', () => {
    const pin = t('<@&111> <@&555>', { mentionedRoleIds: ['111', '555'] })
    expect(pinAddressesBot(pin, ID, ['555'])).toBe(true)
  })
})

describe('pinAddressesBot — no false positives', () => {
  it('returns false when a target/mention is present but nothing matches', () => {
    expect(pinAddressesBot(t('<@&555>', { mentionedRoleIds: ['555'], mentionedPersonaIds: ['999'] }), ID, ['888'])).toBe(false)
  })
})
