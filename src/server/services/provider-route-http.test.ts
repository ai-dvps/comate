import '../test-utils/test-env.js';

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import express from 'express';

import {
  createProviderRouteHttpRouter,
  authorizeProviderRouteRequest,
  isLoopbackPeer,
  PinnedProviderRouteTransport,
  providerRouteAcceptanceTransportFromEnv,
  type ProviderRouteUpstreamRequest,
  type ProviderRouteUpstreamResponse,
  type ProviderRouteUpstreamTransport,
} from './provider-route-http.js';
import { ProviderRouteRegistry } from './provider-route-registry.js';
import type { DirectHttpTransportRequest } from './browser-direct-http-client.js';

const servers: Server[] = [];
const registries: ProviderRouteRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.closeAll();
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

function register(registry: ProviderRouteRegistry) {
  return registry.register({
    sessionId: 'session-a',
    generation: 'generation-a',
    upstream: {
      providerId: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      credential: 'provider-secret-sentinel',
      model: 'kimi-for-coding',
      promptCacheRouting: 'auto',
      suppressSamplingParameters: true,
    },
  });
}

async function listen(registry: ProviderRouteRegistry, transport: ProviderRouteUpstreamTransport): Promise<string> {
  const app = express();
  // Production order: this route is mounted before every body parser/CORS middleware.
  app.use('/provider-route', createProviderRouteHttpRouter({ registry, transport, maxRequestBytes: 1024 }));
  app.use(express.json());
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/provider-route`;
}

function streamResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): ProviderRouteUpstreamResponse {
  return {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    close() {},
  };
}

describe('Provider route HTTP', () => {
  it('keeps the packaged acceptance transport loopback-only and opt-in', () => {
    assert.equal(providerRouteAcceptanceTransportFromEnv(undefined), undefined);
    assert.ok(providerRouteAcceptanceTransportFromEnv('http://127.0.0.1:4321/v1'));
    assert.throws(
      () => providerRouteAcceptanceTransportFromEnv('https://provider.example/v1'),
      /loopback HTTP/,
    );
  });
  it('recognizes socket peers rather than a forged Host header', () => {
    assert.equal(isLoopbackPeer('127.0.0.1'), true);
    assert.equal(isLoopbackPeer('::1'), true);
    assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackPeer('203.0.113.7'), false);
    const registry = new ProviderRouteRegistry();
    let authorizationRead = false;
    assert.deepEqual(authorizeProviderRouteRequest({
      peerAddress: '203.0.113.7',
      method: 'POST',
      routeId: 'forged-route',
      getAuthorization: () => {
        authorizationRead = true;
        return 'Bearer forged';
      },
      registry,
    }), { allowed: false, status: 403 });
    assert.equal(authorizationRead, false);
  });

  it('authenticates and streams Chat conversion while forwarding only allowlisted headers', async () => {
    const registry = new ProviderRouteRegistry();
    registries.push(registry);
    const lease = register(registry);
    let captured: ProviderRouteUpstreamRequest | undefined;
    const transport: ProviderRouteUpstreamTransport = {
      async request(input) {
        captured = input;
        return streamResponse([
          'data: {"id":"chat-1","model":"kimi-for-coding","choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
    };
    const base = await listen(registry, transport);
    const response = await fetch(`${base}/${lease.routeId}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${lease.bearer}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        cookie: 'cookie-secret',
        'x-secret-header': 'must-not-forward',
      },
      body: JSON.stringify({ model: 'untrusted-model', input: 'hello', stream: true, temperature: 0.8 }),
    });
    const output = await response.text();
    assert.equal(response.status, 200);
    assert.match(output, /response\.output_text\.delta/);
    assert.match(output, /你/);
    assert.match(output, /response\.completed/);
    assert.ok(captured);
    assert.equal(captured.url, 'https://api.kimi.com/coding/v1/chat/completions');
    assert.equal(captured.headers.authorization, 'Bearer provider-secret-sentinel');
    assert.equal(captured.headers.cookie, undefined);
    assert.equal(captured.headers['x-secret-header'], undefined);
    const upstreamBody = JSON.parse(captured.body.toString('utf8')) as Record<string, unknown>;
    assert.equal(upstreamBody.model, 'kimi-for-coding');
    assert.equal(upstreamBody.temperature, undefined);
    assert.equal(typeof upstreamBody.prompt_cache_key, 'string');
    assert.doesNotMatch(String(upstreamBody.prompt_cache_key), /session-a|route_/);
    assert.deepEqual(registry.processStatus(), {
      leases: 1, activeRequests: 0, historyBytes: 0, bufferedResponseBytes: 0,
    });
  });

  it('rejects wrong methods, unknown paths, missing, cross-session, and revoked credentials before dispatch', async () => {
    const registry = new ProviderRouteRegistry();
    registries.push(registry);
    const first = register(registry);
    const second = registry.register({
      sessionId: 'session-b', generation: 'generation-b',
      upstream: { providerId: 'p2', baseUrl: 'https://api.example.com/v1', credential: 'secret-2', model: 'm2' },
    });
    let calls = 0;
    const transport: ProviderRouteUpstreamTransport = {
      async request() { calls += 1; return streamResponse([]); },
    };
    const base = await listen(registry, transport);
    const cases: Array<[string, RequestInit]> = [
      [`${base}/${first.routeId}/responses`, { method: 'GET', headers: { authorization: `Bearer ${first.bearer}` } }],
      [`${base}/unknown/responses`, { method: 'POST', headers: { authorization: `Bearer ${first.bearer}` }, body: 'x'.repeat(4096) }],
      [`${base}/unknown/not-responses`, { method: 'POST', headers: { authorization: `Bearer ${first.bearer}` }, body: 'x'.repeat(4096) }],
      [`${base}/${first.routeId}/responses`, { method: 'POST', body: 'x'.repeat(4096) }],
      [`${base}/${first.routeId}/responses`, { method: 'POST', headers: { authorization: `Bearer ${second.bearer}` }, body: '{}' }],
    ];
    for (const [url, init] of cases) {
      const response = await fetch(url, init);
      assert.ok(response.status === 401 || response.status === 404);
      assert.equal(await response.text(), '');
    }
    registry.close(first);
    const revoked = await fetch(`${base}/${first.routeId}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${first.bearer}` }, body: '{}',
    });
    assert.equal(revoked.status, 401);
    assert.equal(calls, 0);
  });

  it('aborts the upstream stream when the Codex client cancels', async () => {
    const registry = new ProviderRouteRegistry();
    registries.push(registry);
    const lease = register(registry);
    let upstreamAborted = false;
    const transport: ProviderRouteUpstreamTransport = {
      async request(input) {
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: (async function* () {
            yield Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
            await new Promise<void>((resolve) => {
              if (input.signal.aborted) resolve();
              else input.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            upstreamAborted = input.signal.aborted;
          })(),
          close() {},
        };
      },
    };
    const base = await listen(registry, transport);
    const abort = new AbortController();
    const response = await fetch(`${base}/${lease.routeId}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello', stream: true }),
      signal: abort.signal,
    });
    assert.ok(response.body);
    await response.body.getReader().read();
    abort.abort();
    await waitFor(() => upstreamAborted && registry.processStatus().activeRequests === 0);
  });

  it('sanitizes upstream errors and never echoes credentials, headers, URLs, or bodies', async () => {
    const registry = new ProviderRouteRegistry();
    registries.push(registry);
    const lease = register(registry);
    const sentinel = 'provider-secret-sentinel';
    const transport: ProviderRouteUpstreamTransport = {
      async request() {
        return streamResponse([`data: {"error":{"message":"${sentinel}"}}\n\n`], 500, {
          'x-secret': sentinel,
          location: `https://${sentinel}.example/steal`,
        });
      },
    };
    const base = await listen(registry, transport);
    const response = await fetch(`${base}/${lease.routeId}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: sentinel, stream: true }),
    });
    const output = await response.text();
    assert.equal(response.status, 502);
    assert.doesNotMatch(output, new RegExp(sentinel));
    assert.doesNotMatch(output, /kimi\.com|authorization|location/i);
  });

  it('emits a safe Responses failure when an upstream stream breaks after headers', async () => {
    const registry = new ProviderRouteRegistry();
    registries.push(registry);
    const lease = register(registry);
    const sentinel = 'stream-secret-sentinel';
    const transport: ProviderRouteUpstreamTransport = {
      async request() {
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          `data: {"error":{"message":"${sentinel}"}}\n\n`,
        ]);
      },
    };
    const base = await listen(registry, transport);
    const response = await fetch(`${base}/${lease.routeId}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello', stream: true }),
    });
    const output = await response.text();
    assert.equal(response.status, 200);
    assert.match(output, /event: response\.failed/);
    assert.match(output, /"status":"failed"/);
    assert.doesNotMatch(output, new RegExp(sentinel));
    assert.doesNotMatch(output, /provider-secret|authorization|kimi\.com/i);
    assert.deepEqual(registry.processStatus(), {
      leases: 1, activeRequests: 0, historyBytes: 0, bufferedResponseBytes: 0,
    });
  });

  it('pins HTTP internal destinations and preserves HTTPS TLS routing', async () => {
    let captured: DirectHttpTransportRequest | undefined;
    const routed = new PinnedProviderRouteTransport({
      resolver: async () => [{ address: '10.20.30.40', family: 4 }],
      transport: {
        async request(input) {
          captured = input;
          return {
            statusCode: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: (async function* () { yield Buffer.from('data: [DONE]\n\n'); })(),
            close() {},
          };
        },
      },
    });
    const response = await routed.request({
      url: 'http://llm.internal:8080/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer provider-secret', 'content-type': 'application/json' },
      body: Buffer.from('{}'),
      signal: new AbortController().signal,
    });
    assert.ok(captured);
    assert.equal(captured.protocol, 'http:');
    assert.equal(captured.hostname, 'llm.internal');
    assert.equal(captured.servername, 'llm.internal');
    assert.equal(captured.pinnedAddress, '10.20.30.40');
    assert.equal(captured.port, 8080);
    assert.equal(captured.headers.authorization, 'Bearer provider-secret');
    response.close();
  });

  it('dispatches to a real loopback HTTP Provider without TLS', async () => {
    let receivedAuthorization: string | undefined;
    const upstream = createServer((req, res) => {
      receivedAuthorization = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    servers.push(upstream);
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address === 'object');

    const transport = new PinnedProviderRouteTransport();
    const response = await transport.request({
      url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      method: 'POST',
      headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
      body: Buffer.from('{}'),
      signal: new AbortController().signal,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(chunk);

    assert.equal(response.status, 200);
    assert.equal(Buffer.concat(chunks).toString('utf8'), '{"ok":true}');
    assert.equal(receivedAuthorization, 'Bearer internal-secret');
    response.close();
  });

  it('rejects redirects without issuing a second upstream request', async () => {
    const registry = new ProviderRouteRegistry();
    registries.push(registry);
    const lease = register(registry);
    let calls = 0;
    const transport: ProviderRouteUpstreamTransport = {
      async request() {
        calls += 1;
        return streamResponse([], 307, { location: 'https://attacker.example/steal' });
      },
    };
    const base = await listen(registry, transport);
    const response = await fetch(`${base}/${lease.routeId}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello', stream: true }),
    });
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
    assert.doesNotMatch(await response.text(), /attacker|location|provider-secret/);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), 'condition timed out');
}
