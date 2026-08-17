import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_INPUT_LIMITS,
  mergeImageInputLimits,
  resolveImageInputProfile,
} from './image-input-profile.js';

describe('resolveImageInputProfile', () => {
  it('enables known image-capable Claude and OpenCode models', () => {
    assert.equal(resolveImageInputProfile('claude', 'claude-sonnet-4-6').enabled, true);
    assert.equal(resolveImageInputProfile('opencode', 'gpt-5.4').enabled, true);
    assert.equal(resolveImageInputProfile('opencode', 'gemini-2.5-pro').enabled, true);
  });

  it('conservatively rejects missing, known text-only, and unknown custom models', () => {
    assert.equal(resolveImageInputProfile('claude', undefined).enabled, false);
    assert.equal(resolveImageInputProfile('claude', 'claude-2.1').enabled, false);
    const custom = resolveImageInputProfile('opencode', 'private-vision-proxy');
    assert.equal(custom.enabled, false);
    assert.equal(custom.reasonKey, 'backend.imageInputModelUnsupported');
  });

  it('uses the conservative v1 limits', () => {
    assert.deepEqual(DEFAULT_IMAGE_INPUT_LIMITS, {
      allowedMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxDimensionPx: 2_000,
      targetBase64BytesPerImage: Math.floor(4.5 * 1024 * 1024),
      maxRawBytesPerImage: 20 * 1024 * 1024,
      maxPixelsPerImage: 40_000_000,
      maxImages: 10,
      maxBase64BytesPerBatch: 20 * 1024 * 1024,
      preserveAnimatedGif: true,
    });
  });
});

describe('mergeImageInputLimits', () => {
  it('lets a stricter backend/model profile win without widening defaults', () => {
    const merged = mergeImageInputLimits(DEFAULT_IMAGE_INPUT_LIMITS, {
      allowedMediaTypes: ['image/png', 'image/jpeg'],
      maxDimensionPx: 1_024,
      maxImages: 3,
      maxRawBytesPerImage: 30 * 1024 * 1024,
    });
    assert.deepEqual(merged.allowedMediaTypes, ['image/png', 'image/jpeg']);
    assert.equal(merged.maxDimensionPx, 1_024);
    assert.equal(merged.maxImages, 3);
    assert.equal(merged.maxRawBytesPerImage, DEFAULT_IMAGE_INPUT_LIMITS.maxRawBytesPerImage);
  });
});
