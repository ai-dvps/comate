import type { BackendId } from '../services/agent-backends.js';
import type { ImageMediaType } from '../types/message.js';

export type { ImageMediaType } from '../types/message.js';

export const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && IMAGE_MEDIA_TYPES.includes(value as ImageMediaType);
}

export interface ImageInputLimits {
  allowedMediaTypes: readonly ImageMediaType[];
  maxDimensionPx: number;
  targetBase64BytesPerImage: number;
  maxRawBytesPerImage: number;
  maxPixelsPerImage: number;
  maxImages: number;
  maxBase64BytesPerBatch: number;
  preserveAnimatedGif: true;
}

export interface ImageInputProfile {
  enabled: boolean;
  reasonKey?: string;
  limits: ImageInputLimits;
}

export const DEFAULT_IMAGE_INPUT_LIMITS: ImageInputLimits = Object.freeze({
  allowedMediaTypes: IMAGE_MEDIA_TYPES,
  maxDimensionPx: 2_000,
  targetBase64BytesPerImage: Math.floor(4.5 * 1024 * 1024),
  maxRawBytesPerImage: 20 * 1024 * 1024,
  maxPixelsPerImage: 40_000_000,
  maxImages: 10,
  maxBase64BytesPerBatch: 20 * 1024 * 1024,
  preserveAnimatedGif: true,
});

export function mergeImageInputLimits(
  base: ImageInputLimits,
  override: Partial<ImageInputLimits>,
): ImageInputLimits {
  const allowed = override.allowedMediaTypes
    ? base.allowedMediaTypes.filter((mediaType) => override.allowedMediaTypes?.includes(mediaType))
    : base.allowedMediaTypes;
  const stricter = (key: keyof Omit<ImageInputLimits, 'allowedMediaTypes' | 'preserveAnimatedGif'>) =>
    Math.min(base[key], override[key] ?? base[key]);
  return {
    allowedMediaTypes: allowed,
    maxDimensionPx: stricter('maxDimensionPx'),
    targetBase64BytesPerImage: stricter('targetBase64BytesPerImage'),
    maxRawBytesPerImage: stricter('maxRawBytesPerImage'),
    maxPixelsPerImage: stricter('maxPixelsPerImage'),
    maxImages: stricter('maxImages'),
    maxBase64BytesPerBatch: stricter('maxBase64BytesPerBatch'),
    preserveAnimatedGif: true,
  };
}

export function resolveImageInputProfile(
  backend: BackendId,
  _model?: string,
  stricterLimits?: Partial<ImageInputLimits>,
): ImageInputProfile {
  // Claude Code and OpenCode expose image transport at the backend boundary,
  // but neither provides reliable modality metadata for every configured or
  // proxied model. Do not turn an unfamiliar provider model name into a false
  // negative; provider rejection remains the authoritative capability signal.
  const enabled = backend === 'claude' || backend === 'opencode';
  return {
    enabled,
    ...(!enabled && { reasonKey: 'backend.imageInputModelUnsupported' }),
    limits: stricterLimits
      ? mergeImageInputLimits(DEFAULT_IMAGE_INPUT_LIMITS, stricterLimits)
      : DEFAULT_IMAGE_INPUT_LIMITS,
  };
}
