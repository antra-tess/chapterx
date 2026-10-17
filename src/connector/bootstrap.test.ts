/**
 * The connector's startup settings (resolveConnectorSettings) and the portal
 * persona's credentials (portalCredentials).
 *
 * WHAT THESE PROTECT: a setting that's wrong or half-given stops the start with
 * an error naming it, rather than quietly connecting a bot to the wrong backend
 * or as a new persona; the credentials default to a place that survives a
 * redeploy; and a newly enrolled persona is logged as one.
 *
 * Run with: npm test -- bootstrap
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as YAML from 'yaml'

vi.mock('@animalabs/portal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@animalabs/portal-client')>()),
  loadOrEnrollCreds: vi.fn(async () => ({ personaId: 'new-persona', token: 'new-token' })),
}))

import { loadOrEnrollCreds } from '@animalabs/portal-client'
import { resolveConnectorSettings, portalCredentials, startConnectorThenTimers, type ConnectorInputs } from './bootstrap.js'
import { logger } from '../utils/logger.js'

const inputs = (over: Partial<ConnectorInputs> = {}): ConnectorInputs => ({
  env: {},
  botConfig: {},
  botName: 'glm52',
  configPath: '/srv/config',
  ...over,
})

describe('resolveConnectorSettings: the backend', () => {
  it('is discord by default', () => {
    expect(resolveConnectorSettings(inputs())).toEqual({ backend: 'discord', backendFrom: 'the default' })
  })

  it('comes from the bot config, and the environment overrides it', () => {
    const fromConfig = resolveConnectorSettings(inputs({ botConfig: { connector_backend: 'portal', portal_url: 'wss://relay' } }))
    expect(fromConfig).toMatchObject({ backend: 'portal', backendFrom: 'connector_backend in the bot config' })

    const overridden = resolveConnectorSettings(
      inputs({ env: { CONNECTOR_BACKEND: 'discord' }, botConfig: { connector_backend: 'portal' } }),
    )
    expect(overridden).toEqual({ backend: 'discord', backendFrom: 'CONNECTOR_BACKEND' })
  })

  it('refuses a value that is neither discord nor portal, naming where it came from', () => {
    expect(() => resolveConnectorSettings(inputs({ botConfig: { connector_backend: 'Portal' } }))).toThrow(
      'connector_backend in the bot config is "Portal", and it must be "discord" or "portal"',
    )
    expect(() => resolveConnectorSettings(inputs({ env: { CONNECTOR_BACKEND: 'portl' } }))).toThrow(/^CONNECTOR_BACKEND is "portl"/)
  })

  it('refuses a config value that is not text, saying to quote it', () => {
    expect(() => resolveConnectorSettings(inputs({ botConfig: { connector_backend: true } }))).toThrow(
      'connector_backend in the bot config must be text, and YAML read it as true. Write it in quotes, as connector_backend: "…", so it\'s kept as written.',
    )
  })
})

describe('resolveConnectorSettings: the portal backend', () => {
  const portal = (over: Partial<ConnectorInputs> = {}) =>
    resolveConnectorSettings(inputs({ ...over, env: { CONNECTOR_BACKEND: 'portal', PORTAL_URL: 'wss://relay', ...over.env } }))

  it('needs the relay URL, and says where it can be set', () => {
    expect(() => resolveConnectorSettings(inputs({ env: { CONNECTOR_BACKEND: 'portal' } }))).toThrow(
      "The portal backend needs the relay URL: set PORTAL_URL, or portal_url in the bot's config file, which is read when BOT_NAME is set",
    )
  })

  it('refuses an unquoted invite code YAML read as a number, since its text as written is gone', () => {
    // `portal_invite: 0482913` in the file: YAML's core schema reads it as 482913.
    const botConfig = YAML.parse('portal_invite: 0482913\n')
    expect(() => portal({ botConfig })).toThrow(
      'portal_invite in the bot config must be text, and YAML read it as 482913. Write it in quotes, as portal_invite: "…", so it\'s kept as written.',
    )
  })

  it('takes a persona\'s credentials from PORTAL_PERSONA and PORTAL_TOKEN together', () => {
    expect(portal({ env: { PORTAL_PERSONA: 'p1', PORTAL_TOKEN: 't1' } })).toEqual({
      backend: 'portal',
      backendFrom: 'CONNECTOR_BACKEND',
      url: 'wss://relay',
      credentials: { from: 'env', personaId: 'p1', token: 't1' },
    })
  })

  it('refuses one of PORTAL_PERSONA and PORTAL_TOKEN without the other', () => {
    expect(() => portal({ env: { PORTAL_PERSONA: 'p1' } })).toThrow(/^PORTAL_PERSONA is set and PORTAL_TOKEN isn't/)
    expect(() => portal({ env: { PORTAL_TOKEN: 't1' } })).toThrow(/^PORTAL_TOKEN is set and PORTAL_PERSONA isn't/)
  })

  it('saves credentials in the bot\'s EMS directory in the EMS layout', () => {
    // main() sets configPath to EMS_PATH in that layout; different here, to show which one is read.
    const s = portal({ emsPath: '/srv/ems', configPath: '/srv/elsewhere' })
    expect(s).toMatchObject({ credentials: { from: 'file', credsPath: '/srv/ems/glm52/portal-creds.json' } })
  })

  it('saves credentials beside the bot\'s config file otherwise, not in the cache directory', () => {
    expect(portal()).toMatchObject({ credentials: { credsPath: '/srv/config/bots/glm52.portal-creds.json' } })
  })

  it('saves credentials in the config directory when there is no BOT_NAME', () => {
    expect(portal({ botName: undefined })).toMatchObject({ credentials: { credsPath: '/srv/config/portal-creds.json', desiredName: undefined } })
  })

  it('takes the credentials path, invite and name from the bot config, with the environment overriding', () => {
    const botConfig = {
      portal_creds_path: '/keep/creds.json',
      portal_invite: 'inv-config',
      portal_desired_name: 'GLM 5.2',
    }
    expect(portal({ botConfig })).toMatchObject({
      credentials: { from: 'file', credsPath: '/keep/creds.json', invite: 'inv-config', desiredName: 'GLM 5.2' },
    })
    expect(portal({ botConfig, env: { PORTAL_INVITE: 'inv-env', PORTAL_DESIRED_NAME: 'glm' } })).toMatchObject({
      credentials: { invite: 'inv-env', desiredName: 'glm' },
    })
  })

  it('names the persona after BOT_NAME when nothing else does', () => {
    expect(portal()).toMatchObject({ credentials: { desiredName: 'glm52', invite: undefined } })
  })
})

describe('portalCredentials', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    vi.restoreAllMocks()
    vi.mocked(loadOrEnrollCreds).mockClear()
  })

  it('returns the environment\'s credentials without touching a file', async () => {
    expect(await portalCredentials('wss://relay', { from: 'env', personaId: 'p1', token: 't1' })).toEqual({ personaId: 'p1', token: 't1' })
    expect(loadOrEnrollCreds).not.toHaveBeenCalled()
  })

  it('loads saved credentials, and says so', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
    const credsPath = join(dir, 'portal-creds.json')
    writeFileSync(credsPath, JSON.stringify({ personaId: 'saved', token: 'saved-token' }))
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)

    expect(await portalCredentials('wss://relay', { from: 'file', credsPath, invite: 'inv' })).toEqual({ personaId: 'saved', token: 'saved-token' })
    expect(loadOrEnrollCreds).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ personaId: 'saved' }), 'Loaded the saved portal persona credentials')
  })

  it('names the file when the saved credentials can\'t be read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
    const credsPath = join(dir, 'portal-creds.json')
    writeFileSync(credsPath, '{ "personaId": "p1", "tok')

    await expect(portalCredentials('wss://relay', { from: 'file', credsPath, invite: 'inv', desiredName: 'glm52' })).rejects.toThrow(
      `The saved portal credentials at ${credsPath} can't be read`,
    )
    expect(loadOrEnrollCreds).not.toHaveBeenCalled()
  })

  it('names what enrolling a new persona is missing, and when the bot\'s config file is read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
    const credsPath = join(dir, 'portal-creds.json')

    await expect(portalCredentials('wss://relay', { from: 'file', credsPath, invite: 'inv' })).rejects.toThrow(
      `No saved portal credentials at ${credsPath}, and enrolling a new persona needs a name (PORTAL_DESIRED_NAME, portal_desired_name in the bot's config file, or BOT_NAME). The bot's config file is read when BOT_NAME is set.`,
    )
    await expect(portalCredentials('wss://relay', { from: 'file', credsPath })).rejects.toThrow(
      "needs an invite (PORTAL_INVITE, or portal_invite in the bot's config file) and a name (PORTAL_DESIRED_NAME, portal_desired_name in the bot's config file, or BOT_NAME).",
    )
    expect(loadOrEnrollCreds).not.toHaveBeenCalled()
  })

  it('won\'t enroll over a credentials file that has no persona id and token', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
    const credsPath = join(dir, 'portal-creds.json')
    writeFileSync(credsPath, '{ "personaId": "p1" }')

    await expect(portalCredentials('wss://relay', { from: 'file', credsPath, invite: 'inv', desiredName: 'glm52' })).rejects.toThrow(
      `The saved portal credentials at ${credsPath} have no persona id and token. Fix the file, or remove it to enroll a new persona.`,
    )
    expect(loadOrEnrollCreds).not.toHaveBeenCalled()
  })

  it('enrolls a new persona when none are saved, and says so', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
    const credsPath = join(dir, 'portal-creds.json')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)

    const creds = await portalCredentials('wss://relay', { from: 'file', credsPath, invite: 'inv', desiredName: 'glm52' })

    expect(creds).toEqual({ personaId: 'new-persona', token: 'new-token' })
    expect(loadOrEnrollCreds).toHaveBeenCalledWith({ url: 'wss://relay', credsPath, invite: 'inv', desiredName: 'glm52' })
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ personaId: 'new-persona' }), 'Enrolled a new portal persona and saved its credentials')
  })
})

describe('startConnectorThenTimers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('starts the timers once the connector has started, and queues a missed timer\'s event through the connector', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    const order: string[] = []
    const missed = { type: 'self_activation', channelId: 'chan', guildId: 'g', timestamp: new Date(), data: { timerId: 't1' } }
    const connector = {
      // The connector has started once its start resolves, after a connection.
      start: vi.fn(() => new Promise<void>((resolve) => setTimeout(() => { order.push('connector started'); resolve() }, 0))),
      enqueue: vi.fn((event: { data: { timerId: string } }) => { order.push(`queued ${event.data.timerId}`) }),
    }
    // A timer that came due while the bot was down fires as the scheduler starts.
    const timers = {
      initialize: vi.fn(async (onTimerFire: (event: any) => void) => {
        order.push('timers started')
        onTimerFire(missed)
      }),
    }

    await startConnectorThenTimers(connector as never, timers)

    expect(order).toEqual(['connector started', 'timers started', 'queued t1'])
    expect(connector.enqueue).toHaveBeenCalledWith(missed)
  })
})
