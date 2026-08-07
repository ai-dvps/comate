import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createControlServer,
  type ControlEvent,
  type ControlServerHandle,
  type ControlViewManager,
} from './control-server';

const TOKEN = 'test-boot-token';

interface Harness {
  server: ControlServerHandle;
  base: string;
  manager: ControlViewManager;
  calls: Array<{ method: string; args: unknown[] }>;
  quitting: { value: boolean };
}

async function startServer(overrides?: {
  views?: Partial<ControlViewManager>;
  quitting?: { value: boolean };
}): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const quitting = overrides?.quitting ?? { value: false };
  const manager: ControlViewManager = {
    async createView({ sessionId, marker }) {
      calls.push({ method: 'createView', args: [sessionId, marker] });
      return {
        partition: `persist:comate-browser-${sessionId}`,
        targetMarker: marker,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null },
      };
    },
    async destroyView(sessionId) {
      calls.push({ method: 'destroyView', args: [sessionId] });
      return true;
    },
    async wipePartition(sessionId) {
      calls.push({ method: 'wipePartition', args: [sessionId] });
    },
    async setViewBounds(sessionId, rect) {
      calls.push({ method: 'setViewBounds', args: [sessionId, rect] });
    },
    getViewState(sessionId) {
      calls.push({ method: 'getViewState', args: [sessionId] });
      return sessionId === 'live' ? { attached: true, visible: true } : null;
    },
    async reconcilePartitions(keep) {
      calls.push({ method: 'reconcilePartitions', args: [keep] });
      return { removed: ['orphan-1'], errors: [] };
    },
    ...overrides?.views,
  };
  const server = await createControlServer({
    token: TOKEN,
    views: manager,
    isQuitting: () => quitting.value,
  });
  return { server, base: `http://127.0.0.1:${server.port}`, manager, calls, quitting };
}

function authed(base: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
}

describe('control server auth + lifecycle endpoints (KTD-11)', () => {
  it('rejects missing and wrong tokens with 401', async () => {
    const h = await startServer();
    try {
      assert.equal((await fetch(`${h.base}/health`)).status, 401);
      assert.equal(
        (await fetch(`${h.base}/health`, { headers: { authorization: 'Bearer nope' } })).status,
        401,
      );
      const ok = await authed(h.base, '/health');
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, quitting: false });
    } finally {
      await h.server.close();
    }
  });

  it('creates views with partition + marker + KTD-16 webPreferences attestation', async () => {
    const h = await startServer();
    try {
      const res = await authed(h.base, '/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', marker: 'comate-view-tok' }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.partition, 'persist:comate-browser-sess-1');
      assert.equal(body.targetMarker, 'comate-view-tok');
      assert.deepEqual(body.webPreferences, {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: null,
      });
      assert.deepEqual(h.calls[0], { method: 'createView', args: ['sess-1', 'comate-view-tok'] });
    } finally {
      await h.server.close();
    }
  });

  it('rejects unsafe session ids (partition-name injection)', async () => {
    const h = await startServer();
    try {
      for (const sessionId of ['../evil', 'a/b', 'a b', '', 'x'.repeat(200)]) {
        const res = await authed(h.base, '/views', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, marker: 'm' }),
        });
        assert.equal(res.status, 400, `sessionId ${JSON.stringify(sessionId)}`);
      }
      assert.equal(h.calls.length, 0);
    } finally {
      await h.server.close();
    }
  });

  it('rejects view creation while quitting (409) and maps creation failures to 502', async () => {
    const quitting = { value: true };
    const h = await startServer({ quitting });
    try {
      const res = await authed(h.base, '/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', marker: 'm' }),
      });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: string }).error, 'quitting');
    } finally {
      await h.server.close();
    }

    const failing = await startServer({
      views: {
        createView: async () => {
          throw new Error('renderer exploded');
        },
        destroyView: async () => false,
        wipePartition: async () => undefined,
        setViewBounds: async () => undefined,
      },
    });
    try {
      const res = await authed(failing.base, '/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', marker: 'm' }),
      });
      assert.equal(res.status, 502);
      assert.equal(((await res.json()) as { error: string }).error, 'view_creation_failed');
    } finally {
      await failing.server.close();
    }
  });

  it('destroys views, wipes partitions, stores bounds rects', async () => {
    const h = await startServer();
    try {
      const del = await authed(h.base, '/views/sess-9', { method: 'DELETE' });
      assert.deepEqual(await del.json(), { ok: true, destroyed: true });
      const wipe = await authed(h.base, '/partitions/sess-9/wipe', { method: 'POST' });
      assert.equal(wipe.status, 200);
      const bounds = await authed(h.base, '/views/sess-9/bounds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 1, y: 2, width: 300, height: 200 }),
      });
      assert.equal(bounds.status, 200);
      assert.deepEqual(
        h.calls.map((c) => c.method),
        ['destroyView', 'wipePartition', 'setViewBounds'],
      );
      const badRect = await authed(h.base, '/views/sess-9/bounds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 1, y: 2, width: 'wide', height: 200 }),
      });
      assert.equal(badRect.status, 400);
    } finally {
      await h.server.close();
    }
  });

  it('streams view events over SSE to authorized subscribers', async () => {
    const h = await startServer();
    try {
      const controller = new AbortController();
      const res = await authed(h.base, '/events', { signal: controller.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = res.body!.getReader();
      const event: ControlEvent = { type: 'view-crashed', sessionId: 's1', reason: 'killed', at: 1 };
      h.server.emit(event);
      const decoder = new TextDecoder();
      let text = '';
      for (let i = 0; i < 10 && !text.includes('view-crashed'); i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      controller.abort();
      assert.ok(text.includes('"type":"view-crashed"'), `SSE stream missing event: ${text}`);
      assert.ok(text.includes('"sessionId":"s1"'), text);
    } finally {
      await h.server.close();
    }
  });

  it('serves the U8 view-state attestation (404 for unknown sessions)', async () => {
    const h = await startServer();
    try {
      const live = await authed(h.base, '/views/live');
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { ok: true, state: { attached: true, visible: true } });
      const missing = await authed(h.base, '/views/nope');
      assert.equal(missing.status, 404);
      assert.deepEqual(
        h.calls.map((c) => c.method),
        ['getViewState', 'getViewState'],
      );
    } finally {
      await h.server.close();
    }
  });

  it('reconciles partitions against a validated keep list (KTD-11)', async () => {
    const h = await startServer();
    try {
      const res = await authed(h.base, '/partitions/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keep: ['sess-1', 'sess-2'] }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, removed: ['orphan-1'], errors: [] });
      assert.deepEqual(h.calls[0], { method: 'reconcilePartitions', args: [['sess-1', 'sess-2']] });

      for (const bad of [{ keep: ['../evil'] }, { keep: 'sess-1' }, {}, { keep: ['ok', 42] }]) {
        const rejected = await authed(h.base, '/partitions/reconcile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bad),
        });
        assert.equal(rejected.status, 400, JSON.stringify(bad));
      }
      assert.equal(h.calls.length, 1, 'invalid keep lists never reach the manager');
    } finally {
      await h.server.close();
    }
  });
});

// The Electron view manager tests moved to browser-view-manager.test.ts in U8.
