import sharp from 'sharp'

// Anthropic's per-image base64 limit on Amazon Bedrock (the Claude API's own is 10 MB)
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
// Anthropic's max image dimension — API rejects anything larger
export const MAX_IMAGE_DIMENSION = 8000

export interface ProcessedImage {
  data: Buffer
  mediaType: string
  width: number
  height: number
}

export async function prepareImage(
  data: Buffer,
  mediaType: string
): Promise<ProcessedImage> {
  const metadata = await sharp(data).metadata()
  const origWidth = metadata.width || 1024
  const origHeight = metadata.height || 1024
  const hasAlpha = metadata.hasAlpha || mediaType === 'image/png'

  const pipeline = sharp(data).resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
    fit: 'inside',
    withoutEnlargement: true,
  })

  let output: Buffer
  let outMediaType: string
  if (hasAlpha) {
    output = await pipeline.png({ compressionLevel: 6 }).toBuffer()
    outMediaType = 'image/png'
  } else {
    output = await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer()
    outMediaType = 'image/jpeg'
  }

  const outMeta = await sharp(output).metadata()
  const outWidth = outMeta.width || origWidth
  const outHeight = outMeta.height || origHeight

  return { data: output, mediaType: outMediaType, width: outWidth, height: outHeight }
}

export async function resampleImage(
  data: Buffer,
  maxBase64Bytes: number
): Promise<ProcessedImage> {
  // Target raw bytes (base64 adds ~33% overhead)
  const targetBytes = Math.floor(maxBase64Bytes * 0.75)

  const metadata = await sharp(data).metadata()

  let width = metadata.width || 1920
  let height = metadata.height || 1080
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = MAX_IMAGE_DIMENSION / Math.max(width, height)
    width = Math.floor(width * scale)
    height = Math.floor(height * scale)
  }
  let quality = 85

  const hasAlpha = metadata.hasAlpha
  const outputFormat = hasAlpha ? 'png' : 'jpeg'
  const outMediaType = outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png'

  for (let attempt = 0; attempt < 5; attempt++) {
    const pipeline = sharp(data).resize(width, height, { fit: 'inside', withoutEnlargement: true })

    const output = outputFormat === 'jpeg'
      ? await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer()

    if (output.length <= targetBytes) {
      return { data: output, mediaType: outMediaType, width, height }
    }

    if (quality > 50) {
      quality -= 15
    } else {
      width = Math.floor(width * 0.8)
      height = Math.floor(height * 0.8)
      quality = 75
    }
  }

  const finalWidth = Math.floor(width * 0.5)
  const finalHeight = Math.floor(height * 0.5)
  const finalPipeline = sharp(data)
    .resize(finalWidth, finalHeight, { fit: 'inside' })

  const finalOutput = outputFormat === 'jpeg'
    ? await finalPipeline.jpeg({ quality: 60 }).toBuffer()
    : await finalPipeline.png({ compressionLevel: 9 }).toBuffer()

  return { data: finalOutput, mediaType: outMediaType, width: finalWidth, height: finalHeight }
}
