import '../test-utils/test-env.js';
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../storage/sqlite-store.js';
import { readGlobalSiteAuthEntry } from './browser-site-auth.js';

describe('global site-auth store', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  test('round-trips an entry by site key (with bearerToken)', () => {
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
    assert.equal(got!.includes('jwt-value'), false, 'raw SQLite row is an encrypted envelope');
    assert.equal(readGlobalSiteAuthEntry(store, 'kimi.com')!.entry.bearerToken, 'jwt-value');
    store.clearGlobalSiteAuth('kimi.com');
    assert.equal(store.getGlobalSiteAuth('kimi.com'), null);
  });
});
