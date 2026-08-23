import type { Provider } from '../models/provider.js';
import type { UsageSummary, UsageStatus } from './provider-usage-types.js';
import { store as sqliteStoreSingleton } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { asRecord, asNum } from './kimi-usage-service.js';
import { diagLog } from '../utils/diag-logger.js';
import { BrowserSiteAuthReadError, readGlobalSiteAuthEntry } from './browser-site-auth.js';
import { providerVendorFromProvenance } from './provider-presets.js';
import { BrowserDirectHttpClient } from './browser-direct-http-client.js';
import type { ProviderUsageHttpClient } from './kimi-usage-service.js';

export const BIGMODEL_LOGIN_URL = 'https://bigmodel.cn';
export const BIGMODEL_USAGE_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
export const BIGMODEL_SITE_KEY = 'bigmodel.cn';
/** The cookie name that holds the BigModel access JWT. */
export const BIGMODEL_TOKEN_COOKIE = 'bigmodel_token_production';

const USAGE_TIMEOUT_MS = 8000;
const usageHttpClient = new BrowserDirectHttpClient({ limits: { totalTimeoutMs: USAGE_TIMEOUT_MS, maxRedirects: 1 } });

export function isBigModelProvider(provider?: Provider): boolean {
  return providerVendorFromProvenance(provider?.configuration?.preset) === 'bigmodel';
}

export interface UsageResult {
  status: UsageStatus;
  summary?: UsageSummary;
  lastUpdated?: string;
}

/**
 * Parse the BigModel `quota/limit` response. The `data.limits` array entries
 * are distinguished by `unit`:
 *   unit 5 = TIME_LIMIT (MCP monthly — NOT coding plan, dropped)
 *   unit 6 = TOKENS_LIMIT (coding plan weekly) → primary
 *   unit 3 = TOKENS_LIMIT (coding plan 5h)    → rolling
 * The coding-plan limits only expose `percentage`; map to used/total/remaining
 * (total=100) so the display matches Kimi's "X / 100 used · Y left" format.
 */
function parseBigModelUsage(body: unknown): UsageSummary | null {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  if (!data) return null;
  const limits = Array.isArray(data.limits) ? (data.limits as unknown[]) : [];

  const weekly = asRecord(limits.find((l) => asRecord(l)?.unit === 6));
  const fiveHour = asRecord(limits.find((l) => asRecord(l)?.unit === 3));
  if (!weekly && !fiveHour) return null;

  // Primary: weekly coding (unit 6).
  const weeklyPct = asNum(weekly?.percentage);
  const used = weeklyPct;
  const total = weeklyPct !== null ? 100 : null;
  const remaining = weeklyPct !== null ? 100 - weeklyPct : null;
  const weeklyResetMs = asNum(weekly?.nextResetTime);
  const resetDate = weeklyResetMs !== null ? new Date(weeklyResetMs).toISOString() : null;

  // Rolling: 5h coding (unit 3).
  const fiveHourPct = asNum(fiveHour?.percentage);
  const fiveHourResetMs = asNum(fiveHour?.nextResetTime);
  const rolling =
    fiveHourPct !== null || fiveHourResetMs !== null
      ? {
          remaining: fiveHourPct !== null ? 100 - fiveHourPct : null,
          resetDate: fiveHourResetMs !== null ? new Date(fiveHourResetMs).toISOString() : null,
        }
      : null;

  if (used === null && total === null && remaining === null && resetDate === null) {
    return null;
  }
  return { used, total, remaining, resetDate, rolling, lastUpdated: new Date().toISOString() };
}

/** Read the captured BigModel bearer from global_site_auth. */
function readBigModelBearer(sqlite: SqliteStore): string | null {
  try {
    const entry = readGlobalSiteAuthEntry(sqlite, BIGMODEL_SITE_KEY)?.entry;
    return entry?.bearerToken && entry.bearerToken.length > 0 ? entry.bearerToken : null;
  } catch (error) {
    if (!(error instanceof BrowserSiteAuthReadError)) throw error;
    return null;
  }
}

export class BigModelUsageService {
  /** Always queries the quota endpoint live — no server-side cache. */
  constructor(
    private readonly sqlite: SqliteStore = sqliteStoreSingleton,
    private readonly http: ProviderUsageHttpClient = usageHttpClient,
  ) {}

  async runUsageCheck(providerId: string): Promise<UsageResult> {
    const provider = this.sqlite.getProvider(providerId);
    if (!provider || !isBigModelProvider(provider)) {
      return { status: 'unsupported' };
    }

    const token = readBigModelBearer(this.sqlite);
    if (!token) {
      return { status: 'idle' };
    }

    // No exp claim in the BigModel JWT — rely on 401 for relogin.

    try {
      const response = await this.http.request({
        url: BIGMODEL_USAGE_URL,
        method: 'GET',
        redirectPolicy: 'error',
        headers: { accept: 'application/json' },
        prepareHopHeaders: (): Record<string, string> => ({ authorization: token }),
      });

      if (response.status === 401 || response.status === 403) {
        return { status: 'relogin' };
      }
      if (response.status < 200 || response.status >= 300) {
        return { status: 'error' };
      }

      const body = JSON.parse(response.body.toString('utf8')) as unknown;
      const summary = parseBigModelUsage(body);
      if (!summary) {
        return { status: 'no-plan' };
      }
      return { status: 'ready', summary, lastUpdated: summary.lastUpdated };
    } catch (err) {
      diagLog('BigModel usage query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'error' };
    }
  }
}

export const bigModelUsageService = new BigModelUsageService();
