import '../../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { BrowserViewerProxy } from '../../routes/browser-proxy.js';
import { BrowserService, mintViewerToken } from '../browser-service.js';
import {
  SteelProcess,
  type SteelExitInfo,
  type SteelProcessHandle,
  type SteelProcessOptions,
} from '../browser-steel-process.js';

/**
 * U7 viewer-proxy tests (KTD-7). A real BrowserService instance backed by
 * fake Steel handles provides the token registry; the proxy runs on a real
 * loopback port; per-session fake Steel upstreams (real HTTP+WS servers)
 * receive whatever the proxy forwards, so session affinity is asserted by
 * which upstream got hit.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-steel.cjs',
);

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

// ── fake steel handle (registry-level, no real process) ─────────────────────

class FakeSteelHandle implements SteelProcessHandle {
  readonly baseUrl: string;
  private exited = false;
  private exitListeners = new Set<(info: SteelExitInfo) => void>();

  constructor(private readonly options: SteelProcessOptions) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }
  get port(): number {
    return this.options.port;
  }
  get userDataDir(): string {
    return this.options.userDataDir;
  }
  get pid(): number | undefined {
    return this.exited ? undefined : 424_242;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.markExited({ code: 0, signal: null });
  }
  async probeHealth(): Promise<boolean> {
    return !this.exited;
  }
  onExit(listener: (info: SteelExitInfo) => void): () => void {
    if (this.exited) {
      listener({ code: 0, signal: null });
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  crash(): void {
    this.markExited({ code: 1, signal: null });
  }

  private markExited(info: SteelExitInfo): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener(info);
  }
}

// ── fake steel upstream (real HTTP + WS server the proxy forwards to) ───────

interface UpstreamRequest {
  method: string;
  url: string;
  host: string | undefined;
}

class FakeSteelUpstream {
  readonly requests: UpstreamRequest[] = [];
  readonly wsMessages: string[] = [];
  wsConnections = 0;
  pages: unknown[] = [{ title: 'tab' }];
  readonly debugHtml = '<html data-theme="dark"><title>fake viewer</title>';
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true });
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.requests.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host });
      if (req.url?.startsWith('/v1/sessions/default/live-details')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pages: this.pages }));
        return;
      }
      if (req.url?.startsWith('/v1/sessions/debug')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(this.debugHtml);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/v1/sessions/cast')) {
        socket.destroy();
        return;
      }
      this.requests.push({ method: 'WS', url: req.url, host: req.headers.host });
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wsConnections += 1;
        ws.send(JSON.stringify({ type: 'frame', data: 'hello' }));
        ws.on('message', (message) => {
          this.wsMessages.push(String(message));
          ws.send(`echo:${String(message)}`);
        });
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

// ── test rig ─────────────────────────────────────────────────────────────────

interface Rig {
  service: BrowserService;
  proxy: BrowserViewerProxy;
  upstreams: FakeSteelUpstream[];
  capturedOptions: SteelProcessOptions[];
  handles: FakeSteelHandle[];
  dir: string;
  now: number;
}

async function makeRig(options?: {
  sessions?: string[];
  withDomainProvider?: boolean;
  warmTimeoutMs?: number;
}): Promise<Rig> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'u7-proxy-test-'));
  const sessionIds = options?.sessions ?? ['session-a'];
  const upstreams: FakeSteelUpstream[] = [];
  for (let i = 0; i < sessionIds.length; i += 1) {
    const upstream = new FakeSteelUpstream();
    await upstream.start();
    upstreams.push(upstream);
  }
  const portQueue = upstreams.map((u) => u.port);
  const capturedOptions: SteelProcessOptions[] = [];
  const handles: FakeSteelHandle[] = [];
  const rig: Rig = {
    service: undefined as unknown as BrowserService,
    proxy: undefined as unknown as BrowserViewerProxy,
    upstreams,
    capturedOptions,
    handles,
    dir,
    now: 1_700_000_000_000,
  };
  const service = new BrowserService({
    storageDir: dir,
    maxSessions: 4,
    allocatePort: async () => {
      // Fresh sessions pop their own upstream port; crash rebuilds fall back
      // to the first upstream (the only session tests ever rebuild).
      const port = portQueue.length > 0 ? portQueue.shift()! : upstreams[0].port;
      return port;
    },
    resolveChromiumPath: async () => '/fake/chromium',
    createProcess: (opts) => {
      capturedOptions.push(opts);
      const handle = new FakeSteelHandle(opts);
      handles.push(handle);
      return handle;
    },
    cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
    now: () => rig.now,
  });
  const proxy = new BrowserViewerProxy({
    lookup: service,
    registerDomainProvider: options?.withDomainProvider
      ? (provider) => service.setViewerDomainProvider(provider)
      : undefined,
    warmTimeoutMs: options?.warmTimeoutMs ?? 5_000,
    warmIntervalMs: 25,
  });
  await proxy.start();
  rig.service = service;
  rig.proxy = proxy;
  return rig;
}

function lastHandle(rig: Rig): FakeSteelHandle {
  return rig.handles[rig.handles.length - 1];
}

async function teardownRig(rig: Rig): Promise<void> {
  await rig.proxy.stop().catch(() => undefined);
  await rig.service.shutdown().catch(() => undefined);
  for (const upstream of rig.upstreams) {
    await upstream.stop().catch(() => undefined);
  }
  rmSync(rig.dir, { recursive: true, force: true });
}

async function ensureAll(rig: Rig, sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    await rig.service.ensureSession({ sessionId, workspaceId: 'ws-1' });
  }
}

function get(
  port: number,
  urlPath: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Connects a ws client; resolves on open. The message listener is attached
 * synchronously at construction: Steel/greeting frames often arrive in the
 * same TCP chunk as the 101 handshake, so a listener attached after `await`
 * would miss them (the ws library parses the whole chunk synchronously).
 */
