import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import {
  createCorsOriginCallback,
  createWsUpgradeVerifier,
  evaluateRequestSource,
  hostHeaderGuard,
  isAllowedAppOrigin,
  isWhitelistedHostHeader,
  parseHostHeader,
  stateChangingRequestGuard,
} from '../security/request-origin-guard.js';
import { ComateWebSocketServer } from '../../websocket/server.js';

/**
 * U9: sidecar remote-surface hardening. Covers the origin matrix, the
 * null/absent-Origin policy (settled by the 2026-07-19 WKWebView capture:
 * tauri:// pages send `Origin: tauri://localhost` AND
 * `Sec-Fetch-Site: cross-site` on fetch and WS upgrade), the Host header
 * whitelist (anti-DNS-rebinding, reads included), CORS tightening, and the
 * WS upgrade verifier.
 */

describe('parseHostHeader / isWhitelistedHostHeader', () => {
  it('accepts loopback and tauri hostnames with or without ports', () => {
    for (const host of [
      'localhost',
      'localhost:3000',
      'LOCALHOST:3000',
      'localhost.',
      'localhost.:3000',
      '127.0.0.1',
      '127.0.0.1:5173',
      '[::1]',
      '[::1]:3000',
      '::1',
      'tauri.localhost',
    ]) {
      assert.ok(isWhitelistedHostHeader(host), `expected ${host} to be whitelisted`);
    }
  });

  it('rejects foreign, missing, or deceptive hosts (DNS rebinding shapes)', () => {
    for (const host of [
      'evil.com',
      'evil.com:3000',
      'localhost.evil.com',
      '127.0.0.1.evil.com',
      'localhost@evil.com',
      'localhost:3000@evil.com',
      'foo.localhost',
      '0.0.0.0',
      '2130706433', // 127.0.0.1 as a decimal dword
      '127.0.0.1:3000:extra',
      '[::1',
      '[::1]garbage',
      'localhost:abc',
      'localhost:',
      '',
      undefined,
    ]) {
      assert.ok(!isWhitelistedHostHeader(host), `expected ${host} to be rejected`);
    }
  });

  it('parses bracketed IPv6 and trailing dots', () => {
    assert.strictEqual(parseHostHeader('[::1]:3000'), '::1');
    assert.strictEqual(parseHostHeader('LOCALHOST.'), 'localhost');
    assert.strictEqual(parseHostHeader('127.0.0.1:8080'), '127.0.0.1');
    assert.strictEqual(parseHostHeader(undefined), null);
  });
});

describe('isAllowedAppOrigin', () => {
  it('accepts every entry of the per-platform app origin matrix', () => {
    for (const origin of [
      'tauri://localhost', // macOS/Linux production webview
      'http://tauri.localhost', // Windows production WebView2
      'https://tauri.localhost', // Windows production (https variant)
      'http://localhost:5173', // dev vite origin
    ]) {
      assert.ok(isAllowedAppOrigin(origin), `expected ${origin} to be allowed`);
    }
  });

  it('accepts the sidecar self origin only when the self port is known', () => {
    assert.ok(isAllowedAppOrigin('http://localhost:3000', 3000));
    assert.ok(isAllowedAppOrigin('http://127.0.0.1:3000', 3000));
    assert.ok(!isAllowedAppOrigin('http://localhost:3000'));
    assert.ok(!isAllowedAppOrigin('http://localhost:3000', 3001));
  });

  it('rejects everything else', () => {
    for (const origin of [
      'https://evil.com',
      'http://localhost:9999',
      'http://tauri.localhost.evil.com',
      'null',
      'file://',
      'tauri://localhost.evil.com',
      'http://localhost:5173.evil.com',
    ]) {
      assert.ok(!isAllowedAppOrigin(origin, 3000), `expected ${origin} to be rejected`);
    }
  });
});

