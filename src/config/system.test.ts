/**
 * ConfigSystem's read of a bot's own config file, which main() takes the
 * connector's settings from and warns about by path when BOT_NAME names a file
 * that isn't there.
 *
 * WHAT THESE PROTECT: botConfigPath names the file loadBotConfig reads, in each
 * layout, so the warning points at the file the settings would have come from.
 *
 * Run with: npm test -- config/system
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConfigSystem } from './system.js'

let dir: string | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('ConfigSystem: the bot\'s own config file', () => {
  it('reads the file botConfigPath names, in the default layout', () => {
    vi.stubEnv('EMS_PATH', '')
    dir = mkdtempSync(join(tmpdir(), 'config-system-test-'))
    mkdirSync(join(dir, 'bots'))
    writeFileSync(join(dir, 'bots', 'glm52.yaml'), 'portal_url: wss://relay\n')
    const config = new ConfigSystem(dir)

    expect(config.botConfigPath('glm52')).toBe(join(dir, 'bots', 'glm52.yaml'))
    expect(config.loadBotConfig('glm52')).toEqual({ portal_url: 'wss://relay' })
  })

  it('reads the file botConfigPath names, in the EMS layout', () => {
    dir = mkdtempSync(join(tmpdir(), 'config-system-test-'))
    vi.stubEnv('EMS_PATH', dir)
    mkdirSync(join(dir, 'glm52'))
    writeFileSync(join(dir, 'glm52', 'config.yaml'), 'portal_url: wss://relay\n')
    const config = new ConfigSystem(dir)

    expect(config.botConfigPath('glm52')).toBe(join(dir, 'glm52', 'config.yaml'))
    expect(config.loadBotConfig('glm52')).toEqual({ portal_url: 'wss://relay' })
  })

  it('reads a missing file as empty', () => {
    vi.stubEnv('EMS_PATH', '')
    dir = mkdtempSync(join(tmpdir(), 'config-system-test-'))

    expect(new ConfigSystem(dir).loadBotConfig('nobody')).toEqual({})
  })
})