function wsConnect(url: string): Promise<{ ws: WebSocket; nextMessage: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: string[] = [];
    const waiters: Array<{ resolve: (m: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
    ws.on('message', (data) => {
      const text = String(data);
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(text);
      } else {
        queue.push(text);
      }
    });
    const nextMessage = (): Promise<string> =>
      new Promise<string>((res, rej) => {
        const buffered = queue.shift();
        if (buffered !== undefined) {
          res(buffered);
          return;
        }
        const timer = setTimeout(() => rej(new Error('ws message timeout')), 3_000);
        waiters.push({ resolve: res, reject: rej, timer });
      });
    ws.once('open', () => resolve({ ws, nextMessage }));
    ws.once('error', reject);
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

// ── token issuance (browser-service) ─────────────────────────────────────────

describe('viewer token issuance', () => {
  it('mints a per-session token and bakes DOMAIN into the Steel env', async () => {
    const rig = await makeRig({ withDomainProvider: true });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);

    assert.equal(rig.capturedOptions.length, 1);
    const env = rig.capturedOptions[0].env;
    assert.ok(env?.DOMAIN, 'DOMAIN must be set when a provider is wired');
    const token = rig.service.getViewerToken('session-a');
    assert.ok(token && TOKEN_RE.test(token), `token shape: ${token}`);
    assert.equal(env.DOMAIN, `127.0.0.1:${rig.proxy.port}/s/${token}`);
  });

  it('keeps DOMAIN unset without a provider (dev/test fallback)', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    assert.equal(rig.capturedOptions[0].env, undefined);
  });

  it('mints distinct tokens per session', async () => {
    const rig = await makeRig({ sessions: ['session-a', 'session-b'] });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a', 'session-b']);
    const tokenA = rig.service.getViewerToken('session-a');
    const tokenB = rig.service.getViewerToken('session-b');
    assert.ok(tokenA && tokenB);
    assert.notEqual(tokenA, tokenB);
  });

  it('reuses the same token across a crash rebuild', async () => {
    const rig = await makeRig({ withDomainProvider: true });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    assert.ok(token);
    rig.now += 1_000;
    // Crash the process -> session_lost -> next ensureSession respawns.
    lastHandle(rig).crash();
    await new Promise((r) => setImmediate(r));
    assert.equal(rig.service.getControlState('session-a'), 'session_lost');
    await ensureAll(rig, ['session-a']);
    assert.equal(rig.service.getViewerToken('session-a'), token);
    assert.equal(rig.capturedOptions.length, 2);
    assert.equal(rig.capturedOptions[1].env?.DOMAIN, `127.0.0.1:${rig.proxy.port}/s/${token}`);
  });

  it('drops the token on teardown', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    assert.ok(token);
    await rig.service.teardownSession('session-a');
    assert.equal(rig.service.getViewerToken('session-a'), undefined);
    assert.equal(rig.service.findSessionByViewerToken(token), undefined);
  });

  it('resolves token -> session with liveness for the proxy', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    assert.ok(token);
    const live = rig.service.findSessionByViewerToken(token);
    assert.equal(live?.sessionId, 'session-a');
    assert.ok(live?.info);
    lastHandle(rig).crash();
    await new Promise((r) => setImmediate(r));
    const dead = rig.service.findSessionByViewerToken(token);
    assert.equal(dead?.sessionId, 'session-a', 'token still resolves while session_lost');
    assert.equal(dead?.info, undefined);
  });

  it('generates 32-char base64url tokens', () => {
    const a = mintViewerToken();
    const b = mintViewerToken();
    assert.ok(TOKEN_RE.test(a));
    assert.ok(TOKEN_RE.test(b));
    assert.notEqual(a, b);
  });
});

