import '../test-utils/test-env.js';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { BigModelUsageService, BIGMODEL_SITE_KEY } from './bigmodel-usage-service.js';
import { applyProviderPreset } from './provider-presets.js';

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
  let svc: BigModelUsageService;
  let realFetch: FetchImpl;
  let fetchInit: RequestInit | undefined;
  let fetchHeaders: Record<string, string> | undefined;
  let fetchedUrls: string[];

  beforeEach(() => {
    sqlite = new SqliteStore(':memory:');
    svc = new BigModelUsageService(sqlite);
    realFetch = global.fetch;
    fetchInit = undefined;
    fetchHeaders = undefined;
    fetchedUrls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function seedBearer(token: string): void {
    sqlite.setGlobalSiteAuth(BIGMODEL_SITE_KEY, JSON.stringify({
      sessionContext: { cookies: [] },
      bearerToken: token,
      createdAt: 't',
      updatedAt: 't',
    }));
  }

  function trackFetch(responder: (url: string) => Response): void {
    global.fetch = (((url: string, init?: RequestInit) => {
      fetchedUrls.push(url);
      fetchInit = init;
      fetchHeaders = init?.headers as Record<string, string> | undefined;
      return Promise.resolve(responder(url));
    }) as unknown) as FetchImpl;
  }

  function makeProvider(baseUrl: string, authToken = 'sk-key'): string {
    const configuration = baseUrl.includes('bigmodel.cn') ? applyProviderPreset('bigmodel') : undefined;
    return sqlite.createProvider({ name: `BM-${baseUrl}`, baseUrl, authToken, configuration }).id;
  }

  test('non-bigmodel provider is unsupported', async () => {
    const id = makeProvider('https://api.openai.com/v1');
    seedBearer('some-token');
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'unsupported');
  });

  test('provider credential queries the API quota endpoint without a captured web login', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'ready');
    assert.deepEqual(fetchedUrls, ['https://open.bigmodel.cn/api/monitor/usage/quota/limit']);
    assert.equal(fetchHeaders?.authorization, 'sk-key');
    assert.equal(fetchInit?.method, 'GET');
    assert.equal(fetchInit?.body, undefined);
  });

  test('missing provider credential is an error without fetching or requesting web login', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic', '   ');
    seedBearer('stale-web-token');
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    assert.equal((await svc.runUsageCheck(id)).status, 'error');
    assert.equal(fetchedUrls.length, 0);
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

  test('saved web token does not override the raw provider API key', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    await svc.runUsageCheck(id);
    assert.equal(fetchHeaders?.authorization, 'sk-key');
    assert.equal(fetchInit?.redirect, 'error');
    assert.ok(fetchInit?.signal instanceof AbortSignal);
  });

  test('401 and 403 surface credential errors rather than an unrelated web relogin', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    for (const status of [401, 403]) {
      trackFetch(() => jsonResponse(status, { code: status }));
      assert.equal((await svc.runUsageCheck(id)).status, 'error');
    }
  });

  test('a valid quota response with no coding limits is no-plan', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(200, { code: 200, data: { limits: [], level: 'free' } }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'no-plan');
  });

  test('empty or malformed HTTP 200 responses are errors, not evidence of no coding plan', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    for (const response of [
      new Response('', { status: 200 }),
      jsonResponse(200, null),
      jsonResponse(200, {}),
      jsonResponse(200, { data: {} }),
      jsonResponse(200, { data: { limits: {} } }),
      jsonResponse(200, { success: false, data: { limits: [] } }),
      jsonResponse(200, { code: 401, data: { limits: [] } }),
    ]) {
      trackFetch(() => response);
      assert.equal((await svc.runUsageCheck(id)).status, 'error');
    }
  });

  test('editable endpoint URLs cannot redirect the provider credential', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    const configuration = structuredClone(sqlite.getProvider(id)!.configuration!);
    configuration.endpoints.anthropic!.baseUrl = 'https://attacker.example/';
    sqlite.updateProvider(id, { configuration });
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    await svc.runUsageCheck(id);
    assert.deepEqual(fetchedUrls, ['https://open.bigmodel.cn/api/monitor/usage/quota/limit']);
  });

  test('network failure surfaces error', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    global.fetch = (() => Promise.reject(new Error('network'))) as unknown as FetchImpl;
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'error');
  });

  test('consecutive checks re-fetch live data (no server-side cache)', async () => {
    const id = makeProvider('https://open.bigmodel.cn/api/anthropic');
    seedBearer('bm-token');
    trackFetch(() => jsonResponse(200, REAL_RESPONSE));
    const first = await svc.runUsageCheck(id);
    const second = await svc.runUsageCheck(id);
    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    assert.equal(fetchedUrls.length, 2);
  });
});
