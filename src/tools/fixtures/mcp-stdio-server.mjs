import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture', version: '1.0.0' })

server.registerTool(
  'echo',
  { description: 'Echoes its text, with a one-pixel image', inputSchema: { text: z.string() } },
  async ({ text }) => ({
    content: [
      { type: 'text', text: `echo: ${text}` },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ],
  }),
)

server.registerTool(
  'fail',
  { description: 'Always throws', inputSchema: {} },
  async () => {
    throw new Error('the fixture tool failed')
  },
)

server.registerResource(
  'notes',
  'fixture://notes',
  { description: 'A short text resource', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'the fixture notes' }] }),
)

await server.connect(new StdioServerTransport())
