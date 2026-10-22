/**
 * include_voice_messages is off unless a config sets it to true.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConfigSystem } from './system.js'

const dirs: string[] = []
beforeEach(() => {
  // The bot layout below is the one ConfigSystem reads when EMS_PATH is unset
  vi.stubEnv('EMS_PATH', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The merged config of a bot whose own file adds `extra`, with no pinned config. */
function load(extra: string): ReturnType<ConfigSystem['loadConfig']> {
  const dir = mkdtempSync(join(tmpdir(), 'chapterx-config-voice-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'bots'))
  writeFileSync(join(dir, 'bots', 'test.yaml'), `name: Test\ncontinuation_model: test-model\n${extra}`)
  return new ConfigSystem(dir).loadConfig({ botName: 'test', guildId: 'guild', channelConfigs: [] })
}

describe('include_voice_messages', () => {
  it('is off when no config sets it', () => {
    expect(load('').include_voice_messages).toBe(false)
  })

  it('is on when a config sets it to true', () => {
    expect(load('include_voice_messages: true\n').include_voice_messages).toBe(true)
  })

  it('stays off for a value other than true, such as the string "yes"', () => {
    expect(load('include_voice_messages: "yes"\n').include_voice_messages).toBe(false)
  })
})
