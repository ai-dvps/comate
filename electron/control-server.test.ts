import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createControlServer,
  createElectronViewManager,
  type ControlEvent,
  type ControlServerHandle,
  type ControlViewManager,
  type ViewRect,
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
  views?: ControlViewManager;
  quitting?: { value: boolean };
}): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const quitting = overrides?.quitting ?? { value: false };
  const manager: ControlViewManager = overrides?.views ?? {
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
});

// ---------------------------------------------------------------------------
// Electron view manager (fake view/session factories — no electron import)
// ---------------------------------------------------------------------------

interface FakeWebContents extends Record<string, unknown> {
  handlers: Map<string, Array<(...args: never[]) => void>>;
  openHandler: ((details: { url: string }) => unknown) | null;
  loadedUrls: string[];
  destroyed: boolean;
}

function makeFakeView(prefs: Record<string, unknown>) {
  const webContents: FakeWebContents = {
    handlers: new Map(),
    openHandler: null,
    loadedUrls: [],
    destroyed: false,
    async loadURL(url: string) {
      webContents.loadedUrls.push(url);
    },
    on(event: string, listener: (...args: never[]) => void) {
      const list = webContents.handlers.get(event) ?? [];
      list.push(listener);
      webContents.handlers.set(event, list);
    },
    destroy() {
      webContents.destroyed = true;
      for (const listener of webContents.handlers.get('destroyed') ?? []) listener();
    },
    isDestroyed: () => webContents.destroyed,
    setWindowOpenHandler(handler: never) {
      webContents.openHandler = handler as FakeWebContents['openHandler'];
    },
    getLastWebPreferences: () => prefs,
  };
  const view = {
    webContents,
    boundsSet: [] as ViewRect[],
    setBounds(rect: ViewRect) {
      view.boundsSet.push(rect);
    },
  };
  return view;
}

describe('electron view manager (KTD-10/KTD-16)', () => {
  function setup() {
    const events: ControlEvent[] = [];
    const sessions = new Map<string, { clearedStorage: number; clearedCache: number; permissionHandler: unknown }>();
    const views: ReturnType<typeof makeFakeView>[] = [];
    const manager = createElectronViewManager({
      createViewImpl: (options) => {
        const view = makeFakeView(options.webPreferences);
        views.push(view);
        return view as never;
      },
      sessionFromPartition: (partition) => {
        let ses = sessions.get(partition);
        if (!ses) {
          ses = { clearedStorage: 0, clearedCache: 0, permissionHandler: null };
          sessions.set(partition, ses);
        }
        return {
          setPermissionRequestHandler(handler: never) {
            ses!.permissionHandler = handler;
          },
          setPermissionCheckHandler() {},
          async clearStorageData() {
            ses!.clearedStorage += 1;
          },
          async clearCache() {
            ses!.clearedCache += 1;
          },
        } as never;
      },
      onEvent: (event) => events.push(event),
    });
    return { manager, events, sessions, views };
  }

  it('creates an unattached sized view on a per-session partition and loads the marker', async () => {
    const { manager, views } = setup();
    const created = await manager.createView({ sessionId: 's1', marker: 'comate-view-x' });
    assert.equal(created.partition, 'persist:comate-browser-s1');
    assert.deepEqual(views[0]!.webContents.loadedUrls, ['about:blank#comate-view-x']);
    assert.deepEqual(views[0]!.boundsSet, [{ x: 0, y: 0, width: 1280, height: 800 }]);
    assert.equal(manager.size(), 1);
    // KTD-16 attestation straight from getLastWebPreferences.
    assert.deepEqual(created.webPreferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: null,
    });
    const prefs = (views[0]!.webContents.getLastWebPreferences as () => Record<string, unknown>)();
    assert.equal(prefs['sandbox'], true);
    assert.equal(prefs['contextIsolation'], true);
    assert.equal(prefs['nodeIntegration'], false);
    assert.equal(prefs['preload'], undefined);
    assert.equal(prefs['partition'], 'persist:comate-browser-s1');
  });

  it('rejects a duplicate view for the same session', async () => {
    const { manager } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm1' });
    await assert.rejects(() => manager.createView({ sessionId: 's1', marker: 'm2' }), /already exists/);
  });

  it('locks same-partition popups to the same webPreferences and denies non-web schemes', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    const handler = views[0]!.webContents.openHandler!;
    const popup = handler({ url: 'https://accounts.example.com/oauth' }) as {
      action: string;
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    assert.equal(popup.action, 'allow');
    const popupPrefs = popup.overrideBrowserWindowOptions.webPreferences;
    assert.equal(popupPrefs['sandbox'], true);
    assert.equal(popupPrefs['nodeIntegration'], false);
    assert.equal(popupPrefs['partition'], 'persist:comate-browser-s1');
    assert.equal(popupPrefs['preload'], undefined);
    assert.equal((handler({ url: 'file:///etc/passwd' }) as { action: string }).action, 'deny');
  });

  it('emits view-crashed on render-process-gone and view-destroyed on destroy', async () => {
    const { manager, events, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    for (const listener of views[0]!.webContents.handlers.get('render-process-gone') ?? []) {
      (listener as (...a: unknown[]) => void)({}, { reason: 'killed' });
    }
    assert.deepEqual(events[0], { type: 'view-crashed', sessionId: 's1', reason: 'killed', at: events[0]!.at });
    await manager.destroyView('s1');
    assert.equal(views[0]!.webContents.destroyed, true);
    assert.equal(events.at(-1)?.type, 'view-destroyed');
    assert.equal(manager.size(), 0);
    assert.equal(await manager.destroyView('s1'), false);
  });

  it('wipes a partition: destroys the live view and clears storage + cache', async () => {
    const { manager, sessions, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'm' });
    await manager.wipePartition('s1');
    assert.equal(views[0]!.webContents.destroyed, true);
    const ses = sessions.get('persist:comate-browser-s1')!;
    assert.equal(ses.clearedStorage, 1);
    assert.equal(ses.clearedCache, 1);
    assert.notEqual(ses.permissionHandler, null, 'deny-by-default permission handler installed');
  });

  it('destroyAll tears down every live view', async () => {
    const { manager, views } = setup();
    await manager.createView({ sessionId: 's1', marker: 'a' });
    await manager.createView({ sessionId: 's2', marker: 'b' });
    await manager.destroyAll();
    assert.equal(manager.size(), 0);
    assert.ok(views.every((v) => v.webContents.destroyed));
  });
});