describe('evaluateRequestSource', () => {
  const HOST = 'localhost:3000';

  it('allows matrix origins even when Fetch Metadata says cross-site (WKWebView shape)', () => {
    // Captured from a real WKWebView (2026-07-19): the legit macOS client is
    // itself "cross-site" because tauri:// is a different site than loopback.
    const decision = evaluateRequestSource(
      { origin: 'tauri://localhost', host: HOST, secFetchSite: 'cross-site' },
      3000,
    );
    assert.deepStrictEqual(decision, { allowed: true });
  });

  it('rejects cross-origin browser sources', () => {
    const decision = evaluateRequestSource(
      { origin: 'https://evil.com', host: HOST, secFetchSite: 'cross-site' },
      3000,
    );
    assert.deepStrictEqual(decision, { allowed: false, reason: 'origin-not-allowed' });
  });

  it('rejects Origin: null (sandboxed iframe / opaque origin CSRF vehicle)', () => {
    const decision = evaluateRequestSource({ origin: 'null', host: HOST }, 3000);
    assert.deepStrictEqual(decision, { allowed: false, reason: 'null-origin' });
  });

  it('allows absent Origin with whitelisted Host and no cross-site marker (local non-browser clients)', () => {
    assert.deepStrictEqual(evaluateRequestSource({ host: HOST }, 3000), { allowed: true });
    assert.deepStrictEqual(
      evaluateRequestSource({ host: HOST, secFetchSite: 'same-origin' }, 3000),
      { allowed: true },
    );
    assert.deepStrictEqual(
      evaluateRequestSource({ host: HOST, secFetchSite: 'none' }, 3000),
      { allowed: true },
    );
  });

  it('rejects absent Origin when Sec-Fetch-Site is cross-site', () => {
    const decision = evaluateRequestSource({ host: HOST, secFetchSite: 'cross-site' }, 3000);
    assert.deepStrictEqual(decision, { allowed: false, reason: 'cross-site-without-origin' });
  });

  it('rejects anything with a non-whitelisted Host regardless of Origin', () => {
    const decision = evaluateRequestSource(
      { origin: 'tauri://localhost', host: 'evil.com' },
      3000,
    );
    assert.deepStrictEqual(decision, { allowed: false, reason: 'host-not-whitelisted' });
  });
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('express middleware stack (same wiring as server-main)', { concurrency: false }, () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = express();
    const getSelfPort = (): number | undefined => port;
    app.use(hostHeaderGuard());
    app.use(cors({ origin: createCorsOriginCallback({ getSelfPort }) }));
    app.use(stateChangingRequestGuard({ getSelfPort }));
    app.use(express.json());
    app.get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });
    // Mirrors the approval-resolution route shape from routes/chat.ts.
    app.post('/api/workspaces/:id/sessions/:sessionId/approvals/:requestId', (req, res) => {
      res.json({ resolved: true, requestId: req.params.requestId });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects anomalous Host headers on read routes too (DNS rebinding)', async () => {
    const res = await rawRequest(port, {
      method: 'GET',
      path: '/api/ping',
      headers: { Host: 'attacker-rebind.example' },
    });
    assert.strictEqual(res.status, 403);
  });

  it('serves loopback Hosts on read routes', async () => {
    const res = await rawRequest(port, { method: 'GET', path: '/api/ping' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
  });

  it('emits no Access-Control-Allow-Origin for cross-origin reads (browser withholds the response)', async () => {
    const res = await rawRequest(port, {
      method: 'GET',
      path: '/api/ping',
      headers: { Origin: 'https://evil.example' },
    });
    assert.strictEqual(res.status, 200); // simple GET is sent, but…
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined); // …unreadable cross-origin
  });

  it('reflects matrix origins on reads', async () => {
    const res = await rawRequest(port, {
      method: 'GET',
      path: '/api/ping',
      headers: { Origin: 'tauri://localhost' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'tauri://localhost');
  });

  it('fails preflight for foreign origins and passes it for matrix origins', async () => {
    const evil = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.notStrictEqual(evil.status, 204);
    assert.strictEqual(evil.headers['access-control-allow-origin'], undefined);

    const legit = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.strictEqual(legit.status, 204);
    assert.strictEqual(legit.headers['access-control-allow-origin'], 'tauri://localhost');
  });

  it('rejects a cross-site POST to the approval-resolution route (drive-by webpage fixture)', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/x-www-form-urlencoded', // simple form POST: no preflight
      },
      body: 'decision=approve',
    });
    assert.strictEqual(res.status, 403);
  });

  it('rejects a sandboxed-iframe (Origin: null) POST', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 403);
  });

  it('allows the legit webview POST (tauri origin + cross-site Fetch Metadata)', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: {
        Origin: 'tauri://localhost',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: '{"decision":"approve"}',
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { resolved: true, requestId: 'r-1' });
  });

  it('allows the dev vite origin', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 200);
  });

  it('allows the sidecar self origin (statically served UI in a plain browser)', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 200);
  });

  it('allows header-less local clients (Tauri shell reqwest / CLI / plugin scripts)', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 200);
  });

  it('rejects a cross-site POST with an anomalous Host even when Origin looks legit', async () => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/workspaces/ws-1/sessions/s-1/approvals/r-1',
      headers: { Host: 'attacker-rebind.example', Origin: 'tauri://localhost' },
      body: '{}',
    });
    assert.strictEqual(res.status, 403);
  });
});

