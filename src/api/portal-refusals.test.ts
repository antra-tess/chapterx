/**
 * The API routes that read discord.js's own client, on the portal backend.
 *
 * WHAT THESE PROTECT: a portal bot has no discord.js client. These routes must
 * say so with 501 rather than fail on a property the portal client doesn't have.
 * (PortalConnector's private PortalClient is also named `client`, so a check of
 * `connector.client` never refused.)
 */

import { describe, it, expect, afterEach } from 'vitest'
import { ApiServer } from './server.js'

let server: ApiServer | undefined
afterEach(async () => { await server?.stop(); server = undefined })

async function startOnPortal() {
  const connector = { isPortal: () => true, client: { on: () => undefined } }
  server = new ApiServer({ port: 0, bearerToken: 'secret' }, connector as any)
  await server.start()
  const port = (server as any).server.address().port as number
  return (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: 'Bearer secret' } })
}

describe('API routes that need the Discord backend, on the portal backend', () => {
  it.each([
    ['/api/channels', 'Channel listing'],
    ['/api/users/123456789012345678', 'User lookup'],
    ['/api/users/123456789012345678/avatar', 'Avatar lookup'],
  ])('%s answers 501 and says why', async (path, what) => {
    const get = await startOnPortal()
    const res = await get(path)
    expect(res.status).toBe(501)
    expect((await res.json()).message).toContain(what)
  })
})
