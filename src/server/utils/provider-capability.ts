/**
 * Maintain a small, static capability map for provider-configured models.
 *
 * The Claude Agent SDK exposes `ModelInfo.supportsFastMode`, but resolving it
 * requires a live SDK query. For the GUI's provider-level capability gate we
 * use a conservative source-of-truth: fast mode is enabled unless the model
 * name matches a known unsupported pattern.
 *
 * Keep this list aligned with the SDK's `supportedModels()` output as new
 * models are released.
 */
const FAST_MODE_UNSUPPORTED_PATTERNS = [
  'claude-2',
  'claude-3-opus',
];

export function providerSupportsFastMode(model?: string): boolean {
  if (!model) {
    // Providers without an explicit model inherit the SDK default, which is
    // expected to support fast mode.
    return true;
  }
  const normalized = model.toLowerCase();
  return !FAST_MODE_UNSUPPORTED_PATTERNS.some((pattern) => normalized.includes(pattern));
}
