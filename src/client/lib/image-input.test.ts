import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_IMAGE_INPUT_LIMITS,
  ImageInputError,
  normalizeImageBatch,
  type ImageInputRuntime,
} from './image-input'

function pngFile(width: number, height: number, name = 'shot.png'): File {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return new File([bytes], name, { type: 'image/png' })
}

function gifFile(width: number, height: number, byteLength = 32): File {
  const bytes = new Uint8Array(Math.max(byteLength, 10))
  bytes.set(new TextEncoder().encode('GIF89a'))
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return new File([bytes], 'animated.gif', { type: 'image/gif' })
}

function jpegFile(width: number, height: number): File {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ])
  return new File([bytes], 'photo.jpg', { type: 'image/jpeg' })
}

function webpFile(width: number, height: number): File {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
  const writeUint24 = (offset: number, value: number) => {
    bytes[offset] = value & 0xff
    bytes[offset + 1] = (value >>> 8) & 0xff
    bytes[offset + 2] = (value >>> 16) & 0xff
  }
  writeUint24(24, width - 1)
  writeUint24(27, height - 1)
  return new File([bytes], 'image.webp', { type: 'image/webp' })
}

function runtime(overrides: Partial<ImageInputRuntime> = {}): ImageInputRuntime {
  return {
    decode: vi.fn(async (_blob, dimensions) => ({
      source: {} as CanvasImageSource,
      width: dimensions.width,
      height: dimensions.height,
    })),
    encode: vi.fn(async (_decoded, mediaType, width, height) =>
      new Blob([new Uint8Array(Math.max(16, Math.floor(width * height / 100)))], {
        type: mediaType,
      }),
    ),
    createPreviewUrl: vi.fn(() => 'blob:preview'),
    revokePreviewUrl: vi.fn(),
    ...overrides,
  }
}

describe('normalizeImageBatch', () => {
  it('decodes and admits a valid static image without changing its aspect ratio', async () => {
    const platform = runtime()
    const [image] = await normalizeImageBatch([pngFile(1200, 600)], {
      runtime: platform,
    })

    expect(platform.decode).toHaveBeenCalledTimes(1)
    expect(platform.encode).not.toHaveBeenCalled()
    expect(image).toMatchObject({
      name: 'shot.png',
      mediaType: 'image/png',
      width: 1200,
      height: 600,
      previewUrl: 'blob:preview',
    })
    expect(image.data.length).toBeGreaterThan(0)
  })

  it('proportionally downsizes an oversized static image and keeps it below the base64 target', async () => {
    const platform = runtime({
      encode: vi.fn(async (_decoded, mediaType, width, height) => {
        expect(width).toBe(2000)
        expect(height).toBe(1000)
        return new Blob([new Uint8Array(64)], { type: mediaType })
      }),
    })

    const [image] = await normalizeImageBatch([pngFile(4000, 2000)], {
      runtime: platform,
    })

    expect(image.width).toBe(2000)
    expect(image.height).toBe(1000)
    expect(image.data.length).toBeLessThan(
      DEFAULT_IMAGE_INPUT_LIMITS.targetBase64BytesPerImage,
    )
  })

  it('requests a near-target decode size for oversized static images', async () => {
    const platform = runtime()

    await normalizeImageBatch([pngFile(4000, 2000)], { runtime: platform })

    expect(platform.decode).toHaveBeenCalledWith(
      expect.any(Blob),
      { width: 4000, height: 2000 },
      { width: 2000, height: 1000 },
    )
  })

  it('passes a compliant GIF through unchanged after a real decode', async () => {
    const platform = runtime()
    const input = gifFile(320, 180)
    const [image] = await normalizeImageBatch([input], { runtime: platform })

    expect(platform.decode).toHaveBeenCalledTimes(1)
    expect(platform.encode).not.toHaveBeenCalled()
    expect(image.blob).toBe(input)
    expect(image.mediaType).toBe('image/gif')
  })

  it.each([
    ['JPEG', jpegFile(640, 480), 'image/jpeg'],
    ['WebP', webpFile(800, 450), 'image/webp'],
  ])('admits a decoded %s image', async (_label, input, mediaType) => {
    const [image] = await normalizeImageBatch([input], { runtime: runtime() })
    expect(image).toMatchObject({ mediaType, width: expect.any(Number), height: expect.any(Number) })
  })

  it('rejects a GIF that would require re-encoding', async () => {
    await expect(normalizeImageBatch([gifFile(100, 100)], {
      runtime: runtime(),
      limits: {
        ...DEFAULT_IMAGE_INPUT_LIMITS,
        targetBase64BytesPerImage: 16,
      },
    })).rejects.toMatchObject({ code: 'image_too_large' } satisfies Partial<ImageInputError>)
  })

  it('rejects an unsafe pixel count before decoding', async () => {
    const platform = runtime()

    await expect(
      normalizeImageBatch([pngFile(10000, 5000)], { runtime: platform }),
    ).rejects.toMatchObject({ code: 'invalid_dimensions' } satisfies Partial<ImageInputError>)
    expect(platform.decode).not.toHaveBeenCalled()
  })

  it('rejects the complete candidate batch and revokes created previews when one file is corrupt', async () => {
    const platform = runtime({ createPreviewUrl: vi.fn(() => 'blob:first') })
    const corrupt = new File([new Uint8Array([1, 2, 3])], 'bad.png', {
      type: 'image/png',
    })

    await expect(
      normalizeImageBatch([pngFile(100, 100), corrupt], { runtime: platform }),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' } satisfies Partial<ImageInputError>)
    expect(platform.revokePreviewUrl).toHaveBeenCalledWith('blob:first')
  })

  it('rejects over-count batches without changing existing images', async () => {
    const existing = Array.from({ length: DEFAULT_IMAGE_INPUT_LIMITS.maxImages }, (_, index) => ({
      id: `existing-${index}`,
      name: `${index}.png`,
      mediaType: 'image/png' as const,
      data: 'AA==',
      width: 1,
      height: 1,
      blob: new Blob(),
      previewUrl: `blob:${index}`,
    }))

    await expect(
      normalizeImageBatch([pngFile(1, 1)], { existingImages: existing, runtime: runtime() }),
    ).rejects.toMatchObject({ code: 'too_many_images' } satisfies Partial<ImageInputError>)
    expect(existing).toHaveLength(DEFAULT_IMAGE_INPUT_LIMITS.maxImages)
  })

  it('rejects an aggregate-over-limit batch and releases only the candidates', async () => {
    const platform = runtime({ createPreviewUrl: vi.fn(() => 'blob:candidate') })
    const existing = [{
      id: 'existing',
      name: 'existing.png',
      mediaType: 'image/png' as const,
      data: 'AAAA',
      width: 1,
      height: 1,
      blob: new Blob(),
      previewUrl: 'blob:existing',
    }]

    await expect(normalizeImageBatch([pngFile(1, 1)], {
      existingImages: existing,
      runtime: platform,
      limits: { ...DEFAULT_IMAGE_INPUT_LIMITS, maxBase64BytesPerBatch: 6 },
    })).rejects.toMatchObject({ code: 'batch_too_large' } satisfies Partial<ImageInputError>)
    expect(platform.revokePreviewUrl).toHaveBeenCalledWith('blob:candidate')
    expect(platform.revokePreviewUrl).not.toHaveBeenCalledWith('blob:existing')
  })
})
