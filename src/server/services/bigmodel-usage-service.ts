import type { Provider } from '../models/provider.js';
import { providerUsageStore, type UsageSummary, type UsageStatus } from './provider-usage-store.js';
import { store as sqliteStoreSingleton } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { asRecord, asNum } from './kimi-usage-service.js';
import { diagLog } from '../utils/diag-logger.js';

export const BIGMODEL_LOGIN_URL = 'https://bigmodel.cn';
export const BIGMODEL_USAGE_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
export const BIGMODEL_SITE_KEY = 'bigmodel.cn';
/** The cookie name that holds the BigModel access JWT. */
export const BIGMODEL_TOKEN_COOKIE = 'bigmodel_token_production';

const USAGE_TIMEOUT_MS = 8000;

export function isBigModelProvider(provider?: Provider): boolean {
  if (!provider) return false;
  return provider.baseUrl.toLowerCase().includes('bigmodel.cn');
}

export interface UsageResult {
  status: UsageStatus;
  summary?: UsageSummary;
  lastUpdated?: string;
}

/**
 * Parse the BigModel `quota/limit` response. The `data.limits` array has
 * entries by `type`; `TIME_LIMIT` carries the monthly MCP quota with absolute
 * used/total/remaining; `TOKENS_LIMIT` entries carry percentages only (5h,
 * weekly) and are deferred for now.
 */
function parseBigModelUsage(body: unknown): UsageSummary | null {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  if (!data) return null;
  const limits = Array.isArray(data.limits) ? (data.limits as unknown[]) : [];
  const monthly = asRecord(limits.find((l) => asRecord(l)?.type === 'TIME_LIMIT'));
  if (!monthly) return null;

  const used = asNum(monthly.currentValue);
  const total = asNum(monthly.usage);
  const remaining = asNum(monthly.remaining);
  const resetMs = asNum(monthly.nextResetTime);
  const resetDate = resetMs !== null ? new Date(resetMs).toISOString() : null;

  if (used === null && total === null && remaining === null) return null;
  return { used, total, remaining, resetDate, rolling: null, lastUpdated: new Date().toISOString() };
}

/** Read the captured BigModel bearer from global_site_auth. */
function readBigModelBearer(sqlite: SqliteStore): string | null {
  const json = sqlite.getGlobalSiteAuth(BIGMODEL_SITE_KEY);
  if (!json) return null;
  try {
    const entry = JSON.parse(json) as { bearerToken?: string };
    return entry.bearerToken && entry.bearerToken.length > 0 ? entry.bearerToken : null;
  } catch {
    return null;
  }
}

export class BigModelUsageService {
  constructor(
    private readonly sqlite: SqliteStore = sqliteStoreSingleton,
    private readonly cache = providerUsageStore,
  ) {}

  async runUsageCheck(providerId: string): Promise<UsageResult> {
    const provider = this.sqlite.getProvider(providerId);
    if (!provider || !isBigModelProvider(provider)) {
      return { status: 'unsupported' };
    }

    const cached = this.cache.getCachedUsage(providerId);
    if (cached && !this.cache.isStale(cached)) {
      return { status: 'ready', summary: cached, lastUpdated: cached.lastUpdated };
    }

    const token = readBigModelBearer(this.sqlite);
    if (!token) {
      return { status: 'idle' };
    }

    // No exp claim in the BigModel JWT — rely on 401 for relogin.

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
      const response = await fetch(BIGMODEL_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: token,
          Accept: 'application/json',
        },
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
      const summary = parseBigModelUsage(body);
      if (!summary) {
        return { status: 'no-plan' };
      }
      this.cache.setCachedUsage(providerId, summary);
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