describe('createWsUpgradeVerifier', () => {
  function verify(headers: Record<string, string | undefined>, selfPort?: number): boolean {
    const verifier = createWsUpgradeVerifier({ getSelfPort: () => selfPort });
    let accepted: boolean | undefined;
    verifier(
      {
        origin: headers.origin ?? '',
        secure: false,
        req: { headers } as unknown as import('http').IncomingMessage,
      },
      (result) => {
        accepted = result;
      },
    );
    assert.notStrictEqual(accepted, undefined);
    return accepted as boolean;
  }

  it('accepts matrix origins, header-less local clients, and rejects the rest', () => {
    assert.ok(verify({ origin: 'tauri://localhost', host: 'localhost:3000' }, 3000));
    assert.ok(verify({ origin: 'http://tauri.localhost', host: 'localhost:3000' }, 3000));
    assert.ok(verify({ origin: 'http://localhost:5173', host: 'localhost:3000' }, 3000));
    assert.ok(verify({ host: 'localhost:3000' }, 3000)); // node ws / Rust clients send no Origin
    assert.ok(!verify({ origin: 'https://evil.example', host: 'localhost:3000' }, 3000));
    assert.ok(!verify({ origin: 'null', host: 'localhost:3000' }, 3000));
    assert.ok(!verify({ origin: 'tauri://localhost', host: 'evil.example' }, 3000));
    assert.ok(!verify({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }, 3000));
  });
});

describe('ComateWebSocketServer upgrade enforcement (integration)', { concurrency: false }, () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    new ComateWebSocketServer().attach(server, { getSelfPort: () => port });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function tryConnect(headers?: Record<string, string>): Promise<'open' | number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${port}/ws`, { headers });
      socket.on('open', () => {
        socket.close();
        resolve('open');
      });
      socket.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      socket.on('error', reject);
    });
  }

  it('rejects WS upgrades from foreign origins (drive-by webpage fixture)', async () => {
    assert.strictEqual(await tryConnect({ Origin: 'https://evil.example' }), 403);
  });

  it('rejects WS upgrades with Origin: null', async () => {
    assert.strictEqual(await tryConnect({ Origin: 'null' }), 403);
  });

  it('rejects WS upgrades with an anomalous Host', async () => {
    assert.strictEqual(
      await tryConnect({ Origin: 'tauri://localhost', Host: 'attacker-rebind.example' }),
      403,
    );
  });

  it('accepts WS upgrades from the app origin matrix', async () => {
    assert.strictEqual(await tryConnect({ Origin: 'tauri://localhost' }), 'open');
    assert.strictEqual(await tryConnect({ Origin: 'http://tauri.localhost' }), 'open');
    assert.strictEqual(await tryConnect({ Origin: 'http://localhost:5173' }), 'open');
  });

  it('accepts header-less local WS clients (existing test-suite shape)', async () => {
    assert.strictEqual(await tryConnect(), 'open');
  });
});
