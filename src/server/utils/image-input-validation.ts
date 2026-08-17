import type {
  ImageInputValidationError as ImageInputValidationDetails,
  ImageMediaType,
  UserTurnImage,
} from '../types/message.js';
import type { ImageInputProfile } from './image-input-profile.js';

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class ImageInputValidationError extends Error {
  constructor(public readonly details: ImageInputValidationDetails) {
    super(details.message);
    this.name = 'ImageInputValidationError';
  }
}

function fail(
  code: ImageInputValidationDetails['code'],
  message: string,
  extra: Omit<Partial<ImageInputValidationDetails>, 'kind' | 'code' | 'message'> = {},
): never {
  throw new ImageInputValidationError({
    kind: 'image_input_validation',
    code,
    message,
    ...extra,
  });
}

function decodeBase64(data: unknown, imageIndex: number): Buffer {
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !STRICT_BASE64.test(data)
  ) {
    fail('invalid_base64', 'Image data is not canonical base64', { imageIndex });
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== data) {
    fail('invalid_base64', 'Image data is not canonical base64', { imageIndex });
  }
  return bytes;
}

function detectedMediaType(bytes: Buffer): ImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return undefined;
}

function parseJpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (length < 7) return undefined;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function parseWebpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 20) return undefined;
  const riffSize = bytes.readUInt32LE(4);
  if (riffSize < 12 || riffSize + 8 > bytes.length) return undefined;
  const chunk = bytes.subarray(12, 16).toString('ascii');
  const chunkSize = bytes.readUInt32LE(16);
  if (20 + chunkSize > bytes.length) return undefined;
  if (chunk === 'VP8X') {
    if (chunkSize < 10 || bytes.length < 30) return undefined;
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    if (chunkSize < 10 || bytes.length < 30 || !bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return undefined;
    }
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + b0 + ((b1 & 0x3f) << 8),
      height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
    };
  }
  return undefined;
}

function parseDimensions(bytes: Buffer, mediaType: ImageMediaType): { width: number; height: number } | undefined {
  switch (mediaType) {
    case 'image/png':
      if (bytes.length < 24 || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
        return undefined;
      }
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    case 'image/jpeg':
      return parseJpegDimensions(bytes);
    case 'image/gif':
      if (bytes.length < 10) return undefined;
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    case 'image/webp':
      return parseWebpDimensions(bytes);
  }
}

export function validateUserTurnImages(
  input: unknown,
  profile: ImageInputProfile,
): UserTurnImage[] {
  if (!Array.isArray(input)) {
    fail('unsupported_media_type', 'Images must be an array');
  }
  if (input.length === 0) return [];
  if (!profile.enabled) {
    fail('model_unsupported', 'The active model does not support image input');
  }
  if (input.length > profile.limits.maxImages) {
    fail('too_many_images', 'The image count exceeds the active model limit', {
      limit: profile.limits.maxImages,
      actual: input.length,
    });
  }

  let aggregateBase64Bytes = 0;
  const validated: UserTurnImage[] = [];
  for (let imageIndex = 0; imageIndex < input.length; imageIndex += 1) {
    const candidate = input[imageIndex];
    if (!candidate || typeof candidate !== 'object') {
      fail('invalid_base64', 'Image descriptor is invalid', { imageIndex });
    }
    const image = candidate as Partial<UserTurnImage>;
    if (typeof image.id !== 'string' || image.id.trim().length === 0) {
      fail('invalid_base64', 'Image identifier is invalid', { imageIndex });
    }
    if (
      typeof image.mediaType !== 'string' ||
      !profile.limits.allowedMediaTypes.includes(image.mediaType as ImageMediaType)
    ) {
      fail('unsupported_media_type', 'Image media type is not supported', { imageIndex });
    }
    if (typeof image.data !== 'string') {
      fail('invalid_base64', 'Image data is not canonical base64', { imageIndex });
    }
    if (image.data.length >= profile.limits.targetBase64BytesPerImage) {
      fail('image_too_large', 'Image data exceeds the active model limit', {
        imageIndex,
        limit: profile.limits.targetBase64BytesPerImage,
        actual: image.data.length,
      });
    }
    aggregateBase64Bytes += image.data.length;
    if (aggregateBase64Bytes > profile.limits.maxBase64BytesPerBatch) {
      fail('batch_too_large', 'The image batch exceeds the active model limit', {
        limit: profile.limits.maxBase64BytesPerBatch,
        actual: aggregateBase64Bytes,
      });
    }

    const bytes = decodeBase64(image.data, imageIndex);
    if (bytes.length > profile.limits.maxRawBytesPerImage) {
      fail('image_too_large', 'Decoded image data exceeds the active model limit', {
        imageIndex,
        limit: profile.limits.maxRawBytesPerImage,
        actual: bytes.length,
      });
    }
    const detected = detectedMediaType(bytes);
    if (!detected) {
      fail('unsupported_media_type', 'Image signature is not supported', { imageIndex });
    }
    if (detected !== image.mediaType) {
      fail('media_signature_mismatch', 'Image media type does not match its contents', { imageIndex });
    }
    const dimensions = parseDimensions(bytes, detected);
    if (
      !dimensions ||
      dimensions.width <= 0 ||
      dimensions.height <= 0 ||
      !Number.isSafeInteger(dimensions.width) ||
      !Number.isSafeInteger(dimensions.height)
    ) {
      fail('invalid_dimensions', 'Image dimensions could not be read safely', { imageIndex });
    }
    if (
      image.width !== dimensions.width ||
      image.height !== dimensions.height ||
      dimensions.width > profile.limits.maxDimensionPx ||
      dimensions.height > profile.limits.maxDimensionPx ||
      dimensions.width * dimensions.height > profile.limits.maxPixelsPerImage
    ) {
      fail('invalid_dimensions', 'Image dimensions do not satisfy the active model limits', {
        imageIndex,
      });
    }
    if (image.name !== undefined && typeof image.name !== 'string') {
      fail('unsupported_media_type', 'Image name is invalid', { imageIndex });
    }
    validated.push(image as UserTurnImage);
  }
  return validated;
}