// ── HTTP token enforcement ───────────────────────────────────────────────────

describe('viewer proxy HTTP auth', () => {
  it('rejects requests without a token (403 generic + XFO DENY, no ACAO)', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    for (const urlPath of ['/', '/v1/sessions/debug', '/s/', '/favicon.ico']) {
      const res = await get(rig.proxy.port, urlPath);
      assert.equal(res.status, 403, urlPath);
      assert.deepEqual(JSON.parse(res.body), { error: 'Forbidden' });
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  });

  it('rejects unknown and malformed tokens with the same generic 403', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const wrong = mintViewerToken();
    for (const token of [wrong, 'short', 'a'.repeat(64), '../../etc/passwd1234567890abcd']) {
      const res = await get(rig.proxy.port, `/s/${encodeURIComponent(token)}/v1/sessions/debug`);
      assert.equal(res.status, 403, token);
      assert.deepEqual(JSON.parse(res.body), { error: 'Forbidden' });
    }
  });

  it('rejects a torn-down session token (index cleaned on teardown)', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    await rig.service.teardownSession('session-a');
    const res = await get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    assert.equal(res.status, 403);
  });

  it('rejects a non-whitelisted Host header even with a valid token', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    const res = await get(rig.proxy.port, `/s/${token}/v1/sessions/debug`, {
      host: 'evil.example.com',
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('serves the viewer HTML for a valid token (prefix stripped, no XFO)', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    const res = await get(
      rig.proxy.port,
      `/s/${token}/v1/sessions/debug?interactive=true&theme=dark&showControls=true`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body, rig.upstreams[0].debugHtml);
    assert.equal(res.headers['x-frame-options'], undefined, 'viewer HTML must be frameable');
    const upstreamReq = rig.upstreams[0].requests.find((r) => r.url.includes('/v1/sessions/debug'));
    assert.ok(upstreamReq);
    assert.equal(
      upstreamReq.url,
      '/v1/sessions/debug?interactive=true&theme=dark&showControls=true',
      'token prefix stripped, query preserved',
    );
    assert.equal(upstreamReq.host, `127.0.0.1:${rig.upstreams[0].port}`);
  });

  it('refuses non-viewer Steel API paths for a valid token (least privilege)', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    for (const urlPath of [
      'v1/sessions',
      'v1/sessions/default/live-details',
      'v1/sessions/default/context',
      'v1/sessions/scrape',
      'v1/sessions/screenshot',
      'v1/health',
    ]) {
      const res = await get(rig.proxy.port, `/s/${token}/${urlPath}`);
      assert.equal(res.status, 404, urlPath);
      assert.equal(res.headers['x-frame-options'], 'DENY');
    }
    // Nothing but the warm-up probe and the debug fetch may reach upstream.
    const forwarded = rig.upstreams[0].requests.filter(
      (r) => !r.url.includes('/v1/sessions/default/live-details'),
    );
    assert.equal(forwarded.length, 0);
  });

  it('answers 503 fast when the Steel process is dead (session_lost)', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    lastHandle(rig).crash();
    await new Promise((r) => setImmediate(r));
    const startedAt = Date.now();
    const res = await get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    assert.equal(res.status, 503);
    assert.equal(res.headers['x-frame-options'], undefined, '503 must be frameable');
    assert.ok(
      String(res.headers['content-type']).includes('text/html'),
      '503 should return an HTML error page',
    );
    assert.ok(res.body.includes('Browser unavailable'), '503 body explains the crash state');
    assert.ok(Date.now() - startedAt < 2_000, 'must not hang');
  });
});

// ── session affinity ─────────────────────────────────────────────────────────

