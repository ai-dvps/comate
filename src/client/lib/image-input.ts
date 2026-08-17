import {
  DEFAULT_IMAGE_INPUT_LIMITS,
  type ImageInputLimits,
} from '@server/utils/image-input-profile'
import type {
  ImageInputValidationCode,
  ImageMediaType,
  UserTurnImage,
} from '../types/message'

export { DEFAULT_IMAGE_INPUT_LIMITS }
export type { ImageInputLimits }

export interface PromptImageDraft extends UserTurnImage {
  blob: Blob
  previewUrl: string
}

export interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

export interface ImageInputRuntime {
  decode: (blob: Blob, dimensions: ImageDimensions) => Promise<DecodedImage>
  encode: (
    decoded: DecodedImage,
    mediaType: Exclude<ImageMediaType, 'image/gif'>,
    width: number,
    height: number,
    quality: number,
  ) => Promise<Blob>
  createPreviewUrl: (blob: Blob) => string
  revokePreviewUrl: (url: string) => void
}

interface ImageDimensions {
  width: number
  height: number
}

interface NormalizeImageBatchOptions {
  existingImages?: readonly PromptImageDraft[]
  limits?: ImageInputLimits
  runtime?: ImageInputRuntime
}

export class ImageInputError extends Error {
  constructor(
    public readonly code: ImageInputValidationCode,
    message: string,
    public readonly imageIndex?: number,
  ) {
    super(message)
    this.name = 'ImageInputError'
  }
}

function matches(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value)
}

export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (matches(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (
    matches(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (
    matches(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }
  return null
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    if (marker === 0xda) break
    if (offset + 2 > bytes.length) break
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) break
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isStartOfFrame && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      }
    }
    offset += length
  }
  return null
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function parseWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null
  const chunk = String.fromCharCode(...bytes.slice(12, 16))
  if (chunk === 'VP8X') {
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits =
      bytes[21] |
      (bytes[22] << 8) |
      (bytes[23] << 16) |
      (bytes[24] << 24)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    }
  }
  if (
    chunk === 'VP8 ' &&
    matches(bytes, [0x9d, 0x01, 0x2a], 23)
  ) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    }
  }
  return null
}

export function parseImageDimensions(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || !matches(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mediaType === 'image/gif') {
    if (bytes.length < 10) return null
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (mediaType === 'image/jpeg') return parseJpegDimensions(bytes)
  return parseWebpDimensions(bytes)
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new ImageInputError('invalid_base64', 'Could not read image'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      if (comma < 0) {
        reject(new ImageInputError('invalid_base64', 'Could not encode image'))
        return
      }
      resolve(result.slice(comma + 1))
    }
    reader.readAsDataURL(blob)
  })
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new ImageInputError('invalid_base64', 'Could not read image'))
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new ImageInputError('invalid_base64', 'Could not read image'))
        return
      }
      resolve(new Uint8Array(reader.result))
    }
    reader.readAsArrayBuffer(blob)
  })
}

function base64Length(blob: Blob): number {
  return 4 * Math.ceil(blob.size / 3)
}

async function decodeInBrowser(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  }

  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Image decode failed'))
      image.src = url
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function encodeInBrowser(
  decoded: DecodedImage,
  mediaType: Exclude<ImageMediaType, 'image/gif'>,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    return Promise.reject(new Error('Canvas is unavailable'))
  }
  context.drawImage(decoded.source, 0, 0, width, height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Image encoding failed')),
      mediaType,
      quality,
    )
  })
}

const BROWSER_RUNTIME: ImageInputRuntime = {
  decode: decodeInBrowser,
  encode: encodeInBrowser,
  createPreviewUrl: (blob) => URL.createObjectURL(blob),
  revokePreviewUrl: (url) => URL.revokeObjectURL(url),
}

function validateDimensions(
  dimensions: ImageDimensions,
  limits: ImageInputLimits,
  imageIndex: number,
): void {
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width * dimensions.height > limits.maxPixelsPerImage
  ) {
    throw new ImageInputError('invalid_dimensions', 'Image dimensions are unsafe', imageIndex)
  }
}

