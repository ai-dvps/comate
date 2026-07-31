import '../../test-utils/test-env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  createLoopbackAuthMiddleware,
  getLoopbackAuth,
  SESSION_ROUTE_TEMPLATES,
  type SessionTokenResolution,
} from './loopback-auth.js';

/**
 * Route-matrix contract for the U12 default-deny loopback auth (KTD-28).
 * Runs against a REAL express app on loopback so the evidence covers the
 * registration layer itself, not just handler internals:
 *
 *  - Unauthenticated requests to previously-open routes (files/content,
 *    smartsheet-export, chat sessions) are rejected (401).
 *  - The declared-exempt liveness route still works with no credential.
 *  - The desktop credential passes everywhere (GUI functionality preserved).
 *  - A session capability token passes ONLY the enrolled CLI route set, and
 *    only for its bound workspace/session (403 everywhere else — including a
 *    brand-new route that did not exist when the template list was written,
 *    which is the open-set regression proof).
 *  - Expired/revoked/unknown tokens are rejected.
 */

const DESKTOP_TOKEN = 'desktop-token-aaaa1111';
const SESSION_TOKEN = 'session-token-bbbb2222';
const OTHER_SESSION_TOKEN = 'session-token-cccc3333';
const EXPIRED_TOKEN = 'session-token-dddd4444';

const SESSION: SessionTokenResolution = { sessionId: 'sess-1', workspaceId: 'ws-1', botId: 'bot-1' };
const OTHER_SESSION: SessionTokenResolution = { sessionId: 'sess-2', workspaceId: 'ws-2', botId: 'bot-1' };

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    createLoopbackAuthMiddleware({
      getDesktopToken: () => DESKTOP_TOKEN,
      resolveSessionToken: (token) => {
        if (token === SESSION_TOKEN) return SESSION;
        if (token === OTHER_SESSION_TOKEN) return OTHER_SESSION;
        return null; // expired/revoked/unknown all collapse to null
      },
    }),
  );

  // Representative previously-unauthenticated routes.
  app.get('/api/workspaces/:id/files/content', (_req, res) => res.json({ ok: true, route: 'files/content' }));
  app.post('/api/workspaces/:workspaceId/wecom/smartsheet-export', (_req, res) =>
    res.json({ ok: true, route: 'smartsheet-export', auth: getLoopbackAuth(_req) ?? null }),
  );
  app.get('/api/workspaces/:id/sessions', (_req, res) => res.json({ ok: true, route: 'sessions' }));
  app.post('/api/workspaces/:workspaceId/wecom/send', (_req, res) =>
    res.json({ ok: true, route: 'wecom/send', auth: getLoopbackAuth(_req) ?? null }),
  );
  app.get('/api/workspaces/:id/sessions/:sessionId/wecom-user', (_req, res) =>
    res.json({ ok: true, route: 'wecom-user', auth: getLoopbackAuth(_req) ?? null }),
  );

  // A route that did not exist when SESSION_ROUTE_TEMPLATES was written:
  // default-deny must cover it for BOTH dimensions (no token 401, session
  // token 403, desktop 200).
  app.get('/api/workspaces/:id/future-feature', (_req, res) =>
    res.json({ ok: true, route: 'future-feature', auth: getLoopbackAuth(_req) ?? null }),
  );

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

