import type { ProviderConfiguration } from '../stores/provider-store'

export type ProviderCapabilityValidationError =
  | 'invalid-token-limit'
  | 'compact-exceeds-context'
  | 'output-requires-context'
  | 'output-exceeds-context'

export function validateProviderCapabilities(
  configuration: ProviderConfiguration,
): ProviderCapabilityValidationError | null {
  for (const profile of Object.values(configuration.codex.modelProfiles ?? {})) {
    if (profile.contextWindow !== undefined && (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow <= 0)) return 'invalid-token-limit'
    if (profile.autoCompactTokenLimit !== undefined && (!Number.isSafeInteger(profile.autoCompactTokenLimit) || profile.autoCompactTokenLimit <= 0)) return 'invalid-token-limit'
    if (profile.contextWindow !== undefined && profile.autoCompactTokenLimit !== undefined && profile.autoCompactTokenLimit > profile.contextWindow) return 'compact-exceeds-context'
  }
  for (const profile of Object.values(configuration.openCode.modelProfiles ?? {})) {
    if (profile.contextWindow !== undefined && (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow <= 0)) return 'invalid-token-limit'
    if (profile.maxOutputTokens !== undefined && (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0)) return 'invalid-token-limit'
    if (profile.maxOutputTokens !== undefined && profile.contextWindow === undefined) return 'output-requires-context'
    if (profile.contextWindow !== undefined && profile.maxOutputTokens !== undefined && profile.maxOutputTokens > profile.contextWindow) return 'output-exceeds-context'
    for (const variant of Object.values(profile.variants ?? {})) {
      if (variant.thinkingBudgetTokens !== undefined && (!Number.isSafeInteger(variant.thinkingBudgetTokens) || variant.thinkingBudgetTokens <= 0)) return 'invalid-token-limit'
    }
  }
  return null
}
