/**
 * Shared contract for provider coding-plan usage summaries (KTD3). The captured
 * login credential itself lives in the global site-auth store
 * (`global_site_auth['kimi.com']`, see kimi-usage-service). Usage summaries are
 * fetched live on every check — there is deliberately no server-side cache, so
 * quota readings never lag behind the provider.
 */

export interface UsageSummary {
  used: number | null;
  total: number | null;
  remaining: number | null;
  resetDate: string | null;
  /** Secondary rolling rate-limit window (e.g. Kimi's 5-hour limit), settings-only. */
  rolling: { remaining: number | null; resetDate: string | null } | null;
  /** ISO timestamp of the live fetch this summary came from (KTD3). */
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
