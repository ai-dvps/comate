import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authBindingSchema } from '@comate/api-contracts';

import type { BrowserSiteAuthEntry } from '../../models/workspace.js';
import {
  BrowserAuthBindingError,
  BrowserAuthBindingVault,
  cookieAppliesToUrl,
} from '../browser-auth-binding.js';

const remembered: BrowserSiteAuthEntry = {
  sessionContext: {
    cookies: [
      { name: 'sid', value: 'cookie-secret', domain: '.example.com', path: '/', secure: true },
      { name: 'admin', value: 'admin-secret', domain: '.example.com', path: '/admin', secure: true },
    ],
  },
  bearerToken: 'bearer-secret',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

describe('BrowserAuthBindingVault', () => {
  it('zeroizes ephemeral bindings at browser close, while an explicit exact-generation rebind survives', () => {
    let current: { entry: BrowserSiteAuthEntry; generation: string } | undefined;
    const vault = new BrowserAuthBindingVault({ readRemembered: () => current });
    const ephemeral = vault.capture('task-1', {
      siteKey: 'example.com',
      sourceOrigin: 'https://app.example.com',
      sessionContext: remembered.sessionContext,
      bearerToken: 'new-bearer',
    });
    vault.browserClosed('task-1');
    assert.throws(() => vault.resolve('task-1', ephemeral, 'https://app.example.com/api'),
      (error: unknown) => error instanceof BrowserAuthBindingError && error.code === 'auth_binding_stale');

    const rebound = vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://app.example.com',
      sessionContext: remembered.sessionContext, bearerToken: 'new-bearer',
    });
    current = { entry: remembered, generation: 'gen-1' };
    vault.rebindRemembered('task-1', rebound, { siteKey: 'example.com', generation: 'gen-1' });
    vault.browserClosed('task-1');
    assert.equal(vault.resolve('task-1', rebound, 'https://app.example.com/api').bearerToken, 'bearer-secret');

    current = { entry: remembered, generation: 'gen-2' };
    assert.throws(() => vault.resolve('task-1', rebound, 'https://app.example.com/api'),
      (error: unknown) => error instanceof BrowserAuthBindingError && error.code === 'auth_binding_stale');
    current = undefined;
    assert.throws(() => vault.resolve('task-1', rebound, 'https://app.example.com/api'),
      (error: unknown) => error instanceof BrowserAuthBindingError && error.code === 'auth_binding_stale');
  });

  it('keeps registrable-domain authorization separate from native applicability', () => {
    const vault = new BrowserAuthBindingVault();
    const id = vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://app.example.com',
      sessionContext: remembered.sessionContext, bearerToken: 'bearer-secret',
    });
    assert.equal(authBindingSchema.safeParse(id).success, true);
    const sibling = vault.resolve('task-1', id, 'https://api.example.com/v1');
    assert.equal(sibling.authorizedSiteKey, 'example.com');
    assert.equal(sibling.bearerToken, undefined, 'bearer is exact-origin only');
    assert.deepEqual(sibling.cookies.map((cookie) => cookie.name), ['sid']);
    assert.throws(() => vault.resolve('task-1', id, 'https://evil.test/v1'),
      (error: unknown) => error instanceof BrowserAuthBindingError && error.code === 'domain_not_authorized');
  });

  it('does not let pre-existing remembered state absorb bearer evidence captured later', () => {
    const withoutBearer = { ...remembered, bearerToken: undefined };
    const vault = new BrowserAuthBindingVault({
      readRemembered: () => ({ entry: withoutBearer, generation: 'gen-1' }),
    });
    const old = vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://app.example.com',
      sessionContext: remembered.sessionContext,
    });
    vault.rebindRemembered('task-1', old, { siteKey: 'example.com', generation: 'gen-1' });
    vault.capture('task-1', {
      siteKey: 'example.com', sourceOrigin: 'https://app.example.com',
      sessionContext: remembered.sessionContext, bearerToken: 'captured-later',
    });
    assert.equal(vault.resolve('task-1', old, 'https://app.example.com/api').bearerToken, undefined);
  });

  it('applies cookie domain, host-only, path, secure, expiry, prefix and partition rules conservatively', () => {
    const httpsAdmin = new URL('https://app.example.com/admin/x');
    assert.equal(cookieAppliesToUrl({ name: 'a', value: 'x', domain: '.example.com', path: '/admin', secure: true }, httpsAdmin), true);
    assert.equal(cookieAppliesToUrl({ name: 'a', value: 'x', domain: 'example.com', path: '/', secure: true }, httpsAdmin), false);
    assert.equal(cookieAppliesToUrl({ name: 'a', value: 'x', domain: '.example.com', path: '/api', secure: true }, httpsAdmin), false);
    assert.equal(cookieAppliesToUrl({ name: 'a', value: 'x', domain: '.example.com', path: '/', secure: true }, new URL('http://app.example.com/')), false);
    assert.equal(cookieAppliesToUrl({ name: 'a', value: 'x', domain: '.example.com', expires: 1 }, httpsAdmin), false);
    assert.equal(cookieAppliesToUrl({ name: '__Host-a', value: 'x', domain: '.example.com', path: '/', secure: true }, httpsAdmin), false);
    assert.equal(cookieAppliesToUrl({ name: 'a', value: 'x', domain: '.example.com', partitionKey: 'https://top.example' }, httpsAdmin), false);
  });
});
