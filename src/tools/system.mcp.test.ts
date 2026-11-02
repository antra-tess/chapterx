import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolSystem } from './system.js'
import type { ToolCall } from '../types.js'

const fixtureServer = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, input, messageId: 'm1', timestamp: new Date(), originalCompletionText: '' }
}

describe('ToolSystem with a stdio MCP server', () => {
  const opened: Array<{ system: ToolSystem; directory: string }> = []

  afterEach(async () => {
    for (const { system, directory } of opened.splice(0)) {
      await system.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  async function connect(): Promise<ToolSystem> {
    const directory = mkdtempSync(join(tmpdir(), 'chapterx-mcp-'))
    const system = new ToolSystem(directory)
    opened.push({ system, directory })
    await system.initializeServers([{ name: 'fixture', command: process.execPath, args: [fixtureServer] }])
    return system
  }

  it('lists the server\'s tools, with their input schemas, and its resources', async () => {
    const system = await connect()
    const echo = system.getAvailableTools().find((tool) => tool.name === 'echo')
    expect(echo).toMatchObject({ serverName: 'fixture', description: 'Echoes its text, with a one-pixel image' })
    expect(echo?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
    expect(system.getToolNames()).toEqual(expect.arrayContaining(['echo', 'fail']))
    expect(system.getMcpResources()).toEqual([
      expect.objectContaining({ server: 'fixture', uri: 'fixture://notes', name: 'notes', description: 'A short text resource' }),
    ])
  })

  it('returns a call\'s text as its output and its images beside it', async () => {
    const system = await connect()
    const result = await system.executeTool(call('echo', { text: 'hi' }))
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('echo: hi')
    expect(result.images).toEqual([{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
  })

  it('returns what a failing tool says, and the server still answers the next call', async () => {
    const system = await connect()
    const failed = await system.executeTool(call('fail', {}))
    expect(JSON.stringify(failed)).toContain('the fixture tool failed')
    const after = await system.executeTool(call('echo', { text: 'again' }))
    expect(after.output).toBe('echo: again')
  })

  it('reads a listed resource', async () => {
    const system = await connect()
    expect(await system.readMcpResource('fixture://notes')).toMatchObject({ content: 'the fixture notes' })
  })
})