async function normalizeStaticImage(
  blob: Blob,
  mediaType: Exclude<ImageMediaType, 'image/gif'>,
  decoded: DecodedImage,
  limits: ImageInputLimits,
  runtime: ImageInputRuntime,
  imageIndex: number,
  forceEncode: boolean,
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(
    1,
    limits.maxDimensionPx / decoded.width,
    limits.maxDimensionPx / decoded.height,
  )
  let width = Math.max(1, Math.round(decoded.width * scale))
  let height = Math.max(1, Math.round(decoded.height * scale))

  if (
    !forceEncode &&
    scale === 1 &&
    base64Length(blob) < limits.targetBase64BytesPerImage
  ) {
    return { blob, width: decoded.width, height: decoded.height }
  }

  const qualities = mediaType === 'image/png'
    ? [1]
    : [0.92, 0.82, 0.72, 0.62, 0.5]
  for (let resizeAttempt = 0; resizeAttempt < 9; resizeAttempt += 1) {
    for (const quality of qualities) {
      const encoded = await runtime.encode(decoded, mediaType, width, height, quality)
      if (base64Length(encoded) < limits.targetBase64BytesPerImage) {
        return { blob: encoded, width, height }
      }
    }
    width = Math.max(1, Math.floor(width * 0.85))
    height = Math.max(1, Math.floor(height * 0.85))
  }
  throw new ImageInputError('image_too_large', 'Image remains too large after normalization', imageIndex)
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function normalizeImageBatch(
  files: readonly File[],
  options: NormalizeImageBatchOptions = {},
): Promise<PromptImageDraft[]> {
  const existingImages = options.existingImages ?? []
  const limits = options.limits ?? DEFAULT_IMAGE_INPUT_LIMITS
  const runtime = options.runtime ?? BROWSER_RUNTIME
  if (existingImages.length + files.length > limits.maxImages) {
    throw new ImageInputError('too_many_images', 'Too many images')
  }

  const normalized: PromptImageDraft[] = []
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (file.size > limits.maxRawBytesPerImage) {
        throw new ImageInputError('image_too_large', 'Image file is too large', index)
      }
      const bytes = await blobToBytes(file)
      const mediaType = detectImageMediaType(bytes)
      if (!mediaType || !limits.allowedMediaTypes.includes(mediaType)) {
        throw new ImageInputError('unsupported_media_type', 'Unsupported image format', index)
      }
      if (file.type && file.type !== mediaType) {
        throw new ImageInputError('media_signature_mismatch', 'Image type does not match its contents', index)
      }
      const headerDimensions = parseImageDimensions(bytes, mediaType)
      if (!headerDimensions) {
        throw new ImageInputError('invalid_dimensions', 'Could not read image dimensions', index)
      }
      validateDimensions(headerDimensions, limits, index)

      let decoded: DecodedImage
      try {
        decoded = await runtime.decode(file, headerDimensions)
      } catch {
        throw new ImageInputError('invalid_dimensions', 'Image could not be decoded', index)
      }
      try {
        validateDimensions(decoded, limits, index)
        let output: { blob: Blob; width: number; height: number }
        if (mediaType === 'image/gif') {
          if (
            decoded.width > limits.maxDimensionPx ||
            decoded.height > limits.maxDimensionPx ||
            base64Length(file) >= limits.targetBase64BytesPerImage
          ) {
            throw new ImageInputError('image_too_large', 'GIF exceeds the image limits', index)
          }
          output = { blob: file, width: decoded.width, height: decoded.height }
        } else {
          output = await normalizeStaticImage(
            file,
            mediaType,
            decoded,
            limits,
            runtime,
            index,
            decoded.width !== headerDimensions.width || decoded.height !== headerDimensions.height,
          )
        }
        const data = await blobToBase64(output.blob)
        const previewUrl = runtime.createPreviewUrl(output.blob)
        normalized.push({
          id: makeId(),
          name: file.name,
          mediaType,
          data,
          width: output.width,
          height: output.height,
          blob: output.blob,
          previewUrl,
        })
      } finally {
        decoded.close?.()
      }
    }

    const totalBase64Bytes = [...existingImages, ...normalized]
      .reduce((total, image) => total + image.data.length, 0)
    if (totalBase64Bytes > limits.maxBase64BytesPerBatch) {
      throw new ImageInputError('batch_too_large', 'The image batch is too large')
    }
    return normalized
  } catch (error) {
    for (const image of normalized) runtime.revokePreviewUrl(image.previewUrl)
    throw error instanceof ImageInputError
      ? error
      : new ImageInputError('invalid_dimensions', 'Image processing failed')
  }
}

export function releasePromptImage(image: PromptImageDraft): void {
  URL.revokeObjectURL(image.previewUrl)
}

export function toUserTurnImage(image: PromptImageDraft): UserTurnImage {
  return {
    id: image.id,
    name: image.name,
    mediaType: image.mediaType,
    data: image.data,
    width: image.width,
    height: image.height,
  }
}
