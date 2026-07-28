import '../test-utils/test-env.js';
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import {
  ProviderUsageLoginService,
  UsageLoginError,
  type UsageBrowserSurface,
} from './provider-usage-login-service.js';
import { KIMI_LOGIN_URL } from './kimi-usage-service.js';

const ORIGIN = 'location.hostname';

function fakeBrowser(opts: { origin?: string; extracted?: unknown; extractThrows?: boolean } = {}) {
  const origin = opts.origin ?? 'www.kimi.com';
  const extracted: unknown = Object.prototype.hasOwnProperty.call(opts, 'extracted')
    ? opts.extracted
    : 'a.eyJleHA6OTk5OTk5OTk5fQ.c';
  const calls = {
    ensureSession: [] as Array<Record<string, unknown>>,
    evaluate: [] as string[],
    navigate: [] as string[],
    setControlState: [] as string[],
    teardown: [] as string[],
    rememberGlobal: [] as Array<{ siteKey: string; bearerToken?: string }>,
  };
  const browser: UsageBrowserSurface = {
    async ensureSession(input) {
      calls.ensureSession.push(input);
      return { sessionId: input.sessionId };
    },
    async navigateInSession(_sid, url) {
      calls.navigate.push(url);
    },
    async rememberGlobalSiteAuth(_sid, siteKey, bearerToken) {
      calls.rememberGlobal.push({ siteKey, bearerToken });
    },
    async evaluateInSession(_sid, expr) {
      calls.evaluate.push(expr);
      if (expr === ORIGIN) return origin;
      if (opts.extractThrows && expr.includes('localStorage')) throw new Error('cdp blew up');
      if (expr.includes('localStorage')) return extracted;
      return null;
    },
    async setControlState(_sid, state) {
      calls.setControlState.push(state);
    },
    async teardownSession(sid) {
      calls.teardown.push(sid);
    },
  };
  return { browser, calls };
}

describe('ProviderUsageLoginService', () => {
  let sqlite: SqliteStore;

  beforeEach(() => {
    sqlite = new SqliteStore(':memory:');
  });

  function makeKimiProvider(): string {
    return sqlite.createProvider({ name: 'Kimi', baseUrl: 'https://api.kimi.com/coding', authToken: 'sk' }).id;
  }

  test('startLogin rejects a non-coding-plan provider', async () => {
    const id = sqlite.createProvider({ name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', authToken: 'sk' }).id;
    const { browser } = fakeBrowser();
    const svc = new ProviderUsageLoginService(sqlite, browser);
    await assert.rejects(() => svc.startLogin(id), (err: unknown) => err instanceof UsageLoginError);
  });

  test('startLogin opens a transient session, navigates to the hardcoded URL, and yields control', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser();
    const svc = new ProviderUsageLoginService(sqlite, browser);
    const result = await svc.startLogin(id);
    assert.equal(result.sessionId, `usage-login-${id}`);
    assert.equal(calls.ensureSession[0]?.transient, true);
    assert.equal(calls.setControlState[0], 'user_in_control');
    assert.equal(calls.navigate.includes(KIMI_LOGIN_URL), true);
  });

  test('finalizeLogin stores the login globally and tears down', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ extracted: 'jwt-value' });
    const svc = new ProviderUsageLoginService(sqlite, browser);
    const result = await svc.finalizeLogin(id);
    assert.equal(result.status, 'ready');
    assert.deepEqual(calls.rememberGlobal[0], { siteKey: 'kimi.com', bearerToken: 'jwt-value' });
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin aborts on wrong origin: no global write, teardown still runs', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ origin: 'evil.example.com', extracted: 'jwt-value' });
    const svc = new ProviderUsageLoginService(sqlite, browser);
    const result = await svc.finalizeLogin(id);
    assert.deepEqual(result, { status: 'relogin', reason: 'wrong-origin' });
    assert.equal(calls.rememberGlobal.length, 0);
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin with no extractable token surfaces no-token-found', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ extracted: null });
    const svc = new ProviderUsageLoginService(sqlite, browser);
    const result = await svc.finalizeLogin(id);
    assert.deepEqual(result, { status: 'relogin', reason: 'no-token-found' });
    assert.equal(calls.rememberGlobal.length, 0);
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin tears down even when extraction throws', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ extractThrows: true });
    const svc = new ProviderUsageLoginService(sqlite, browser);
    await assert.rejects(() => svc.finalizeLogin(id));
    assert.equal(calls.teardown.length, 1);
    assert.equal(calls.rememberGlobal.length, 0);
  });

  test('cancelLogin tears the capture session down', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser();
    const svc = new ProviderUsageLoginService(sqlite, browser);
    await svc.cancelLogin(id);
    assert.equal(calls.teardown.length, 1);
  });
});
