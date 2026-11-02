import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SteeringStore } from './store.js'
import type { ChannelSteering } from './types.js'

const config: ChannelSteering = {
  interventions: [{ type: 'steer', probe: 'emotion', probe_index: 2, strength: 1.5, label: 'cheerful' }],
  readout_probes: ['emotion'],
  updated_at: '2026-11-02T00:00:00.000Z',
  set_by: 'user-1',
  model: 'model-a',
}

describe('SteeringStore on disk', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function directory(): string {
    const made = mkdtempSync(join(tmpdir(), 'chapterx-steering-'))
    directories.push(made)
    return made
  }

  it('loads a config another store saved', () => {
    const dir = directory()
    new SteeringStore(dir).set('bot-1', 'channel-1', config)
    expect(new SteeringStore(dir).get('bot-1', 'channel-1')).toEqual(config)
  })

  it('skips a saved file that doesn\'t match the config\'s shape, and loads the rest', () => {
    const dir = directory()
    mkdirSync(join(dir, 'channel-1'))
    writeFileSync(join(dir, 'channel-1', 'bot-1.json'), JSON.stringify({ ...config, interventions: [{ ...config.interventions[0], probe_index: -1 }] }))
    writeFileSync(join(dir, 'channel-1', 'bot-2.json'), JSON.stringify(config))
    const store = new SteeringStore(dir)
    expect(store.has('bot-1', 'channel-1')).toBe(false)
    expect(store.get('bot-2', 'channel-1')).toEqual(config)
  })
})
