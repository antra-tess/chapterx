/**
 * The request logs (logs/llm-requests and logs/membrane-requests) replace each
 * media block's payload with its length, in each shape a provider's request
 * gives it, and keep everything else as it was, JSON text included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MembraneProvider } from './provider.js'

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const AUDIO = 'T2dnUwACAAAAAAAAAAB6x5ZQAAAAAJyCq0ABE09wdXNIZWFkAQE4AYC7AAAAAAA+'
const SIGNATURE = 'EqQBCkgIARABGAIiQL3hNDp6X0J4YmpqMTVwOW5GQmxtUjRGS29kUWdZd0pJ'
const marker = (payload: string) => `[BASE64_DATA_${payload.length}_BYTES]`

let dir: string
// The loggers run as they do in a provider; they need nothing its constructor sets.
const provider = Object.create(MembraneProvider.prototype) as any

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chapterx-request-log-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Log a request as a provider's onRequest does, and read the file back. */
function logged(request: unknown, log: 'llm-requests' | 'membrane-requests' = 'llm-requests'): any {
  const name = log === 'llm-requests' ? provider.logRequestToFile(request) : provider.logMembraneRequestToFile(request)
  expect(name).toBeTypeOf('string')
  return JSON.parse(readFileSync(join(dir, 'logs', log, name), 'utf-8'))
}