describe('viewer proxy session affinity', () => {
  it('routes a token only to its own session (A cannot view B)', async () => {
    const rig = await makeRig({ sessions: ['session-a', 'session-b'] });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a', 'session-b']);
    const tokenA = rig.service.getViewerToken('session-a');
    const tokenB = rig.service.getViewerToken('session-b');

    const resA = await get(rig.proxy.port, `/s/${tokenA}/v1/sessions/debug`);
    assert.equal(resA.status, 200);
    const resB = await get(rig.proxy.port, `/s/${tokenB}/v1/sessions/debug`);
    assert.equal(resB.status, 200);

    const debugA = rig.upstreams[0].requests.filter((r) => r.url.includes('/v1/sessions/debug'));
    const debugB = rig.upstreams[1].requests.filter((r) => r.url.includes('/v1/sessions/debug'));
    assert.equal(debugA.length, 1, 'token A hit upstream A exactly once');
    assert.equal(debugB.length, 1, 'token B hit upstream B exactly once');
  });

  it('exposes no session selector: token A cannot address B through any path', async () => {
    const rig = await makeRig({ sessions: ['session-a', 'session-b'] });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a', 'session-b']);
    const tokenA = rig.service.getViewerToken('session-a');
    // Try to smuggle a session-B reference through the cast query params.
    const { ws, nextMessage } = await wsConnect(
      `ws://127.0.0.1:${rig.proxy.port}/s/${tokenA}/v1/sessions/cast?pageId=anything`,
    );
    await nextMessage();
    ws.close();
    assert.equal(rig.upstreams[1].wsConnections, 0, 'upstream B must never be touched');
    assert.equal(rig.upstreams[0].wsConnections, 1);
  });
});

// ── cast WebSocket forwarding ────────────────────────────────────────────────

describe('viewer proxy cast WebSocket', () => {
  it('forwards the cast upgrade and streams frames both ways', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    const { ws, nextMessage } = await wsConnect(
      `ws://127.0.0.1:${rig.proxy.port}/s/${token}/v1/sessions/cast?tabInfo=true`,
    );
    const greeting = await nextMessage();
    assert.deepEqual(JSON.parse(greeting), { type: 'frame', data: 'hello' });
    ws.send(JSON.stringify({ type: 'mouseEvent', pageId: 'p1' }));
    const echo = await nextMessage();
    assert.ok(echo.includes('mouseEvent'));
    assert.deepEqual(rig.upstreams[0].wsMessages, [JSON.stringify({ type: 'mouseEvent', pageId: 'p1' })]);
    const upgrade = rig.upstreams[0].requests.find((r) => r.method === 'WS');
    assert.equal(upgrade?.url, '/v1/sessions/cast?tabInfo=true', 'prefix stripped on upgrade');
    ws.close();
  });

  it('rejects ws without a token and ws to non-cast paths', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    await assert.rejects(
      wsConnect(`ws://127.0.0.1:${rig.proxy.port}/v1/sessions/cast`),
      /403/,
    );
    await assert.rejects(
      wsConnect(`ws://127.0.0.1:${rig.proxy.port}/s/${token}/v1/sessions/debug`),
      /404/,
    );
    assert.equal(rig.upstreams[0].wsConnections, 0);
  });

  it('rejects ws with a bad Host header and answers 503 when Steel is dead', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${rig.proxy.port}/s/${token}/v1/sessions/cast`,
          { headers: { host: 'evil.example.com' } },
        );
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
      /403/,
    );
    lastHandle(rig).crash();
    await new Promise((r) => setImmediate(r));
    await assert.rejects(
      wsConnect(`ws://127.0.0.1:${rig.proxy.port}/s/${token}/v1/sessions/cast`),
      /503/,
    );
  });
});

// ── warm-up gate ─────────────────────────────────────────────────────────────

