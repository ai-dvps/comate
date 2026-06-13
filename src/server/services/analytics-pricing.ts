/**
 * Estimated-cost pricing for analytics (see plan 2026-06-13-007, U2).
 *
 * Ported from the reference app (`claude-code-history-viewer`'s
 * `utils/calculations.ts`) with one deliberate deviation: comate's policy
 * (R11 / AE3) is to EXCLUDE unknown-priced models from cost entirely and
 * surface them in the coverage indicator. The reference falls back to a
 * default rate; comate does not. `calculateModelCostUsd` therefore returns
 * 0 for unknown models, and `hasExplicitModelPricing` is the gating check
 * callers use to compute coverage.
 *
 * Rates are USD per 1,000,000 tokens.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-creation (write) tokens. */
  cacheWrite: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude models
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  // OpenAI models (Codex CLI). cacheWrite is 0 (OpenAI does not charge for
  // cache writes); cacheRead is input_rate * 0.1 (90% discount on cached input).
  // Specific keys must precede prefix matches — sorted below by length desc.
  'gpt-5.5': { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  'gpt-5.4': { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheWrite: 0, cacheRead: 0.04 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheWrite: 0, cacheRead: 0.01 },
  'gpt-4.1': { input: 2, output: 8, cacheWrite: 0, cacheRead: 0.2 },
  'o4-mini': { input: 1.1, output: 4.4, cacheWrite: 0, cacheRead: 0.11 },
  'codex-mini': { input: 1.5, output: 6, cacheWrite: 0, cacheRead: 0.15 },
  // Google models (OpenCode)
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6, cacheWrite: 0, cacheRead: 0 },
};

/**
 * Entries sorted by key length descending so that e.g. `gpt-4.1-mini` matches
 * before `gpt-4.1` when both are substrings of a model name.
 */
const SORTED_PRICING_ENTRIES = Object.entries(MODEL_PRICING).sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * Look up pricing for a model name via case-insensitive substring match against
 * the table keys. Returns `null` when no key matches — callers MUST treat null
 * as "pricing unknown, exclude from cost, count in coverage gap".
 */
export function findModelPricing(modelName: string): ModelPricing | null {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  for (const [key, value] of SORTED_PRICING_ENTRIES) {
    if (lower.includes(key)) return value;
  }
  return null;
}

/**
 * Whether the model has an explicit pricing entry. Use this to gate token
 * accumulation for the coverage indicator (R11).
 */
export function hasExplicitModelPricing(modelName: string): boolean {
  return findModelPricing(modelName) !== null;
}

/**
 * Estimated USD cost for a model's token usage. Returns 0 when the model has
 * no known pricing — by policy (R11 / AE3) such tokens are EXCLUDED from cost
 * and reflected in the coverage gap, not billed at a fallback rate.
 */
export function calculateModelCostUsd(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const pricing = findModelPricing(modelName);
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

/**
 * Infer a display provider id from a model name. Used for the provider
 * distribution card on the Global tab. Mirrors the reference app's family
 * grouping: Claude / OpenAI (Codex CLI) / Google (OpenCode) / Other.
 */
export function inferProviderId(modelName: string): string {
  if (!modelName) return 'unknown';
  const lower = modelName.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gpt') || lower.includes('codex') || lower.includes('o4')) return 'openai';
  if (lower.includes('gemini')) return 'google';
  return 'other';
}
