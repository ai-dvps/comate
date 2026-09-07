import type { Provider } from '../models/provider.js';
import type { UsageSummary, UsageStatus } from './provider-usage-types.js';
import { store as sqliteStoreSingleton } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';
import { providerVendorFromProvenance } from './provider-presets.js';

/**
 * Compile-time constants (R13/KTD8). These URLs are NEVER derived from
 * `provider.baseUrl` or any client-supplied field, so a tampered provider row
 * cannot redirect the trusted login modal or usage query to an attacker host.
 */
export const KIMI_LOGIN_URL = 'https://www.kimi.com';
export const KIMI_GET_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';
/** Registrable-domain site key under which the Kimi login is stored globally. */
export const KIMI_SITE_KEY = 'kimi.com';

const USAGE_TIMEOUT_MS = 8000;

/** A tighter gate than the loose `isKimiProvider` (KTD7): the Kimi coding plan. */
export function isKimiCodingPlanProvider(provider?: Provider): boolean {
  return providerVendorFromProvenance(provider?.configuration?.preset) === 'kimi';
}

export interface UsageResult {
  status: UsageStatus;
  summary?: UsageSummary;
  lastUpdated?: string;
}

/**
 * Build the whitelist summary (R14) by reading NAMED fields only. Never spreads
 * or clones the response, so account-identifying fields cannot reach the client.
 *
 * Kimi For Coding's `/usages` endpoint returns decimal strings. The top-level
 * `usage` is the weekly plan window and `limits[]` contains shorter windows,
 * including the 300-minute rolling limit.
 */
/** @internal — shared by all provider usage services. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** @internal */
export function asNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** @internal */
export function asStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseUsageSummary(body: unknown): UsageSummary | null {
  const rec = asRecord(body);
  if (!rec) return null;

  const usage = asRecord(rec.usage);
  const used = asNum(usage?.used);
  const total = asNum(usage?.limit);
  const remaining = asNum(usage?.remaining)
    ?? (total !== null && used !== null ? total - used : null);
  const resetDate = asStr(usage?.resetTime);

  if (used === null && total === null && remaining === null && resetDate === null) {
    return null;
  }

  const limits = Array.isArray(rec.limits) ? (rec.limits as unknown[]) : [];
  const rollingLimit = limits.find((item) => {
    const window = asRecord(asRecord(item)?.window);
    return asNum(window?.duration) === 300 && window?.timeUnit === 'TIME_UNIT_MINUTE';
  }) ?? limits[0];
  const rollingDetail = asRecord(asRecord(rollingLimit)?.detail);
  const rollingUsed = asNum(rollingDetail?.used);
  const rollingTotal = asNum(rollingDetail?.limit);
  const rollingRemaining = asNum(rollingDetail?.remaining)
    ?? (rollingTotal !== null && rollingUsed !== null ? rollingTotal - rollingUsed : null);
  const rollingReset = asStr(rollingDetail?.resetTime);
  const rolling =
    rollingRemaining !== null || rollingReset !== null
      ? { remaining: rollingRemaining, resetDate: rollingReset }
      : null;

  // Construct the whitelist object literal explicitly — never spread `rec`.
  return { used, total, remaining, resetDate, rolling, lastUpdated: new Date().toISOString() };
}

export class KimiUsageService {
  constructor(private readonly sqlite: SqliteStore) {}

  /**
   * Resolve Kimi coding-plan usage for a provider. Always queries the billing
   * endpoint live — no server-side cache, so the summary reflects the
   * provider's current quota. Server-side only; the response never carries the
   * token or account fields.
   *
   * Status semantics: `unsupported` (not a Kimi coding-plan provider),
   * `no-plan` (the credential has no coding plan), `error` (credential,
   * network, or timeout failure), `ready` (summary available).
   */
  async runUsageCheck(providerId: string): Promise<UsageResult> {
    const provider = this.sqlite.getProvider(providerId);
    if (!provider || !isKimiCodingPlanProvider(provider)) {
      return { status: 'unsupported' };
    }

    const token = provider.authToken.trim();
    if (!token) return { status: 'error' };

    try {
      const response = await fetch(KIMI_GET_USAGES_URL, {
        method: 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      });

      if (response.status === 401 || response.status === 403) {
        return { status: 'error' };
      }
      if (response.status < 200 || response.status >= 300) {
        return { status: 'error' };
      }

      const body = await response.json().catch(() => null) as unknown;
      const summary = parseUsageSummary(body);
      if (!summary) {
        return { status: 'no-plan' };
      }
      return { status: 'ready', summary, lastUpdated: summary.lastUpdated };
    } catch (err) {
      diagLog('Kimi usage query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'error' };
    }
  }
}

/** Process singleton. */
export const kimiUsageService = new KimiUsageService(sqliteStoreSingleton);
