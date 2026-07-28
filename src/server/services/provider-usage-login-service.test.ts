import '../test-utils/test-env.js';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { ProviderUsageStore } from './provider-usage-store.js';
import {
  ProviderUsageLoginService,
  UsageLoginError,
  type UsageBrowserSurface,
} from './provider-usage-login-service.js';
import { KIMI_LOGIN_URL } from './kimi-usage-service.js';
import { __setCredentialKey, deriveKeyFromPassphrase } from '../utils/credential-crypto.js';

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
  };
  const browser: UsageBrowserSurface = {
    async ensureSession(input) {
      calls.ensureSession.push(input);
      return { sessionId: input.sessionId };
    },
    async navigateInSession(_sid, url) {
      calls.navigate.push(url);
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
  let usage: ProviderUsageStore;

  beforeEach(() => {
    __setCredentialKey(deriveKeyFromPassphrase('test-key'));
    sqlite = new SqliteStore(':memory:');
    usage = new ProviderUsageStore(sqlite);
  });
  afterEach(() => __setCredentialKey(null));

  function makeKimiProvider(): string {
    return sqlite.createProvider({ name: 'Kimi', baseUrl: 'https://api.kimi.com/coding', authToken: 'sk' }).id;
  }

  test('startLogin rejects a non-coding-plan provider', async () => {
    const id = sqlite.createProvider({ name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', authToken: 'sk' }).id;
    const { browser } = fakeBrowser();
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    await assert.rejects(() => svc.startLogin(id), (err: unknown) => err instanceof UsageLoginError);
  });

  test('startLogin opens a transient session, navigates to the hardcoded URL, and yields control', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser();
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    const result = await svc.startLogin(id);
    assert.equal(result.sessionId, `usage-login-${id}`);
    assert.equal(calls.ensureSession[0]?.transient, true);
    assert.equal(calls.setControlState[0], 'user_in_control');
    // Navigates via CDP Page.navigate (Steel-tracked), not evaluate(location.href).
    assert.equal(calls.navigate.includes(KIMI_LOGIN_URL), true);
    assert.equal(calls.evaluate.some((e) => e.includes('location.href')), false);
  });

  test('finalizeLogin happy path: stores the token and tears down', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ extracted: 'jwt-value' });
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    const result = await svc.finalizeLogin(id, 1);
    assert.equal(result.status, 'ready');
    assert.equal(usage.getToken(id), 'jwt-value');
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin aborts on wrong origin: no token stored, teardown still runs', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ origin: 'evil.example.com', extracted: 'jwt-value' });
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    const result = await svc.finalizeLogin(id, 1);
    assert.deepEqual(result, { status: 'relogin', reason: 'wrong-origin' });
    assert.equal(usage.getToken(id), null);
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin with no extractable token surfaces no-token-found', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ extracted: null });
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    const result = await svc.finalizeLogin(id, 1);
    assert.deepEqual(result, { status: 'relogin', reason: 'no-token-found' });
    assert.equal(usage.getToken(id), null);
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin superseded by a newer capture does not overwrite', async () => {
    const id = makeKimiProvider();
    usage.setToken(id, 'newer', 5);
    const { browser, calls } = fakeBrowser({ extracted: 'older-attempt' });
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    const result = await svc.finalizeLogin(id, 3);
    assert.deepEqual(result, { status: 'relogin', reason: 'superseded' });
    assert.equal(usage.getToken(id), 'newer');
    assert.equal(calls.teardown.length, 1);
  });

  test('finalizeLogin tears down even when extraction throws', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser({ extractThrows: true });
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    await assert.rejects(() => svc.finalizeLogin(id, 1));
    assert.equal(calls.teardown.length, 1);
    assert.equal(usage.getToken(id), null);
  });

  test('cancelLogin tears the capture session down', async () => {
    const id = makeKimiProvider();
    const { browser, calls } = fakeBrowser();
    const svc = new ProviderUsageLoginService(sqlite, browser, usage);
    await svc.cancelLogin(id);
    assert.equal(calls.teardown.length, 1);
  });
});
