/**
 * Which connector a bot starts with, and what that connector needs, from the
 * environment and the bot's own config file.
 *
 * Each setting can come from an environment variable or from a key of the bot's
 * config file, and the environment wins:
 *
 *   CONNECTOR_BACKEND    connector_backend    `discord` (the default) or `portal`
 *   PORTAL_URL           portal_url           the portal relay's WebSocket URL
 *   PORTAL_CREDS_PATH    portal_creds_path    where the persona's credentials are saved
 *   PORTAL_DESIRED_NAME  portal_desired_name  the persona's name when it enrolls (default: BOT_NAME)
 *   PORTAL_INVITE        portal_invite        the invite to enroll with, used when no credentials are saved
 *
 * PORTAL_PERSONA and PORTAL_TOKEN, environment only, give a persona's
 * credentials directly; they're set together or not at all.
 *
 * Without BOT_NAME the bot's config file isn't known before the connector
 * starts, so only the environment applies.
 */

import { join } from 'path'
import { fileCredsStore, loadOrEnrollCreds } from '@animalabs/portal-client'
import { logger } from '../utils/logger.js'

/** The connector keys of the bot's config file. Typed unknown because they come
 *  from YAML as written; resolveConnectorSettings checks them. */
export interface ConnectorConfigKeys {
  connector_backend?: unknown
  portal_url?: unknown
  portal_creds_path?: unknown
  portal_desired_name?: unknown
  portal_invite?: unknown
}

export interface ConnectorInputs {
  env: Record<string, string | undefined>
  /** The bot's own config file, as ConfigSystem reads it: {} when there's none. */
  botConfig: ConnectorConfigKeys
  /** BOT_NAME, when it's set. */
  botName?: string
  /** EMS_PATH, when it's set. */
  emsPath?: string
  /** The config directory main() uses (EMS_PATH in the EMS layout). */
  configPath: string
}

export type PortalCredentialsSource =
  | { from: 'env'; personaId: string; token: string }
  | { from: 'file'; credsPath: string; invite?: string; desiredName?: string }

export type ConnectorSettings =
  | { backend: 'discord'; backendFrom: string }
  | { backend: 'portal'; backendFrom: string; url: string; credentials: PortalCredentialsSource }

/** A setting's value and where it came from, or undefined when it isn't set. */
function setting(
  inputs: ConnectorInputs,
  envName: string,
  key: keyof ConnectorConfigKeys,
): { value: string; from: string } | undefined {
  const fromEnv = inputs.env[envName]
  if (fromEnv) return { value: fromEnv, from: envName }
  const fromConfig = inputs.botConfig[key]
  if (fromConfig === undefined || fromConfig === null || fromConfig === '') return undefined
  if (typeof fromConfig !== 'string') {
    throw new Error(`${key} in the bot config must be a string, and it's ${JSON.stringify(fromConfig)}`)
  }
  return { value: fromConfig, from: `${key} in the bot config` }
}

/**
 * Where the persona's credentials are saved when nothing says: with the bot's
 * configuration, which a deployment keeps across redeploys, rather than in the
 * cache directory. In the EMS layout that's the bot's directory; otherwise it's
 * beside the bot's config file. Without BOT_NAME there's no bot config file to
 * sit beside, so it's the config directory.
 */
function defaultCredsPath(inputs: ConnectorInputs): string {
  const { botName, emsPath, configPath } = inputs
  if (!botName) return join(configPath, 'portal-creds.json')
  return emsPath ? join(emsPath, botName, 'portal-creds.json') : join(configPath, 'bots', `${botName}.portal-creds.json`)
}

/** Decide the connector and its settings. Throws, naming the setting, when one is
 *  invalid or a portal setting the backend needs is missing. */
export function resolveConnectorSettings(inputs: ConnectorInputs): ConnectorSettings {
  const backend = setting(inputs, 'CONNECTOR_BACKEND', 'connector_backend')
  if (backend && backend.value !== 'discord' && backend.value !== 'portal') {
    throw new Error(`${backend.from} is "${backend.value}", and it must be "discord" or "portal"`)
  }
  const backendFrom = backend?.from ?? 'the default'
  if (backend?.value !== 'portal') return { backend: 'discord', backendFrom }

  const url = setting(inputs, 'PORTAL_URL', 'portal_url')
  if (!url) throw new Error('The portal backend needs the relay URL: set portal_url in the bot config, or PORTAL_URL')

  const personaId = inputs.env.PORTAL_PERSONA
  const token = inputs.env.PORTAL_TOKEN
  if (personaId && token) {
    return { backend: 'portal', backendFrom, url: url.value, credentials: { from: 'env', personaId, token } }
  }
  if (personaId || token) {
    const [set, unset] = personaId ? ['PORTAL_PERSONA', 'PORTAL_TOKEN'] : ['PORTAL_TOKEN', 'PORTAL_PERSONA']
    throw new Error(
      `${set} is set and ${unset} isn't: set both to give the persona's credentials, or neither to use the saved credentials`,
    )
  }

  return {
    backend: 'portal',
    backendFrom,
    url: url.value,
    credentials: {
      from: 'file',
      credsPath: setting(inputs, 'PORTAL_CREDS_PATH', 'portal_creds_path')?.value ?? defaultCredsPath(inputs),
      invite: setting(inputs, 'PORTAL_INVITE', 'portal_invite')?.value,
      desiredName: setting(inputs, 'PORTAL_DESIRED_NAME', 'portal_desired_name')?.value ?? inputs.botName,
    },
  }
}

/**
 * The persona's credentials: from the environment, or the saved ones, or, when
 * none are saved, a new persona enrolled with the invite and saved for every
 * later start. A new persona is logged as one, since a lost credentials file
 * mints a new persona under the same invite.
 */
export async function portalCredentials(url: string, source: PortalCredentialsSource): Promise<{ personaId: string; token: string }> {
  if (source.from === 'env') return { personaId: source.personaId, token: source.token }

  const saved = await fileCredsStore(source.credsPath).load()
  if (saved) {
    logger.info({ credsPath: source.credsPath, personaId: saved.personaId }, 'Loaded the saved portal persona credentials')
    return saved
  }
  const creds = await loadOrEnrollCreds({
    url,
    credsPath: source.credsPath,
    invite: source.invite,
    desiredName: source.desiredName,
  })
  logger.info(
    { credsPath: source.credsPath, personaId: creds.personaId, desiredName: source.desiredName },
    'Enrolled a new portal persona and saved its credentials',
  )
  return creds
}
