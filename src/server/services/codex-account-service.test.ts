import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CodexAccountService } from './codex-account-service.js';
import type { CodexAppServerManager } from './codex-app-server-manager.js';

describe('CodexAccountService usage', () => {
  it('combines rate limits with JSON-safe account token activity', async () => {
    const manager = {
      request: async (method: string) => {
        if (method === 'account/rateLimits/read') {
          return {
            rateLimits: {
              limitId: 'codex',
              limitName: 'Codex',
              primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
              credits: { hasCredits: true, unlimited: false, balance: '12.50' },
              individualLimit: null,
              spendControlReached: false,
              planType: 'plus',
              rateLimitReachedType: null,
            },
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          };
        }
        if (method === 'account/usage/read') {
          return {
            summary: {
              lifetimeTokens: 9_007_199_254_740_993n,
              peakDailyTokens: 4_200n,
              longestRunningTurnSec: 90n,
              currentStreakDays: 3n,
              longestStreakDays: 8n,
            },
            dailyUsageBuckets: [{ startDate: '2026-08-22', tokens: 1_234n }],
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerManager;

    const usage = await new CodexAccountService(manager).usage();

    assert.deepStrictEqual(usage, {
      rateLimit: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        planType: 'plus',
        spendControlReached: false,
        rateLimitReachedType: null,
      },
      tokenUsage: {
        lifetimeTokens: '9007199254740993',
        peakDailyTokens: '4200',
        currentStreakDays: '3',
        longestStreakDays: '8',
        dailyUsageBuckets: [{ startDate: '2026-08-22', tokens: '1234' }],
      },
    });
    assert.doesNotThrow(() => JSON.stringify(usage));
  });

  it('preserves rate-limit data when token activity is unavailable', async () => {
    const manager = {
      request: async (method: string) => {
        if (method === 'account/rateLimits/read') {
          return {
            rateLimits: {
              limitId: 'codex', limitName: 'Codex',
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
              secondary: null, credits: null, individualLimit: null,
              spendControlReached: false, planType: 'plus', rateLimitReachedType: null,
            },
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          };
        }
        throw new Error('token activity unavailable');
      },
    } as unknown as CodexAppServerManager;

    const usage = await new CodexAccountService(manager).usage();

    assert.strictEqual(usage.rateLimit?.primary?.usedPercent, 12);
    assert.strictEqual(usage.tokenUsage, null);
  });

  it('preserves token activity when rate limits are unavailable', async () => {
    const manager = {
      request: async (method: string) => {
        if (method === 'account/usage/read') {
          return {
            summary: {
              lifetimeTokens: 1_234n, peakDailyTokens: null,
              longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null,
            },
            dailyUsageBuckets: null,
          };
        }
        throw new Error('rate limits unavailable');
      },
    } as unknown as CodexAppServerManager;

    const usage = await new CodexAccountService(manager).usage();

    assert.strictEqual(usage.rateLimit, null);
    assert.strictEqual(usage.tokenUsage?.lifetimeTokens, '1234');
  });

  it('fails when neither usage source is available', async () => {
    const manager = {
      request: async (method: string) => {
        throw new Error(method === 'account/rateLimits/read'
          ? 'rate limits unavailable'
          : 'token activity unavailable');
      },
    } as unknown as CodexAppServerManager;

    await assert.rejects(
      new CodexAccountService(manager).usage(),
      /rate limits unavailable/,
    );
  });
});
