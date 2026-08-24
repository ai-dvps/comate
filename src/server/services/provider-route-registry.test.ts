import '../test-utils/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProviderRouteRegistry,
  ProviderRouteRegistryError,
  type ProviderRouteUpstreamSnapshot,
} from './provider-route-registry.js';

function upstream(id: string, credential = `provider-secret-${id}`): ProviderRouteUpstreamSnapshot {
  return {
    providerId: id,
    baseUrl: 'https://api.example.com/v1',
    credential,
    model: `${id}-model`,
    effortWireMapping: { high: 'high' },
  };
}

describe('ProviderRouteRegistry', () => {
  it('accepts HTTP internal upstreams and fails closed for unsafe URL structure', () => {
    const registry = new ProviderRouteRegistry();
    const lease = registry.register({
      sessionId: 's1', generation: 'g1',
      upstream: { providerId: 'p1', baseUrl: 'http://127.0.0.1:8080/v1', credential: 'secret', model: 'm1' },
    });
    assert.ok(registry.authorize(lease.routeId, lease.bearer));
    assert.throws(
      () => registry.register({
        sessionId: 's2', generation: 'g2',
        upstream: { providerId: 'p1', baseUrl: 'ftp://llm.internal/v1', credential: 'secret', model: 'm1' },
      }),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'route_unavailable',
    );
    assert.throws(
      () => registry.register({
        sessionId: 's4', generation: 'g4',
        upstream: { providerId: 'p1', baseUrl: 'http://llm.internal:0/v1', credential: 'secret', model: 'm1' },
      }),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'route_unavailable',
    );
    assert.throws(
      () => registry.register({
        sessionId: 's3', generation: 'g3',
        upstream: { providerId: 'p1', baseUrl: 'http://user:pass@llm.internal/v1', credential: 'secret', model: 'm1' },
      }),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'route_unavailable',
    );
    assert.deepEqual(registry.processStatus(), {
      leases: 1, activeRequests: 0, historyBytes: 0, bufferedResponseBytes: 0,
    });
  });

  it('mints isolated opaque capabilities, retains only their digest, and freezes upstream configuration', () => {
    const registry = new ProviderRouteRegistry();
    const snapshot = upstream('p1');
    const first = registry.register({ sessionId: 's1', generation: 'g1', upstream: snapshot });
    const second = registry.register({ sessionId: 's2', generation: 'g1', upstream: upstream('p1') });

    assert.notEqual(first.routeId, second.routeId);
    assert.notEqual(first.bearer, second.bearer);
    assert.throws(
      () => registry.register({ sessionId: 's1', generation: 'g1', upstream: upstream('p1') }),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'route_unavailable',
    );
    assert.equal(registry.authorize(first.routeId, second.bearer), null);
    const authorized = registry.authorize(first.routeId, first.bearer);
    assert.ok(authorized);
    snapshot.baseUrl = 'https://attacker.example/v1';
    snapshot.credential = 'changed';
    assert.equal(authorized.upstream.baseUrl, 'https://api.example.com/v1');
    assert.equal(authorized.upstream.credential, 'provider-secret-p1');
    const safeStatus = JSON.stringify(registry.status(first));
    assert.doesNotMatch(safeStatus, /provider-secret|api\.example|cap_/);

    const stored = (registry as unknown as { leases: Map<string, Record<string, unknown>> }).leases.get(first.routeId);
    assert.ok(stored?.credentialDigest instanceof Buffer);
    assert.equal('bearer' in (stored ?? {}), false);
    assert.doesNotMatch(JSON.stringify(stored?.credentialDigest), new RegExp(first.bearer));
  });

  it('closes only the matching session generation and rejects revoked or stale identities', () => {
    const registry = new ProviderRouteRegistry();
    const oldLease = registry.register({ sessionId: 's1', generation: 'old', upstream: upstream('p1') });
    const replacement = registry.register({ sessionId: 's1', generation: 'new', upstream: upstream('p1') });

    assert.equal(registry.close({ ...oldLease, generation: 'new' }), false);
    assert.ok(registry.authorize(oldLease.routeId, oldLease.bearer));
    assert.equal(registry.close(oldLease), true);
    assert.equal(registry.authorize(oldLease.routeId, oldLease.bearer), null);
    assert.ok(registry.authorize(replacement.routeId, replacement.bearer));
    assert.equal(registry.status(oldLease).state, 'missing');
    assert.equal(registry.status(replacement).state, 'ready');
  });

  it('enforces lease, request, history, and buffer ceilings and returns counters to baseline', () => {
    const registry = new ProviderRouteRegistry({ limits: {
      maxLeases: 2,
      maxActiveRequests: 2,
      maxActiveRequestsPerLease: 1,
      maxHistoryBytes: 8,
      maxHistoryBytesPerLease: 6,
      maxBufferedResponseBytes: 8,
      maxBufferedResponseBytesPerLease: 6,
    } });
    const lease1 = registry.register({ sessionId: 's1', generation: 'g1', upstream: upstream('p1') });
    const lease2 = registry.register({ sessionId: 's2', generation: 'g1', upstream: upstream('p1') });
    assert.throws(
      () => registry.register({ sessionId: 's3', generation: 'g1', upstream: upstream('p1') }),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'lease_capacity',
    );
    const route1 = registry.authorize(lease1.routeId, lease1.bearer);
    const route2 = registry.authorize(lease2.routeId, lease2.bearer);
    assert.ok(route1 && route2);
    const request1 = registry.startRequest(route1, 5);
    assert.throws(
      () => registry.startRequest(route1, 1),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'request_capacity',
    );
    assert.throws(
      () => registry.startRequest(route2, 4),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'history_capacity',
    );
    const request2 = registry.startRequest(route2, 3);
    request1.reserveBuffered(6);
    assert.throws(
      () => request2.reserveBuffered(3),
      (error: unknown) => error instanceof ProviderRouteRegistryError && error.code === 'buffer_capacity',
    );
    assert.deepEqual(registry.processStatus(), {
      leases: 2, activeRequests: 2, historyBytes: 8, bufferedResponseBytes: 6,
    });
    request1.finish();
    request2.finish();
    registry.closeAll();
    assert.deepEqual(registry.processStatus(), {
      leases: 0, activeRequests: 0, historyBytes: 0, bufferedResponseBytes: 0,
    });
  });

  it('aborts every active controller for the matching lease during close and is idempotent', () => {
    const registry = new ProviderRouteRegistry();
    const lease = registry.register({ sessionId: 's1', generation: 'g1', upstream: upstream('p1') });
    const route = registry.authorize(lease.routeId, lease.bearer);
    assert.ok(route);
    const first = registry.startRequest(route, 1);
    const second = registry.startRequest(route, 1);
    assert.equal(first.signal.aborted, false);
    assert.equal(registry.close(lease), true);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, true);
    assert.equal(registry.close(lease), false);
    first.finish();
    assert.deepEqual(registry.processStatus(), {
      leases: 0, activeRequests: 0, historyBytes: 0, bufferedResponseBytes: 0,
    });
  });
});
