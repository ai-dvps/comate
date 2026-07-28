import '../test-utils/test-env.js';
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { ProviderUsageStore, type UsageSummary } from './provider-usage-store.js';

function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    used: 1,
    total: 10,
    remaining: 9,
    resetDate: null,
    rolling: null,
    lastUpdated: new Date().toISOString(),
    ...over,
  };
}

describe('ProviderUsageStore', () => {
  let store: SqliteStore;
  let usage: ProviderUsageStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    usage = new ProviderUsageStore();
  });

  test('cache set/get', () => {
    const s = summary({ used: 3 });
    usage.setCachedUsage('p1', s);
    assert.deepEqual(usage.getCachedUsage('p1'), s);
    assert.equal(usage.getCachedUsage('p2'), null);
  });

  test('cache staleness uses the 24h threshold', () => {
    const fresh = summary();
    const stale = summary({ lastUpdated: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    assert.equal(usage.isStale(fresh), false);
    assert.equal(usage.isStale(stale), true);
    assert.equal(usage.isStale(null), true);
  });

  test('global site-auth store round-trips an entry by site key (with bearerToken)', () => {
    assert.equal(store.getGlobalSiteAuth('kimi.com'), null);
    store.setGlobalSiteAuth(
      'kimi.com',
      JSON.stringify({
        sessionContext: { cookies: [], localStorage: {}, sessionStorage: {} },
        bearerToken: 'jwt-value',
        createdAt: 't',
        updatedAt: 't',
      }),
    );
    const got = store.getGlobalSiteAuth('kimi.com');
    assert.ok(got !== null);
    assert.equal((JSON.parse(got as string) as { bearerToken: string }).bearerToken, 'jwt-value');
    store.clearGlobalSiteAuth('kimi.com');
    assert.equal(store.getGlobalSiteAuth('kimi.com'), null);
  });
});
