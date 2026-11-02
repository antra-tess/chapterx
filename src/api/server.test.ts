import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'net'
import { ApiServer } from './server.js'
import type { DiscordConnector } from '../discord/connector.js'

const token = 'test-token'

const user = {
  id: 'u1',
  username: 'alice',
  discriminator: '0',
  bot: false,
  displayAvatarURL: () => 'https://cdn.example/avatar.png',
}

const connector = {
  client: {
    users: { fetch: async (id: string) => (id === user.id ? user : Promise.reject(Object.assign(new Error('Unknown User'), { code: 10013 }))) },
    guilds: {
      fetch: async (guildId: string) => {
        if (guildId !== 'g1') throw Object.assign(new Error('Unknown Guild'), { code: 10004 })
        return {
          members: {
            fetch: async (userId: string) => {
              if (userId !== 'u1') throw Object.assign(new Error('Unknown Member'), { code: 10007 })
              return { displayName: 'Alice in g1', roles: { cache: [{ name: '@everyone' }, { name: 'mod' }] } }
            },
          },
        }
      },
    },
  },
} as unknown as DiscordConnector

describe('ApiServer over HTTP', () => {
  const started: ApiServer[] = []

  afterEach(async () => {
    for (const server of started.splice(0)) await server.stop()
  })

  async function start(): Promise<string> {
    const server = new ApiServer({ port: 0, bearerToken: token }, connector)
    started.push(server)
    await server.start()
    const { port } = ((server as unknown as { server: { address(): AddressInfo } }).server).address()
    return `http://127.0.0.1:${port}`
  }

  const auth = { authorization: `Bearer ${token}` }

  it('answers /health without a token', async () => {
    const base = await start()
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it('refuses a request with no token, and one with the wrong token', async () => {
    const base = await start()
    expect((await fetch(`${base}/api/users/u1`)).status).toBe(401)
    expect((await fetch(`${base}/api/users/u1`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(403)
  })

  it('reads a JSON body: an export request names its last message, and that URL is checked', async () => {
    const base = await start()
    const exportRequest = (body: unknown) => fetch(`${base}/api/messages/export`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const missing = await exportRequest({ first: 'x' })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ message: 'Missing required parameter: last' })
    const notDiscord = await exportRequest({ last: 'https://example.com/not-a-message' })
    expect(notDiscord.status).toBe(400)
    expect(await notDiscord.json()).toMatchObject({ message: 'Invalid Discord message URL format' })
  })

  it('takes the user from the path and the guild from the query', async () => {
    const base = await start()
    const response = await fetch(`${base}/api/users/u1?guildId=g1`, { headers: auth })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: 'u1',
      username: 'alice',
      displayName: 'Alice in g1',
      discriminator: '0',
      bot: false,
      avatarUrl: 'https://cdn.example/avatar.png',
      roles: ['mod'],
    })
  })

  it('answers 404 for a user Discord doesn\'t know', async () => {
    const base = await start()
    const response = await fetch(`${base}/api/users/nobody`, { headers: auth })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'User nobody not found' })
  })
})
