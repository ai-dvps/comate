import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { UserTurnImage } from '../types/message.js';
import {
  ImageInputValidationError,
  validateUserTurnImages,
} from './image-input-validation.js';
import {
  DEFAULT_IMAGE_INPUT_LIMITS,
  type ImageInputProfile,
} from './image-input-profile.js';

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBPVP8X', 8, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function image(
  id: string,
  mediaType: UserTurnImage['mediaType'],
  bytes: Buffer,
  width: number,
  height: number,
): UserTurnImage {
  return { id, mediaType, data: bytes.toString('base64'), width, height };
}

const enabledProfile: ImageInputProfile = {
  enabled: true,
  limits: DEFAULT_IMAGE_INPUT_LIMITS,
};

function expectValidationCode(fn: () => unknown, code: string, imageIndex?: number): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ImageInputValidationError);
    assert.equal(error.details.code, code);
    assert.equal(error.details.imageIndex, imageIndex);
    return true;
  });
}

describe('validateUserTurnImages', () => {
  it('admits PNG, JPEG, WebP, and GIF using detected dimensions', () => {
    const images = [
      image('png', 'image/png', png(1200, 600), 1200, 600),
      image('jpeg', 'image/jpeg', jpeg(640, 480), 640, 480),
      image('webp', 'image/webp', webp(800, 450), 800, 450),
      image('gif', 'image/gif', gif(320, 180), 320, 180),
    ];

    assert.deepEqual(validateUserTurnImages(images, enabledProfile), images);
  });

  it('rejects permissive-decoder base64 traps', () => {
    const valid = image('png', 'image/png', png(1, 1), 1, 1);
    for (const data of [`${valid.data}=junk`, `${valid.data}\n`, 'AA', 'A===']) {
      expectValidationCode(
        () => validateUserTurnImages([{ ...valid, data }], enabledProfile),
        'invalid_base64',
        0,
      );
    }
  });

  it('rejects spoofed MIME, truncated headers, and declared dimension mismatches', () => {
    expectValidationCode(
      () => validateUserTurnImages([
        image('spoof', 'image/jpeg', png(1, 1), 1, 1),
      ], enabledProfile),
      'media_signature_mismatch',
      0,
    );
    expectValidationCode(
      () => validateUserTurnImages([
        image('short', 'image/png', png(1, 1).subarray(0, 20), 1, 1),
      ], enabledProfile),
      'invalid_dimensions',
      0,
    );
    expectValidationCode(
      () => validateUserTurnImages([
        image('mismatch', 'image/png', png(2, 1), 1, 1),
      ], enabledProfile),
      'invalid_dimensions',
      0,
    );
  });

  it('atomically rejects count, per-image, pixel, dimension, and aggregate limits', () => {
    const one = image('one', 'image/png', png(1, 1), 1, 1);
    expectValidationCode(
      () => validateUserTurnImages([one, { ...one, id: 'two' }], {
        enabled: true,
        limits: { ...DEFAULT_IMAGE_INPUT_LIMITS, maxImages: 1 },
      }),
      'too_many_images',
    );
    expectValidationCode(
      () => validateUserTurnImages([one], {
        enabled: true,
        limits: { ...DEFAULT_IMAGE_INPUT_LIMITS, targetBase64BytesPerImage: one.data.length - 1 },
      }),
      'image_too_large',
      0,
    );
    expectValidationCode(
      () => validateUserTurnImages([
        image('pixels', 'image/png', png(10, 10), 10, 10),
      ], {
        enabled: true,
        limits: { ...DEFAULT_IMAGE_INPUT_LIMITS, maxPixelsPerImage: 99 },
      }),
      'invalid_dimensions',
      0,
    );
    expectValidationCode(
      () => validateUserTurnImages([
        image('dimension', 'image/png', png(11, 1), 11, 1),
      ], {
        enabled: true,
        limits: { ...DEFAULT_IMAGE_INPUT_LIMITS, maxDimensionPx: 10 },
      }),
      'invalid_dimensions',
      0,
    );
    expectValidationCode(
      () => validateUserTurnImages([one, { ...one, id: 'two' }], {
        enabled: true,
        limits: { ...DEFAULT_IMAGE_INPUT_LIMITS, maxBase64BytesPerBatch: one.data.length * 2 - 1 },
      }),
      'batch_too_large',
    );
  });

  it('rejects image input when the effective profile is unavailable', () => {
    expectValidationCode(
      () => validateUserTurnImages([
        image('png', 'image/png', png(1, 1), 1, 1),
      ], { enabled: false, reasonKey: 'backend.imageInputModelUnsupported', limits: DEFAULT_IMAGE_INPUT_LIMITS }),
      'model_unsupported',
    );
  });
});
