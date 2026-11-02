import { describe, expect, it } from 'vitest'
import { parseSteerMessage } from './parser.js'

describe('parseSteerMessage with a YAML body', () => {
  it('reads label: strength pairs, and takes the readout probes from the labels\' prefixes', () => {
    const result = parseSteerMessage('.steer Bot\n---\nemotion_cheerful: 3.0\nemotion_calm: -1.5\nformality: 2')
    expect(result).toEqual({
      ok: true,
      data: {
        target: 'Bot',
        directives: { emotion_cheerful: 3, emotion_calm: -1.5, formality: 2 },
        readout_probes: ['emotion'],
      },
    })
  })

  it('takes the readout probes from a readout section when there is one', () => {
    const result = parseSteerMessage('.steer Bot\n---\nemotion_cheerful: 1\n---\nreadout: tone, emotion')
    expect(result).toMatchObject({ ok: true, data: { readout_probes: ['tone', 'emotion'] } })
  })

  it('refuses a strength that isn\'t a number, naming the label', () => {
    expect(parseSteerMessage('.steer Bot\n---\nemotion_cheerful: high')).toEqual({
      ok: false,
      error: 'Invalid steering values:\nemotion_cheerful: Steering strength must be a number',
    })
  })
})
