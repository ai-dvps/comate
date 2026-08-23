import '../test-utils/test-env.js';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import express from 'express';

import {
  authorizeCodexRouteRequest,
  createCodexResponsesRoute,
  type CodexResponsesRouteController,
} from './codex-responses-route.js';

const controllers: CodexResponsesRouteController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close();
});

describe('Codex Responses route', () => {
  it('rejects a non-loopback peer before inspecting authorization', () => {
    let authorizationRead = false;
    const decision = authorizeCodexRouteRequest({
      peerAddress: '203.0.113.4',
      method: 'POST',
      routeId: 'opaque-route-id',
      expectedRouteId: 'opaque-route-id',
      getAuthorization: () => {
        authorizationRead = true;
        return 'Bearer route-secret';
      },
      routeBearer: 'route-secret',
    });

    assert.deepStrictEqual(decision, { allowed: false, status: 403 });
    assert.equal(authorizationRead, false);
  });

  it('authenticates locally, forwards only the provider bearer, streams, and returns to baseline', async () => {
    const providerBearer = 'provider-secret-not-for-codex';
    const routeBearer = 'route-secret-only-for-codex';
    let upstreamAuthorization = '';
    const upstream = createServer((req, res) => {
      upstreamAuthorization = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.output_text.delta","delta":"hel"}\n\n');
      res.end('data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === 'object');

    const controller = createCodexResponsesRoute({
      routeId: 'opaque-route-id',
      routeBearer,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      providerBearer,
    });
    controllers.push(controller);
    const app = express();
    app.use('/codex-route', controller.router);
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert.ok(address && typeof address === 'object');

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-route/opaque-route-id/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${routeBearer}`,
          'content-type': 'application/json',
        },
        body: '{"model":"test","stream":true}',
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /response\.output_text\.delta[\s\S]*response\.completed/);
      assert.equal(upstreamAuthorization, `Bearer ${providerBearer}`);
      assert.deepStrictEqual(controller.status(), { activeRequests: 0, closed: false });
      controller.close();
      assert.deepStrictEqual(controller.status(), { activeRequests: 0, closed: true });
    } finally {
      listener.close();
      upstream.close();
      await Promise.all([once(listener, 'close'), once(upstream, 'close')]);
    }
  });

  it('aborts the upstream stream when the Codex client cancels', async () => {
    let upstreamClosed = false;
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}\n\n');
      res.once('close', () => { upstreamClosed = true; });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
    const controller = createCodexResponsesRoute({
      routeId: 'opaque-route-id',
      routeBearer: 'route-secret',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      providerBearer: 'provider-secret',
    });
    controllers.push(controller);
    const app = express();
    app.use('/codex-route', controller.router);
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-route/opaque-route-id/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer route-secret', 'content-type': 'application/json' },
        body: '{}',
        signal: abort.signal,
      });
      assert.ok(response.body);
      await response.body.getReader().read();
      abort.abort();
      await waitFor(() => upstreamClosed && controller.status().activeRequests === 0);
    } finally {
      listener.close();
      upstream.close();
      await Promise.all([once(listener, 'close'), once(upstream, 'close')]);
    }
  });

  it('revokes an active route and returns its counters to baseline on close', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
    const controller = createCodexResponsesRoute({
      routeId: 'opaque-route-id',
      routeBearer: 'route-secret',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      providerBearer: 'provider-secret',
    });
    controllers.push(controller);
    const app = express();
    app.use('/codex-route', controller.router);
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-route/opaque-route-id/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer route-secret' },
        body: '{}',
        signal: abort.signal,
      });
      assert.ok(response.body);
      await response.body.getReader().read();
      assert.equal(controller.status().activeRequests, 1);
      controller.close();
      assert.deepStrictEqual(controller.status(), { activeRequests: 0, closed: true });
    } finally {
      abort.abort();
      listener.close();
      upstream.close();
      await Promise.all([once(listener, 'close'), once(upstream, 'close')]);
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), 'condition timed out');
}
