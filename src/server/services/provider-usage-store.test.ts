import '../test-utils/test-env.js';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { ProviderUsageStore } from './provider-usage-store.js';
import { __setCredentialKey, deriveKeyFromPassphrase } from '../utils/credential-crypto.js';

describe('ProviderUsageStore', () => {
  let store: SqliteStore;
  let usage: ProviderUsageStore;

  beforeEach(() => {
    __setCredentialKey(deriveKeyFromPassphrase('test-key'));
    store = new SqliteStore(':memory:');
    usage = new ProviderUsageStore(store);
  });

  afterEach(() => {
    __setCredentialKey(null);
  });

  test('round-trips an encrypted token per provider', () => {
    assert.equal(usage.setToken('p1', 'jwt-abc', 1), true);
    assert.equal(usage.getToken('p1'), 'jwt-abc');
    assert.equal(usage.hasToken('p1'), true);
  });

  test('returns null when no token is stored and does not throw', () => {
    assert.equal(usage.getToken('missing'), null);
    assert.equal(usage.hasToken('missing'), false);
  });

  test('tokens are isolated per provider', () => {
    usage.setToken('p1', 'jwt-1', 1);
    usage.setToken('p2', 'jwt-2', 1);
    assert.equal(usage.getToken('p1'), 'jwt-1');
    assert.equal(usage.getToken('p2'), 'jwt-2');
  });

  test('tampered ciphertext is treated as absent (no throw, no plaintext leak)', () => {
    usage.setToken('p1', 'jwt-abc', 1);
    // Corrupt the on-disk ciphertext directly, bypassing the service.
    store.setProviderUsageToken('p1', 'not-valid-ciphertext');
    // A cold service (empty in-memory cache) must not surface plaintext.
    const cold = new ProviderUsageStore(store);
    assert.equal(cold.getToken('p1'), null);
  });

  test('identity guard: a stale capture id does not overwrite a newer token', () => {
    assert.equal(usage.setToken('p1', 'newer', 5), true);
    assert.equal(usage.setToken('p1', 'stale-attempt', 3), false);
    assert.equal(usage.getToken('p1'), 'newer');
  });

  test('identity guard: a newer capture id overwrites', () => {
    usage.setToken('p1', 'first', 1);
    usage.setToken('p1', 'second', 2);
    assert.equal(usage.getToken('p1'), 'second');
  });

  test('clearToken removes the token and cached usage', () => {
    usage.setToken('p1', 'jwt', 1);
    usage.setCachedUsage('p1', {
      used: 1,
      total: 10,
      remaining: 9,
      resetDate: null,
      lastUpdated: new Date().toISOString(),
    });
    usage.clearToken('p1');
    assert.equal(usage.getToken('p1'), null);
    assert.equal(usage.getCachedUsage('p1'), null);
  });

  test('cache staleness uses the 24h threshold', () => {
    const fresh: UsageSummaryLike = {
      used: 1,
      total: 10,
      remaining: 9,
      resetDate: null,
      lastUpdated: new Date().toISOString(),
    };
    const stale: UsageSummaryLike = {
      ...fresh,
      lastUpdated: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    assert.equal(usage.isStale(fresh), false);
    assert.equal(usage.isStale(stale), true);
    assert.equal(usage.isStale(null), true);
  });

  test('the usage token never leaks through provider rows', () => {
    const provider = store.createProvider({
      name: 'Kimi',
      baseUrl: 'https://api.kimi.com/coding',
      authToken: 'sk-coding-key',
    });
    usage.setToken(provider.id, 'jwt-secret-value', 1);
    const providers = store.listProviders();
    const serialized = JSON.stringify(providers);
    assert.equal(serialized.includes('jwt-secret-value'), false);
    assert.equal(serialized.includes('sk-coding-key'), true); // sanity: provider data is present
  });
});

interface UsageSummaryLike {
  used: number | null;
  total: number | null;
  remaining: number | null;
  resetDate: string | null;
  lastUpdated: string;
}
