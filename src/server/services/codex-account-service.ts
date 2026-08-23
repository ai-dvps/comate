import type { GetAccountResponse } from '../generated/codex-protocol/v2/GetAccountResponse.js';
import type { GetAccountRateLimitsResponse } from '../generated/codex-protocol/v2/GetAccountRateLimitsResponse.js';
import type { GetAccountTokenUsageResponse } from '../generated/codex-protocol/v2/GetAccountTokenUsageResponse.js';
import type { LoginAccountParams } from '../generated/codex-protocol/v2/LoginAccountParams.js';
import type { LoginAccountResponse } from '../generated/codex-protocol/v2/LoginAccountResponse.js';
import type { ModelListResponse } from '../generated/codex-protocol/v2/ModelListResponse.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';

export interface CodexAccountUsageSnapshot {
  rateLimit: {
    limitId: string | null;
    limitName: string | null;
    primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
    secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
    planType: string | null;
    spendControlReached: boolean | null;
    rateLimitReachedType: string | null;
  } | null;
  tokenUsage: {
    lifetimeTokens: string | null;
    peakDailyTokens: string | null;
    currentStreakDays: string | null;
    longestStreakDays: string | null;
    dailyUsageBuckets: Array<{ startDate: string; tokens: string }>;
  } | null;
}

export class CodexAccountService {
  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

  async read(): Promise<GetAccountResponse> {
    return this.manager.request('account/read', {});
  }

  async login(params: LoginAccountParams): Promise<LoginAccountResponse> {
    return this.manager.request('account/login/start', params);
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.manager.request('account/login/cancel', { loginId });
  }

  async logout(): Promise<void> {
    await this.manager.request('account/logout');
  }

  async listModels(): Promise<ModelListResponse> {
    return this.manager.request('model/list', {});
  }

  async usage(): Promise<CodexAccountUsageSnapshot> {
    const [limitsResult, tokensResult] = await Promise.allSettled([
      this.manager.request<GetAccountRateLimitsResponse>('account/rateLimits/read'),
      this.manager.request<GetAccountTokenUsageResponse>('account/usage/read', {}),
    ]);
    if (limitsResult.status === 'rejected' && tokensResult.status === 'rejected') {
      throw limitsResult.reason;
    }
    const limits = limitsResult.status === 'fulfilled' ? limitsResult.value : null;
    const tokens = tokensResult.status === 'fulfilled' ? tokensResult.value : null;
    const snapshot = limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits ?? null;
    return {
      rateLimit: snapshot ? {
        limitId: snapshot.limitId,
        limitName: snapshot.limitName,
        primary: snapshot.primary,
        secondary: snapshot.secondary,
        credits: snapshot.credits,
        planType: snapshot.planType,
        spendControlReached: snapshot.spendControlReached,
        rateLimitReachedType: typeof snapshot.rateLimitReachedType === 'string'
          ? snapshot.rateLimitReachedType
          : null,
      } : null,
      tokenUsage: tokens ? {
        lifetimeTokens: bigintString(tokens.summary.lifetimeTokens),
        peakDailyTokens: bigintString(tokens.summary.peakDailyTokens),
        currentStreakDays: bigintString(tokens.summary.currentStreakDays),
        longestStreakDays: bigintString(tokens.summary.longestStreakDays),
        dailyUsageBuckets: (tokens.dailyUsageBuckets ?? []).map((bucket) => ({
          startDate: bucket.startDate,
          tokens: bucket.tokens.toString(),
        })),
      } : null,
    };
  }
}

function bigintString(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

export const codexAccountService = new CodexAccountService();