interface Response {
  status: number;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('loopback-auth middleware (route matrix)', { concurrency: false }, () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    server = makeApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects unauthenticated requests to files/content', async () => {
    const res = await request(port, 'GET', '/api/workspaces/ws-1/files/content?path=x');
    assert.strictEqual(res.status, 401);
  });

  it('rejects unauthenticated requests to smartsheet-export', async () => {
    const res = await request(port, 'POST', '/api/workspaces/ws-1/wecom/smartsheet-export', { body: { docid: 'd' } });
    assert.strictEqual(res.status, 401);
  });

  it('rejects unauthenticated requests to chat session routes', async () => {
    const res = await request(port, 'GET', '/api/workspaces/ws-1/sessions');
    assert.strictEqual(res.status, 401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/api/workspaces/ws-1/sessions', method: 'GET', headers: { authorization: 'Token abc' } },
        (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 401);
  });

  it('serves the declared-exempt liveness route without a credential', async () => {
    const res = await request(port, 'GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
  });

  it('lets the desktop credential reach every route', async () => {
    for (const [method, path] of [
      ['GET', '/api/workspaces/ws-1/files/content?path=x'],
      ['GET', '/api/workspaces/ws-1/sessions'],
      ['GET', '/api/workspaces/ws-1/future-feature'],
      ['GET', '/api/workspaces/ws-1/sessions/sess-2/wecom-user'],
      ['POST', '/api/workspaces/ws-2/wecom/send'],
    ] as const) {
      const res = await request(port, method, path, { token: DESKTOP_TOKEN, body: method === 'POST' ? {} : undefined });
      assert.strictEqual(res.status, 200, `${method} ${path} should pass with the desktop credential`);
    }
  });

  it('lets a valid session token call an enrolled route and stamps the bound identity', async () => {
    const res = await request(port, 'POST', '/api/workspaces/ws-1/wecom/send', {
      token: SESSION_TOKEN,
      body: { toUser: 'alice', message: 'hi' },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body) as { auth: { kind: string; sessionId: string; workspaceId: string; botId: string } };
    assert.deepStrictEqual(body.auth, { kind: 'session', sessionId: 'sess-1', workspaceId: 'ws-1', botId: 'bot-1' });
  });

  it('rejects a session token on non-enrolled routes (files/content, sessions)', async () => {
    const files = await request(port, 'GET', '/api/workspaces/ws-1/files/content?path=x', { token: SESSION_TOKEN });
    assert.strictEqual(files.status, 403);
    const sessions = await request(port, 'GET', '/api/workspaces/ws-1/sessions', { token: SESSION_TOKEN });
    assert.strictEqual(sessions.status, 403);
  });

  it('rejects a session token on a route that did not exist when the template set was written', async () => {
    const res = await request(port, 'GET', '/api/workspaces/ws-1/future-feature', { token: SESSION_TOKEN });
    assert.strictEqual(res.status, 403);
  });

  it('rejects a session token used against another workspace', async () => {
    const res = await request(port, 'POST', '/api/workspaces/ws-2/wecom/send', {
      token: SESSION_TOKEN,
      body: {},
    });
    assert.strictEqual(res.status, 403);
  });

  it('rejects a session token used against another session in the path', async () => {
    const res = await request(port, 'GET', '/api/workspaces/ws-1/sessions/sess-2/wecom-user', { token: SESSION_TOKEN });
    assert.strictEqual(res.status, 403);
  });

  it('accepts a session token on the enrolled wecom-user route for its own session', async () => {
    const res = await request(port, 'GET', '/api/workspaces/ws-1/sessions/sess-1/wecom-user', { token: SESSION_TOKEN });
    assert.strictEqual(res.status, 200);
  });

  it('rejects expired/revoked/unknown tokens', async () => {
    const res = await request(port, 'POST', '/api/workspaces/ws-1/wecom/send', { token: EXPIRED_TOKEN, body: {} });
    assert.strictEqual(res.status, 401);
  });

  it('keeps the desktop credential distinct from session tokens (workspace binding does not apply)', async () => {
    const res = await request(port, 'POST', '/api/workspaces/ws-2/wecom/send', { token: OTHER_SESSION_TOKEN, body: {} });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body) as { auth: { workspaceId: string } };
    assert.strictEqual(body.auth.workspaceId, 'ws-2');
  });

  it('ships a closed session-route template set (regression anchor)', () => {
    assert.deepStrictEqual([...SESSION_ROUTE_TEMPLATES].sort(), [
      'GET /api/workspaces/:workspaceId/sessions/:sessionId/wecom-user',
      'POST /api/workspaces/:workspaceId/wecom/doc/:tool',
      'POST /api/workspaces/:workspaceId/wecom/send',
      'POST /api/workspaces/:workspaceId/wecom/send-file',
      'POST /api/workspaces/:workspaceId/wecom/smartsheet-export',
    ]);
  });
});
