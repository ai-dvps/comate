import '../test-utils/test-env.js';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { KimiUsageService, KIMI_GET_USAGES_URL, KIMI_SITE_KEY } from './kimi-usage-service.js';
import { applyProviderPreset } from './provider-presets.js';

type FetchImpl = typeof fetch;

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const REAL_USAGE = {
  totalQuota: { limit: '100', used: '49', remaining: '51' },
  usages: [
    {
      scope: 'FEATURE_CODING',
      detail: { limit: '100', used: '100', resetTime: '2026-07-29T08:20:53.375248Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', remaining: '100', resetTime: '2026-07-28T14:20:53.375248Z' },
        },
      ],
    },
  ],
};

describe('KimiUsageService', () => {
  let sqlite: SqliteStore;
  let svc: KimiUsageService;
  let realFetch: FetchImpl;
  let fetchInit: RequestInit | undefined;
  let fetchedUrls: string[];

  beforeEach(() => {
    sqlite = new SqliteStore(':memory:');
    svc = new KimiUsageService(sqlite);
    realFetch = global.fetch;
    fetchInit = undefined;
    fetchedUrls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function seedBearer(jwt: string): void {
    sqlite.setGlobalSiteAuth(
      KIMI_SITE_KEY,
      JSON.stringify({
        sessionContext: { cookies: [] },
        bearerToken: jwt,
        createdAt: 't',
        updatedAt: 't',
      }),
    );
  }

  function trackFetch(responder: (url: string) => Response): void {
    global.fetch = (((url: string, init?: RequestInit) => {
      fetchedUrls.push(url);
      fetchInit = init;
      return Promise.resolve(responder(url));
    }) as unknown) as FetchImpl;
  }

  function makeProvider(baseUrl: string): string {
    const configuration = baseUrl === 'https://api.kimi.com/coding' ? applyProviderPreset('kimi') : undefined;
    return sqlite.createProvider({ name: `Kimi-${baseUrl}`, baseUrl, authToken: 'sk-key', configuration }).id;
  }

  test('non-coding-plan provider (api.moonshot.cn) is unsupported', async () => {
    const id = makeProvider('https://api.moonshot.cn/v1');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'unsupported');
    assert.equal(fetchedUrls.length, 0);
  });

  test('coding-plan provider with no captured login is idle', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'idle');
    assert.equal(fetchedUrls.length, 0);
  });

  test('happy path returns a ready whitelist summary', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    trackFetch(() => jsonResponse(200, REAL_USAGE));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'ready');
    assert.equal(result.summary?.used, 100);
    assert.equal(result.summary?.total, 100);
    assert.equal(result.summary?.remaining, 0);
    assert.equal(result.summary?.resetDate, '2026-07-29T08:20:53.375248Z');
    assert.equal(result.summary?.rolling?.remaining, 100);
    assert.equal(fetchedUrls[0], KIMI_GET_USAGES_URL);
    assert.equal(fetchInit?.redirect, 'error');
    assert.equal((fetchInit?.headers as Record<string, string>).authorization.startsWith('Bearer '), true);
    assert.ok(fetchInit?.signal instanceof AbortSignal);
  });

  test('whitelist: account-identifying fields never reach the summary', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    trackFetch(() => jsonResponse(200, { ...REAL_USAGE, email: 'user@example.com', user_id: 'u-123', payment: 'card-cc-4242' }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'ready');
    assert.equal(result.summary?.used, 100);
    const serialized = JSON.stringify(result.summary);
    assert.equal(serialized.includes('user@example.com'), false);
    assert.equal(serialized.includes('u-123'), false);
    assert.equal(serialized.includes('card'), false);
  });

  test('401 from the billing endpoint surfaces relogin', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    trackFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'relogin');
  });

  test('an already-expired token surfaces relogin without calling the endpoint', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) - 1));
    trackFetch(() => jsonResponse(200, REAL_USAGE));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'relogin');
    assert.equal(fetchedUrls.length, 0);
  });

  test('a payload with no recognizable usage fields is no-plan', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    trackFetch(() => jsonResponse(200, { has_coding_plan: false }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'no-plan');
  });

  test('a network failure surfaces error', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    global.fetch = (() => Promise.reject(new Error('network down'))) as unknown as FetchImpl;
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'error');
  });

  test('the fetch URL is the hardcoded constant even under an attacker baseUrl', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    const provider = sqlite.getProvider(id)!;
    const configuration = structuredClone(provider.configuration!);
    configuration.endpoints.openai!.baseUrl = 'https://kimi.com.evil.attacker/';
    sqlite.updateProvider(id, { configuration });
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    trackFetch(() => jsonResponse(200, REAL_USAGE));
    await svc.runUsageCheck(id);
    assert.equal(fetchedUrls[0], KIMI_GET_USAGES_URL);
  });

  test('consecutive checks re-fetch live data (no server-side cache)', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    seedBearer(makeJwt(Math.floor(Date.now() / 1000) + 1e6));
    trackFetch(() => jsonResponse(200, REAL_USAGE));
    const first = await svc.runUsageCheck(id);
    const second = await svc.runUsageCheck(id);
    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    assert.equal(fetchedUrls.length, 2);
  });
});
