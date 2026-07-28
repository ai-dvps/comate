/**
 * In-memory usage-summary cache for provider usage (KTD3). The captured Kimi
 * login credential itself lives in the global site-auth store
 * (`global_site_auth['kimi.com']`, see kimi-usage-service); this holds only the
 * short-lived whitelisted usage summaries to avoid refetching on every view.
 */

export interface UsageSummary {
  used: number | null;
  total: number | null;
  remaining: number | null;
  resetDate: string | null;
  /** Secondary rolling rate-limit window (e.g. Kimi's 5-hour limit), settings-only. */
  rolling: { remaining: number | null; resetDate: string | null } | null;
  /** ISO timestamp of the last successful fetch (cache freshness, KTD3). */
  lastUpdated: string;
}

/** Status of a provider's usage, surfaced to the client store. */
export type UsageStatus =
  | 'idle'
  | 'fetching'
  | 'ready'
  | 'relogin'
  | 'no-plan'
  | 'unsupported'
  | 'error';

export interface UsageState {
  summary: UsageSummary | null;
  status: UsageStatus;
  lastUpdated: string | null;
}

/** KTD3 / OQ3: a cached usage value older than this is stale and re-fetched. */
const STALENESS_MS = 24 * 60 * 60 * 1000;

export class ProviderUsageStore {
  private readonly cache = new Map<string, UsageSummary>();

  /** Cached usage summary, or null when none is cached. */
  getCachedUsage(providerId: string): UsageSummary | null {
    return this.cache.get(providerId) ?? null;
  }

  /** Whether the cached value is absent or older than the 24h threshold. */
  isStale(summary: UsageSummary | null): boolean {
    if (!summary) {
      return true;
    }
    return Date.now() - new Date(summary.lastUpdated).getTime() > STALENESS_MS;
  }

  /** Update the in-memory usage cache for a provider. */
  setCachedUsage(providerId: string, summary: UsageSummary): void {
    this.cache.set(providerId, summary);
  }
}

/** Process singleton. */
export const providerUsageStore = new ProviderUsageStore();