describe('viewer proxy warm-up gate', () => {
  it('waits for the browser to publish a page before serving the viewer', async () => {
    const rig = await makeRig({ warmTimeoutMs: 4_000 });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    rig.upstreams[0].pages = [];
    const pending = get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    await new Promise((r) => setTimeout(r, 150));
    rig.upstreams[0].pages = [{ title: 'tab' }];
    const res = await pending;
    assert.equal(res.status, 200);
    const probes = rig.upstreams[0].requests.filter((r) =>
      r.url.includes('/v1/sessions/default/live-details'),
    );
    assert.ok(probes.length >= 2, 'must have polled until a page appeared');
  });

  it('fails explicitly (503, no hang) when the browser never publishes a page', async () => {
    const rig = await makeRig({ warmTimeoutMs: 600 });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    rig.upstreams[0].pages = [];
    const startedAt = Date.now();
    const res = await get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    assert.equal(res.status, 503);
    assert.equal(res.headers['x-frame-options'], undefined, '503 must be frameable');
    assert.ok(
      String(res.headers['content-type']).includes('text/html'),
      '503 should return an HTML error page',
    );
    assert.ok(Date.now() - startedAt < 3_000);
  });

  it('re-warms after a crash rebuild (warm state keyed per process)', async () => {
    const rig = await makeRig({ warmTimeoutMs: 4_000 });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const token = rig.service.getViewerToken('session-a');
    const first = await get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    assert.equal(first.status, 200);
    const probesAfterFirst = rig.upstreams[0].requests.filter((r) =>
      r.url.includes('/v1/sessions/default/live-details'),
    ).length;

    // Second request: warm, no new probes.
    const second = await get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    assert.equal(second.status, 200);
    const probesAfterSecond = rig.upstreams[0].requests.filter((r) =>
      r.url.includes('/v1/sessions/default/live-details'),
    ).length;
    assert.equal(probesAfterSecond, probesAfterFirst);

    // Crash + rebuild at a new startedAt -> next request must re-warm.
    rig.now += 1_000;
    lastHandle(rig).crash();
    await new Promise((r) => setImmediate(r));
    await ensureAll(rig, ['session-a']);
    rig.upstreams[0].pages = [];
    const pending = get(rig.proxy.port, `/s/${token}/v1/sessions/debug`);
    await new Promise((r) => setTimeout(r, 150));
    rig.upstreams[0].pages = [{ title: 'tab' }];
    const third = await pending;
    assert.equal(third.status, 200);
  });
});

// ── origin + URL contract (U6) ───────────────────────────────────────────────

describe('viewer URL contract', () => {
  it('builds the iframe URL on the proxy origin with the session token', async () => {
    const rig = await makeRig({ withDomainProvider: true });
    cleanups.push(() => teardownRig(rig));
    await ensureAll(rig, ['session-a']);
    const url = rig.proxy.getViewerUrl('session-a');
    assert.ok(url);
    const parsed = new URL(url);
    const token = rig.service.getViewerToken('session-a');
    assert.equal(parsed.host, `127.0.0.1:${rig.proxy.port}`);
    assert.equal(
      parsed.pathname,
      `/s/${token}/v1/sessions/debug`,
    );
    assert.equal(parsed.search, '?interactive=true&theme=dark&showControls=true');
    // Different origin from both the Steel upstream and any sidecar API port:
    // the proxy is its own listener on its own port.
    assert.notEqual(rig.proxy.port, rig.upstreams[0].port);
  });

  it('returns undefined for unknown sessions and before start', async () => {
    const rig = await makeRig();
    cleanups.push(() => teardownRig(rig));
    assert.equal(rig.proxy.getViewerUrl('no-such-session'), undefined);
    const fresh = new BrowserViewerProxy({ lookup: rig.service });
    assert.equal(fresh.getViewerUrl('session-a'), undefined);
  });
});

// ── Steel loopback binding assertion ─────────────────────────────────────────

describe('steel loopback binding', () => {
  it('spawns Steel bound to 127.0.0.1 with no listener reachable off-loopback', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'u7-bind-test-'));
    cleanups.push(async () => {
      rmSync(dir, { recursive: true, force: true });
    });
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const proc = new SteelProcess(
      {
        sessionId: 'bind-test',
        port,
        userDataDir: path.join(dir, 'profile'),
        pidfilePath: path.join(dir, 'pid.json'),
      },
      { spawnSpec: () => ({ command: process.execPath, args: [FIXTURE] }) },
    );
    cleanups.push(async () => {
      await proc.stop().catch(() => undefined);
    });
    await proc.start();

    // The fixture echoes the address it bound (HOST comes from SteelProcess).
    const health = await get(port, '/v1/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).address, '127.0.0.1');

    // No socket may answer off-loopback: connecting via any non-loopback
    // local address must be refused.
    const lanAddresses = Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (i): i is os.NetworkInterfaceInfo =>
          !!i && i.family === 'IPv4' && !i.internal,
      )
      .map((i) => i.address);
    for (const lanIp of lanAddresses) {
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          const socket = net.connect(port, lanIp);
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('connect timeout'));
          }, 1_000);
          socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve();
          });
          socket.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        }),
        undefined,
        `Steel port ${port} must not accept connections on ${lanIp}`,
      );
    }
  });
});
