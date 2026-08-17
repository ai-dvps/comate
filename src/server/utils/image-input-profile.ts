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

const CLAUDE_IMAGE_MODELS = new Set([
  'claude-sonnet-4',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-7',
  'claude-opus-4',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-haiku-4-6',
]);

const OPENCODE_IMAGE_MODELS = new Set([
  ...CLAUDE_IMAGE_MODELS,
  'gpt-5.4',
  'gpt-5.5',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]);

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
  model?: string,
  stricterLimits?: Partial<ImageInputLimits>,
): ImageInputProfile {
  const normalizedModel = model?.trim().toLowerCase();
  const knownModels = backend === 'claude' ? CLAUDE_IMAGE_MODELS : OPENCODE_IMAGE_MODELS;
  const enabled = normalizedModel !== undefined && knownModels.has(normalizedModel);
  return {
    enabled,
    ...(!enabled && { reasonKey: 'backend.imageInputModelUnsupported' }),
    limits: stricterLimits
      ? mergeImageInputLimits(DEFAULT_IMAGE_INPUT_LIMITS, stricterLimits)
      : DEFAULT_IMAGE_INPUT_LIMITS,
  };
}
