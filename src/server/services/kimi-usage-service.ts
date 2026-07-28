import type { Provider } from '../models/provider.js';
import { providerUsageStore, type UsageSummary, type UsageStatus } from './provider-usage-store.js';
import { store as sqliteStoreSingleton } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

/**
 * Compile-time constants (R13/KTD8). The Kimi login URL and the GetUsages
 * endpoint are NEVER derived from `provider.baseUrl` or any client-supplied
 * field, so a tampered provider row cannot redirect the trusted capture modal
 * or the billing query to an attacker host.
 */
export const KIMI_LOGIN_URL = 'https://www.kimi.com';
export const KIMI_GET_USAGES_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages';

const USAGE_TIMEOUT_MS = 8000;

/** A tighter gate than the loose `isKimiProvider` (KTD7): the Kimi coding plan. */
export function isKimiCodingPlanProvider(provider?: Provider): boolean {
  if (!provider) return false;
  return provider.baseUrl.toLowerCase().includes('kimi.com');
}

export interface UsageResult {
  status: UsageStatus;
  summary?: UsageSummary;
  lastUpdated?: string;
}

/**
 * Decode ONLY the `exp` claim from a JWT payload (KTD5). The rest of the
 * decoded payload is discarded; cause-classification uses static strings, never
 * decoded claims. Returns null when there is no `exp` or the payload is malformed.
 */
function readJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const claims = JSON.parse(payload) as Record<string, unknown>;
    const exp = claims.exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Build the whitelist summary (R14) by reading NAMED fields only. Never spreads
 * or clones the response, so account-identifying fields cannot reach the client.
 *
 * Real GetUsages shape (FEATURE_CODING): values are STRINGS, and the data is
 * nested —
 *   { totalQuota: { limit, used, remaining },
 *     usages: [ { scope: 'FEATURE_CODING', detail: { limit, used, resetTime },
 *                 limits: [ { detail: { limit, remaining, resetTime } } ] } ] }
 * `totalQuota` is the headline coding-plan quota; the FEATURE_CODING detail
 * carries the reset time. An account with no coding plan returns no
 * totalQuota / no FEATURE_CODING entry → all fields null → `no-plan`.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseUsageSummary(body: unknown): UsageSummary | null {
  const rec = asRecord(body);
  if (!rec) return null;

  // The coding-plan usage is usages[scope=FEATURE_CODING]. `totalQuota` is the
  // overall subscription total and is NOT coding-plan-usable, so it is ignored.
  const usages = Array.isArray(rec.usages) ? (rec.usages as unknown[]) : [];
  const coding = asRecord(usages.find((u) => asRecord(u)?.scope === 'FEATURE_CODING'));
  const codingDetail = asRecord(coding?.detail); // 7-day coding-plan window
  const limits = Array.isArray(coding?.limits) ? (coding.limits as unknown[]) : [];
  const firstLimitDetail = asRecord(asRecord(limits[0])?.detail); // rolling rate limit

  const used = asNum(codingDetail?.used);
  const total = asNum(codingDetail?.limit);
  const remaining = total !== null && used !== null ? total - used : null;
  const resetDate = asStr(codingDetail?.resetTime);

  // No FEATURE_CODING detail → not a coding-plan payload (no-plan).
  if (used === null && total === null && resetDate === null) {
    return null;
  }

  const rollingRemaining = asNum(firstLimitDetail?.remaining);
  const rollingReset = asStr(firstLimitDetail?.resetTime);
  const rolling =
    rollingRemaining !== null || rollingReset !== null
      ? { remaining: rollingRemaining, resetDate: rollingReset }
      : null;

  // Construct the whitelist object literal explicitly — never spread `rec`.
  return { used, total, remaining, resetDate, rolling, lastUpdated: new Date().toISOString() };
}

export class KimiUsageService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly usage = providerUsageStore,
  ) {}

  /**
   * Resolve Kimi coding-plan usage for a provider. Server-side only; the
   * response never carries the token or account fields.
   *
   * Status semantics: `unsupported` (not a Kimi coding-plan provider),
   * `idle` (coding-plan provider, no captured token yet), `relogin` (token
   * expired or auth failed), `no-plan` (logged-in account has no coding plan),
   * `error` (network/timeout), `ready` (summary available).
   */
  async runUsageCheck(providerId: string): Promise<UsageResult> {
    const provider = this.sqlite.getProvider(providerId);
    if (!provider || !isKimiCodingPlanProvider(provider)) {
      return { status: 'unsupported' };
    }

    const cached = this.usage.getCachedUsage(providerId);
    if (cached && !this.usage.isStale(cached)) {
      return { status: 'ready', summary: cached, lastUpdated: cached.lastUpdated };
    }

    const token = this.usage.getToken(providerId);
    if (!token) {
      return { status: 'idle' };
    }

    // Proactive expiry probe (KTD5): if the JWT is already expired, ask the
    // user to re-login without burning a request.
    const exp = readJwtExp(token);
    if (exp !== null && exp * 1000 <= Date.now()) {
      return { status: 'relogin' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
      const response = await fetch(KIMI_GET_USAGES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scope: ['FEATURE_CODING'] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        return { status: 'relogin' };
      }
      if (!response.ok) {
        return { status: 'error' };
      }

      const body = await response.json().catch(() => null);
      const summary = parseUsageSummary(body);
      if (!summary) {
        return { status: 'no-plan' };
      }
      this.usage.setCachedUsage(providerId, summary);
      return { status: 'ready', summary, lastUpdated: summary.lastUpdated };
    } catch (err) {
      diagLog('Kimi usage query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'error' };
    }
  }
}

/** Process singleton sharing the ProviderUsageStore caches. */
export const kimiUsageService = new KimiUsageService(sqliteStoreSingleton);
