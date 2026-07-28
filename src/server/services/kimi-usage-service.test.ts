import '../test-utils/test-env.js';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { ProviderUsageStore } from './provider-usage-store.js';
import { KimiUsageService, KIMI_GET_USAGES_URL } from './kimi-usage-service.js';
import { __setCredentialKey, deriveKeyFromPassphrase } from '../utils/credential-crypto.js';

type FetchImpl = typeof fetch;

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe('KimiUsageService', () => {
  let sqlite: SqliteStore;
  let usage: ProviderUsageStore;
  let svc: KimiUsageService;
  let realFetch: FetchImpl;
  let fetchedUrls: string[];

  beforeEach(() => {
    __setCredentialKey(deriveKeyFromPassphrase('test-key'));
    sqlite = new SqliteStore(':memory:');
    usage = new ProviderUsageStore(sqlite);
    svc = new KimiUsageService(sqlite, usage);
    realFetch = global.fetch;
    fetchedUrls = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
    __setCredentialKey(null);
  });

  function trackFetch(responder: (url: string) => Response): void {
    global.fetch = (((url: string) => {
      fetchedUrls.push(url);
      return Promise.resolve(responder(url));
    }) as unknown) as FetchImpl;
  }

  function makeProvider(baseUrl: string): string {
    return sqlite.createProvider({ name: `Kimi-${baseUrl}`, baseUrl, authToken: 'sk-key' }).id;
  }

  test('non-coding-plan provider (api.moonshot.cn) is unsupported', async () => {
    const id = makeProvider('https://api.moonshot.cn/v1');
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'unsupported');
    assert.equal(fetchedUrls.length, 0);
  });

  test('coding-plan provider with no captured token is idle', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'idle');
    assert.equal(fetchedUrls.length, 0);
  });

  test('happy path returns a ready whitelist summary', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) + 1e6), 1);
    trackFetch(() =>
      jsonResponse(200, {
        totalQuota: { limit: '100', used: '49', remaining: '51' },
        usages: [
          {
            scope: 'FEATURE_CODING',
            detail: { limit: '100', used: '100', resetTime: '2026-07-29T08:20:53.375248Z' },
          },
        ],
      }),
    );
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'ready');
    assert.equal(result.summary?.used, 49);
    assert.equal(result.summary?.total, 100);
    assert.equal(result.summary?.remaining, 51);
    assert.equal(result.summary?.resetDate, '2026-07-29T08:20:53.375248Z');
    assert.equal(fetchedUrls[0], KIMI_GET_USAGES_URL);
  });

  test('whitelist: account-identifying fields never reach the summary', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) + 1e6), 1);
    trackFetch(() =>
      jsonResponse(200, {
        totalQuota: { limit: '100', used: '49', remaining: '51' },
        usages: [
          {
            scope: 'FEATURE_CODING',
            detail: { limit: '100', used: '100', resetTime: '2026-07-29T08:20:53.375248Z' },
          },
        ],
        email: 'user@example.com',
        user_id: 'u-123',
        payment: 'card-cc-4242',
      }),
    );
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'ready');
    assert.equal(result.summary?.used, 49);
    const serialized = JSON.stringify(result.summary);
    assert.equal(serialized.includes('user@example.com'), false);
    assert.equal(serialized.includes('u-123'), false);
    assert.equal(serialized.includes('card'), false);
  });

  test('401 from the billing endpoint surfaces relogin', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) + 1e6), 1);
    trackFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'relogin');
  });

  test('an already-expired token surfaces relogin without calling the endpoint', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) - 1), 1);
    trackFetch(() => jsonResponse(200, { used: 1, total: 2 }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'relogin');
    assert.equal(fetchedUrls.length, 0);
  });

  test('a payload with no recognizable usage fields is no-plan', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) + 1e6), 1);
    trackFetch(() => jsonResponse(200, { has_coding_plan: false }));
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'no-plan');
  });

  test('a network failure surfaces error', async () => {
    const id = makeProvider('https://api.kimi.com/coding');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) + 1e6), 1);
    global.fetch = (() => Promise.reject(new Error('network down'))) as unknown as FetchImpl;
    const result = await svc.runUsageCheck(id);
    assert.equal(result.status, 'error');
  });

  test('the fetch URL is the hardcoded constant even under an attacker baseUrl', async () => {
    const id = makeProvider('https://kimi.com.evil.attacker/');
    usage.setToken(id, makeJwt(Math.floor(Date.now() / 1000) + 1e6), 1);
    trackFetch(() => jsonResponse(200, { used: 1, total: 2 }));
    await svc.runUsageCheck(id);
    assert.equal(fetchedUrls[0], KIMI_GET_USAGES_URL);
  });
});
