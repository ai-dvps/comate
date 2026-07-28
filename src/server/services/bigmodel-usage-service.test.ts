import '../test-utils/test-env.js';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { ProviderUsageStore } from './provider-usage-store.js';
import { BigModelUsageService, BIGMODEL_SITE_KEY } from './bigmodel-usage-service.js';

type FetchImpl = typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const REAL_RESPONSE = {
  code: 200,
  msg: '操作成功',
  success: true,
  data: {
    limits: [
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 37,
        remaining: 3963,
        percentage: 1,
        nextResetTime: 1786520297981,
        usageDetails: [{ modelCode: 'search-prime', usage: 37 }],
      },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 33, nextResetTime: 1785261812073 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 63, nextResetTime: 1785483497998 },
    ],
    level: 'max',
  },
};

describe('BigModelUsageService', () => {
  let sqlite: SqliteStore;
  let usage: ProviderUsageStore;
  let svc: BigModelUsageService;
  let realFetch: FetchImpl;
  let fetchHeaders: Record<string, string> | undefined;

  beforeEach(() => {
    sqlite = new SqliteStore(':memory:');
    usage = new ProviderUsageStore();
    svc = new BigModelUsageService(sqlite, usage);
    realFetch = global.fetch;
    fetchHeaders = undefined;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function seedBearer(token: string): void {
    sqlite.setGlobalSiteAuth(BIGMODEL_SITE_KEY, JSON.stringify({ bearerToken: token }));
  }

  function trackFetch(responder: (url: string) => Response): void {
    global.fetch = (((url: string, init?: RequestInit) => {
      fetchHeaders = init?.headers as Record<string, string> | undefined;
      return Promise.resolve(responder(url));
    }) as unknown) as FetchImpl;
  }

  function makeProvider(baseUrl: string): string {
    return sqlite.createProvider({ name: `BM-${baseUrl}`, baseUrl, authToken: 'sk-key' }).id;
  }

  test('non-bigmodel provider is unsupported', async () => {
    const id = makeProvider('https://api.openai.com/v1');
    seedBearer('some-token');
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'unsupported');
  });

  test('bigmodel provider with no captured login is idle', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'idle');
  });

  test('happy path returns a ready summary from weekly + 5h coding limits', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'ready');
    // Primary: weekly (unit 6) percentage 63 → mapped to /100.
    assert.equal(result.summary?.used, 63);
    assert.equal(result.summary?.total, 100);
    assert.equal(result.summary?.remaining, 37);
    assert.ok(result.summary?.resetDate);
    // Rolling: 5h (unit 3) percentage 33 → remaining 67.
    assert.equal(result.summary?.rolling?.remaining, 67);
  });

  test('auth is raw token (no Bearer prefix)', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    await svc.runUsageCheck(id);
    assert.equal(fetchHeaders?.Authorization, 'bm-token');
  });

  test('401 surfaces relogin', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(401, { code: 401 }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'relogin');
  });

  test('a response with no TIME_LIMIT is no-plan', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(200, { code: 200, data: { limits: [], level: 'free' } }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'no-plan');
  });

  test('network failure surfaces error', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    global.fetch = (() => Promise.reject(new Error('network'))) as unknown as FetchImpl;
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'error');
  });
});
