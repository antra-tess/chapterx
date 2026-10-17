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

vi.mock('@animalabs/portal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@animalabs/portal-client')>()),
  loadOrEnrollCreds: vi.fn(async () => ({ personaId: 'new-persona', token: 'new-token' })),
}))

import { loadOrEnrollCreds } from '@animalabs/portal-client'
import { resolveConnectorSettings, portalCredentials, type ConnectorInputs } from './bootstrap.js'
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

  it('refuses a config value that is not a string', () => {
    expect(() => resolveConnectorSettings(inputs({ botConfig: { connector_backend: true } }))).toThrow(
      'connector_backend in the bot config must be a string',
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

  it('takes a number in the bot config as the string it was written as', () => {
    // An invite code of digits, unquoted in YAML, reads as a number.
    expect(portal({ botConfig: { portal_invite: 123456 } })).toMatchObject({ credentials: { invite: '123456' } })
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

  it('names what enrolling a new persona is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
    const credsPath = join(dir, 'portal-creds.json')

    await expect(portalCredentials('wss://relay', { from: 'file', credsPath, invite: 'inv' })).rejects.toThrow(
      `No saved portal credentials at ${credsPath}, and enrolling a new persona needs a name (PORTAL_DESIRED_NAME, portal_desired_name or BOT_NAME)`,
    )
    await expect(portalCredentials('wss://relay', { from: 'file', credsPath })).rejects.toThrow(
      'needs an invite (PORTAL_INVITE or portal_invite) and a name (PORTAL_DESIRED_NAME, portal_desired_name or BOT_NAME)',
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