describe('request logs', () => {
  it('replace an Anthropic image and document in a message, and an image in a tool result, and keep text and thinking', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } }
    const out = logged({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, image, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: IMAGE } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: SIGNATURE }, { type: 'redacted_thinking', data: SIGNATURE }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [image] }] },
      ],
    })
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: marker(IMAGE) } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: marker(IMAGE) } },
    ])
    expect(out.messages[1].content).toEqual([{ type: 'thinking', thinking: 'hm', signature: SIGNATURE }, { type: 'redacted_thinking', data: SIGNATURE }])
    expect(out.messages[2].content[0].content[0].source.data).toBe(marker(IMAGE))
  })

  it('replace a payload whatever its characters, line breaks included', () => {
    const wrapped = `${IMAGE.slice(0, 40)}\r\n${IMAGE.slice(40)}`
    const out = logged({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: wrapped } }] }] })
    expect(out.messages[0].content[0].source.data).toBe(marker(wrapped))
  })

  it("replace Gemini's inlineData, and keep a part's thought signature", () => {
    const out = logged({
      contents: [{ role: 'user', parts: [
        { text: 'listen' },
        { inlineData: { mimeType: 'audio/ogg', data: AUDIO } },
        { inlineData: { mimeType: 'image/png', data: IMAGE } },
      ] }, { role: 'model', parts: [{ text: 'ok', thoughtSignature: SIGNATURE }] }],
    })
    expect(out.contents[0].parts).toEqual([
      { text: 'listen' },
      { inlineData: { mimeType: 'audio/ogg', data: marker(AUDIO) } },
      { inlineData: { mimeType: 'image/png', data: marker(IMAGE) } },
    ])
    expect(out.contents[1].parts[0].thoughtSignature).toBe(SIGNATURE)
  })

  it("replace an image_url data URL's payload and an input_audio's data, and keep a linked image and a null field", () => {
    const out = logged({
      model: 'google/gemini-3.8-flash',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}` } },
        { type: 'input_audio', input_audio: { data: AUDIO, format: 'ogg' } },
        { type: 'image_url', image_url: { url: 'https://cdn.example/cat.png' } },
      ] }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }] }],
    })
    expect(out.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${marker(IMAGE)}` } },
      { type: 'input_audio', input_audio: { data: marker(AUDIO), format: 'ogg' } },
      { type: 'image_url', image_url: { url: 'https://cdn.example/cat.png' } },
    ])
    expect(out.messages[1].content).toBeNull()
  })

  it("replace each input image of an Images API edit, and keep its prompt", () => {
    const out = logged({ model: 'gpt-image-1', prompt: 'make it blue', image: [`data:image/png;base64,${IMAGE}`, `data:image/jpeg;base64,${AUDIO}`], n: 1 })
    expect(out).toEqual({ model: 'gpt-image-1', prompt: 'make it blue', image: [`data:image/png;base64,${marker(IMAGE)}`, `data:image/jpeg;base64,${marker(AUDIO)}`], n: 1 })
  })

  it("replace audio in membrane's own request log", () => {
    const out = logged({
      messages: [{ participant: 'bob', content: [{ type: 'audio', source: { type: 'base64', mediaType: 'audio/ogg', data: AUDIO } }] }],
    }, 'membrane-requests')
    expect(out.messages[0].content[0].source).toEqual({ type: 'base64', mediaType: 'audio/ogg', data: marker(AUDIO) })
  })

  it("keep what isn't a media block: tool arguments, unknown shapes, text, other URLs", () => {
    const request = {
      messages: [{ role: 'assistant', content: [
        { type: 'tool_use', id: 't2', name: 'save', input: { data: 'hello', format: 'text' } },
        { type: 'tool_use', id: 't3', name: 'attach', input: { attachment: { mimeType: 'image/png', data: IMAGE } } },
        { type: 'tool_use', id: 't4', name: 'count', input: { type: 'base64', data: 1234 } },
        { type: 'tool_use', id: 't6', name: 'encode', input: { type: 'base64', data: 'hello world' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 1234 } },
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' } },
        { type: 'tool_use', id: 't8', name: 'tag', input: { image: 'cat', other: { image: { url: 'https://cdn.example/b.png' } } } },
        { type: 'text', text: `data:image/png;base64,${IMAGE}` },
        { type: 'image_url', image_url: { url: 'data:text/plain,hello' } },
        { type: 'image_url', image_url: { url: 'data:text/plain,a;base64,b' } },
        { type: 'image_url', image_url: { url: 'https://cdn.example/a;base64,b.png' } },
        { type: 'tool_use', id: 't5', name: 'tag', input: { image: ['cat', `see data:image/png;base64,${IMAGE}`, { name: 'x' }, 3], labels: [`data:image/png;base64,${IMAGE}`] } },
      ] }],
    }
    expect(logged(request)).toEqual(request)
  })

  it("replace media of these shapes in a tool's structured arguments too", () => {
    const out = logged({ messages: [{ role: 'assistant', content: [
      { type: 'tool_use', id: 't7', name: 'send', input: {
        url: `data:image/png;base64,${IMAGE}`,
        filename: 'cat.png',
        picture: { source: { type: 'base64', media_type: 'image/png', data: IMAGE } },
        clip: { inlineData: { mimeType: 'audio/ogg', data: AUDIO } },
        voice: { input_audio: { data: AUDIO, format: 'ogg' } },
        image: [`data:image/png;base64,${IMAGE}`],
      } },
    ] }] })
    expect(out.messages[0].content[0].input).toEqual({
      url: `data:image/png;base64,${marker(IMAGE)}`,
      filename: 'cat.png',
      picture: { source: { type: 'base64', media_type: 'image/png', data: marker(IMAGE) } },
      clip: { inlineData: { mimeType: 'audio/ogg', data: marker(AUDIO) } },
      voice: { input_audio: { data: marker(AUDIO), format: 'ogg' } },
      image: [`data:image/png;base64,${marker(IMAGE)}`],
    })
  })

  it('keep JSON text as it was sent, such as a tool result or a tool call\'s arguments', () => {
    const asText = JSON.stringify([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } }])
    const request = { messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send', arguments: JSON.stringify({ url: `data:image/png;base64,${IMAGE}` }) } }] },
      { role: 'tool', tool_call_id: 'c1', content: asText },
    ] }
    expect(logged(request)).toEqual(request)
  })

  it('leave the request it was handed as it was', () => {
    const request = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } }] }] }
    logged(request)
    expect(request.messages[0]!.content[0]!.source.data).toBe(IMAGE)
  })
})
