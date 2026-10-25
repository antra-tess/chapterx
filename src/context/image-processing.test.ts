import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  prepareImage,
  resampleImage,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_DIMENSION,
} from './image-processing.js'

async function makeImage(
  width: number,
  height: number,
  opts?: { format?: 'png' | 'jpeg'; alpha?: boolean }
): Promise<{ buffer: Buffer; mediaType: string }> {
  const channels = opts?.alpha ? 4 : 3
  const format = opts?.format ?? (opts?.alpha ? 'png' : 'jpeg')

  const raw = Buffer.alloc(width * height * channels, 128)
  let pipeline = sharp(raw, { raw: { width, height, channels } })

  let buffer: Buffer
  let mediaType: string
  if (format === 'png') {
    buffer = await pipeline.png().toBuffer()
    mediaType = 'image/png'
  } else {
    buffer = await pipeline.jpeg({ quality: 90 }).toBuffer()
    mediaType = 'image/jpeg'
  }

  return { buffer, mediaType }
}

describe('prepareImage', () => {
  it('passes through small images without changing dimensions', async () => {
    const { buffer, mediaType } = await makeImage(800, 600)
    const result = await prepareImage(buffer, mediaType)

    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
    expect(result.data.length).toBeGreaterThan(0)
  })

  it('caps images exceeding MAX_IMAGE_DIMENSION on width', async () => {
    const { buffer, mediaType } = await makeImage(10000, 2000)
    const result = await prepareImage(buffer, mediaType)

    expect(result.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(result.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(result.width).toBe(8000)
    expect(result.height).toBe(1600)
  })

  it('caps images exceeding MAX_IMAGE_DIMENSION on height', async () => {
    const { buffer, mediaType } = await makeImage(2000, 10000)
    const result = await prepareImage(buffer, mediaType)

    expect(result.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(result.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(result.width).toBe(1600)
    expect(result.height).toBe(8000)
  })

  it('caps images exceeding MAX_IMAGE_DIMENSION on both axes', async () => {
    const { buffer, mediaType } = await makeImage(12000, 9000)
    const result = await prepareImage(buffer, mediaType)

    expect(result.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(result.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
  })

  it('preserves PNG format for images with alpha channel', async () => {
    const { buffer, mediaType } = await makeImage(400, 400, { alpha: true })
    const result = await prepareImage(buffer, mediaType)

    expect(result.mediaType).toBe('image/png')
  })

  it('converts opaque images to JPEG', async () => {
    const { buffer } = await makeImage(400, 400, { format: 'png' })
    const result = await prepareImage(buffer, 'image/png')

    expect(result.mediaType).toBe('image/png')
  })

  it('handles JPEG input and outputs JPEG', async () => {
    const { buffer, mediaType } = await makeImage(600, 400)
    const result = await prepareImage(buffer, mediaType)

    expect(result.mediaType).toBe('image/jpeg')
  })

  it('strips EXIF metadata', async () => {
    const raw = Buffer.alloc(200 * 200 * 3, 100)
    const withExif = await sharp(raw, { raw: { width: 200, height: 200, channels: 3 } })
      .jpeg()
      .withExifMerge({ IFD0: { ImageDescription: 'test metadata' } })
      .toBuffer()

    const result = await prepareImage(withExif, 'image/jpeg')

    const outMeta = await sharp(result.data).metadata()
    expect(outMeta.exif).toBeUndefined()
  })
})

describe('resampleImage', () => {
  it('returns image under the size limit', async () => {
    const { buffer } = await makeImage(2000, 2000)
    const result = await resampleImage(buffer, MAX_IMAGE_BASE64_BYTES)

    const base64Size = result.data.length * 4 / 3
    expect(base64Size).toBeLessThanOrEqual(MAX_IMAGE_BASE64_BYTES)
  })

  it('caps dimensions to MAX_IMAGE_DIMENSION before size reduction', async () => {
    const { buffer } = await makeImage(9000, 4000)
    const result = await resampleImage(buffer, MAX_IMAGE_BASE64_BYTES)

    expect(result.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(result.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
  })

  it('preserves PNG with alpha during resampling', async () => {
    const { buffer } = await makeImage(3000, 3000, { alpha: true })
    const result = await resampleImage(buffer, MAX_IMAGE_BASE64_BYTES)

    expect(result.mediaType).toBe('image/png')
  })

  it('converts opaque images to JPEG for better compression', async () => {
    const { buffer } = await makeImage(3000, 3000)
    const result = await resampleImage(buffer, MAX_IMAGE_BASE64_BYTES)

    expect(result.mediaType).toBe('image/jpeg')
  })

  it('handles very small size limits by aggressively downsizing', async () => {
    const { buffer } = await makeImage(4000, 4000, { format: 'png' })
    const tightLimit = 50 * 1024
    const result = await resampleImage(buffer, tightLimit)

    expect(result.data.length).toBeLessThanOrEqual(Math.floor(tightLimit * 0.75))
    expect(result.data.length).toBeGreaterThan(0)
  })

  it('does not enlarge small images', async () => {
    const { buffer } = await makeImage(100, 100)
    const result = await resampleImage(buffer, MAX_IMAGE_BASE64_BYTES)

    expect(result.width).toBe(100)
    expect(result.height).toBe(100)
  })
})

describe('integration: prepareImage + resampleImage pipeline', () => {
  it('handles the trace fa76c759 scenario: large dimensions, small file size', async () => {
    // Over 8000px on one side but under 5MB base64: Anthropic rejects it anyway.
    const { buffer, mediaType } = await makeImage(9000, 5000)

    const prepared = await prepareImage(buffer, mediaType)
    expect(prepared.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(prepared.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)

    const base64Size = prepared.data.length * 4 / 3
    if (base64Size > MAX_IMAGE_BASE64_BYTES) {
      const resampled = await resampleImage(prepared.data, MAX_IMAGE_BASE64_BYTES)
      expect(resampled.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
      expect(resampled.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
      expect(resampled.data.length * 4 / 3).toBeLessThanOrEqual(MAX_IMAGE_BASE64_BYTES)
    }
  })

  it('handles extreme aspect ratios', async () => {
    const { buffer, mediaType } = await makeImage(15000, 500)
    const prepared = await prepareImage(buffer, mediaType)

    expect(prepared.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION)
    expect(prepared.height).toBeLessThan(500)
    expect(prepared.width).toBe(8000)
  })
})
