/**
 * Hardcoded context-window sizes for known Anthropic models.
 * The SDK's `modelUsage` field is the primary source; this map is a fallback.
 */
const CONTEXT_WINDOW_MAP: Record<string, number> = {
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4-7': 200000,
  'claude-opus-4-6': 200000,
  'claude-opus-4-7': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4-6': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
}

const DEFAULT_CONTEXT_WINDOW = 200000

/**
 * Resolve the context-window size for a model.
 *
 * @param modelName — active model alias or canonical ID
 * @param modelUsage — optional SDK `modelUsage` map from a `result` event
 * @returns context-window size in tokens
 */
export function getContextWindowForModel(
  modelName: string,
  modelUsage?: Record<string, unknown>,
): number {
  if (modelUsage) {
    const entry = modelUsage[modelName]
    if (entry && typeof entry === 'object') {
      const cw = (entry as Record<string, unknown>).contextWindow
      if (typeof cw === 'number' && cw > 0) {
        return cw
      }
    }
  }

  const hardcoded = CONTEXT_WINDOW_MAP[modelName]
  if (hardcoded) return hardcoded

  // Try a fuzzy match on the hardcoded keys (e.g. alias contains canonical id)
  for (const [key, value] of Object.entries(CONTEXT_WINDOW_MAP)) {
    if (modelName.includes(key) || key.includes(modelName)) {
      return value
    }
  }

  return DEFAULT_CONTEXT_WINDOW
}
