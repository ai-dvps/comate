import type { TurnTokenUsage } from '../types/message.js';

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeProviderTokenUsage(raw: unknown): TurnTokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = nonNegativeNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = nonNegativeNumber(usage.cache_creation_input_tokens);
  const hasKnownField = [
    'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
  ].some((key) => nonNegativeNumber(usage[key]) !== undefined);
  if (!hasKnownField && nonNegativeNumber(usage.total_tokens) === undefined) return undefined;
  const details = usage.output_tokens_details;
  const thinkingTokens = details && typeof details === 'object' && !Array.isArray(details)
    ? nonNegativeNumber((details as Record<string, unknown>).thinking_tokens)
    : undefined;
  return {
    quality: 'exact',
    totalTokens: nonNegativeNumber(usage.total_tokens)
      ?? (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
  };
}

export function isTurnTokenUsage(value: unknown): value is TurnTokenUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (usage.quality === 'unavailable') return true;
  return (usage.quality === 'exact' || usage.quality === 'estimated')
    && nonNegativeNumber(usage.totalTokens) !== undefined;
}

export function sumTurnTokenUsages(usages: TurnTokenUsage[]): TurnTokenUsage {
  if (usages.length === 0) return { quality: 'unavailable' };
  if (usages.length === 1) return usages[0];
  if (usages.some((usage) => usage.quality === 'unavailable')) {
    return { quality: 'unavailable' };
  }
  const available = usages as Array<Exclude<TurnTokenUsage, { quality: 'unavailable' }>>;
  const sum = (key: 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'thinkingTokens') =>
    available.reduce((total, usage) => total + (usage[key] ?? 0), 0);
  const has = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'thinkingTokens') =>
    available.some((usage) => usage[key] !== undefined);
  return {
    quality: 'estimated',
    totalTokens: sum('totalTokens'),
    ...(has('inputTokens') ? { inputTokens: sum('inputTokens') } : {}),
    ...(has('outputTokens') ? { outputTokens: sum('outputTokens') } : {}),
    ...(has('cacheReadTokens') ? { cacheReadTokens: sum('cacheReadTokens') } : {}),
    ...(has('cacheWriteTokens') ? { cacheWriteTokens: sum('cacheWriteTokens') } : {}),
    ...(has('thinkingTokens') ? { thinkingTokens: sum('thinkingTokens') } : {}),
  };
}
