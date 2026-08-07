import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { BrowserService, BrowserUnavailableError } from '../browser-service.js';
import { ShellViewHandle } from '../browser-shell-client.js';
import {
  createControlServer,
  type ControlEvent,
  type ControlServerHandle,
  type ControlViewManager,
} from '../../../../electron/control-server.js';

/**
 * Native browser path (U7): BrowserService against the REAL shell control
 * channel (electron/control-server is electron-free by design) + a fake
 * /json debug-port endpoint. Covers spawn via control channel + marker
 * resolution, crash → session_lost → auto-reconnect, teardown wipe, and the
 * failure classification the health endpoint surfaces.
 */

const TOKEN = 'boot-token';

interface ShellHarness {
  service: BrowserService;
  control: ControlServerHandle;
  debugPort: number;
  controlPort: number;
  manager: ControlViewManager & {
    calls: Array<{ method: string; sessionId: string }>;
    emitEvent: (event: ControlEvent) => void;
    lastMarker: string | null;
    failCreate?: (err: Error) => never;
  };
  jsonServer: Server;
  cleanup: () => Promise<void>;
}

async function startHarness(options?: { serveJson?: boolean }): Promise<ShellHarness> {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-svc-shell-'));
  const calls: Array<{ method: string; sessionId: string }> = [];
  const state: { lastMarker: string | null; emit: (event: ControlEvent) => void } = {
    lastMarker: null,
    emit: () => undefined,
  };
  const manager = {
    calls,
    failCreate: undefined as ((err: Error) => never) | undefined,
    get lastMarker() {
      return state.lastMarker;
    },
    emitEvent: (event: ControlEvent) => state.emit(event),
    async createView({ sessionId, marker }: { sessionId: string; marker: string }) {
      if (manager.failCreate) manager.failCreate(new Error('renderer exploded'));
      calls.push({ method: 'createView', sessionId });
      state.lastMarker = marker;
      return {
        partition: `persist:comate-browser-${sessionId}`,
        targetMarker: marker,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null },
      };
    },
    async destroyView(sessionId: string) {
      calls.push({ method: 'destroyView', sessionId });
      return true;
    },
    async wipePartition(sessionId: string) {
      calls.push({ method: 'wipePartition', sessionId });
    },
    async setViewBounds() {},
  };
  const control = await createControlServer({
    token: TOKEN,
    views: manager,
    isQuitting: () => false,
  });
  state.emit = (event) => control.emit(event);

  // Fake debug port: /json/list echoes the last view's marker URL.
  const jsonServer = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 'UI-TARGET', type: 'page', url: 'app.comate://localhost/index.html' },
          ...(state.lastMarker
            ? [{ id: 'VIEW-TARGET-1', type: 'page', url: `about:blank#${state.lastMarker}` }]
            : []),
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jsonServer.listen(0, '127.0.0.1', () => resolve()));
  const address = jsonServer.address();
  if (!address || typeof address === 'string') throw new Error('json server did not bind');

  const service = new BrowserService({
    storageDir,
    resolveTarget: () => ({
      kind: 'shell',
      debugPort: options?.serveJson === false ? 1 : address.port,
      controlPort: control.port,
      controlToken: TOKEN,
    }),
    cdpRetry: { budgetMs: 400, intervalMs: 40 },
  });

  return {
    service,
    control,
    controlPort: control.port,
    debugPort: address.port,
    manager: manager as ShellHarness['manager'],
    jsonServer,
    cleanup: async () => {
      await service.shutdown().catch(() => undefined);
      await control.close().catch(() => undefined);
      await new Promise<void>((resolve) => jsonServer.close(() => resolve()));
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

describe('BrowserService native shell path (U7, KTD-6/KTD-10/KTD-11)', () => {
  it('ensureSession creates a view via the control channel and pins its CDP target', async () => {
    const h = await startHarness();
    try {
      const info = await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });
      assert.equal(info.state, 'agent_in_control');
      assert.match(info.baseUrl, /\/__comate-cdp__\/t\/VIEW-TARGET-1$/);
      assert.equal(info.port, h.debugPort);
      assert.equal(info.pid, undefined);
      assert.equal(info.userDataDir, 'partition:persist:comate-browser-sess-1');
      assert.deepEqual(
        h.manager.calls.map((c) => c.method),
        ['createView'],
      );
      // Rebind: a second ensureSession reuses the live view (KTD-5 parity).
      const again = await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: 'ws-1' });
      assert.equal(again.baseUrl, info.baseUrl);
      assert.equal(h.manager.calls.length, 1);
    } finally {
      await h.cleanup();
    }
  });

  it('view-crashed SSE event → session_lost → next ensureSession auto-reconnects once', async () => {
    const h = await startHarness();
    try {
      const events: Array<Record<string, unknown>> = [];
      h.service.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      await h.service.ensureSession({ sessionId: 'sess-2', workspaceId: 'ws-1' });
      const handle = h.service.getSession('sess-2');
      assert.ok(handle);

      h.manager.emitEvent({ type: 'view-crashed', sessionId: 'sess-2', reason: 'killed', at: Date.now() });
      // The event travels the real SSE stream — poll for the transition.
      for (let i = 0; i < 50 && h.service.getControlState('sess-2') !== 'session_lost'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(h.service.getControlState('sess-2'), 'session_lost');
      assert.equal(h.service.getSession('sess-2'), undefined);
      const lost = events.find((e) => e['type'] === 'browser_state' && e['state'] === 'session_lost');
      assert.ok(lost, `expected a session_lost event: ${JSON.stringify(events)}`);
      assert.match(String(lost['reason']), /crashed or was destroyed/);

      // Auto-reconnect: the next tool call's ensureSession respawns the view.
      const rebuilt = await h.service.ensureSession({ sessionId: 'sess-2', workspaceId: 'ws-1' });
      assert.equal(rebuilt.state, 'agent_in_control');
      assert.equal(h.manager.calls.filter((c) => c.method === 'createView').length, 2);
    } finally {
      await h.cleanup();
    }
  });

  it('teardownSession destroys the view and wipes the partition via the channel', async () => {
    const h = await startHarness();
    try {
      await h.service.ensureSession({ sessionId: 'sess-3', workspaceId: 'ws-1' });
      await h.service.teardownSession('sess-3');
      assert.deepEqual(
        h.manager.calls.map((c) => c.method),
        ['createView', 'destroyView', 'wipePartition'],
      );
    } finally {
      await h.cleanup();
    }
  });

  it('control channel unreachable → browser_start_failed + control_channel classification', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-svc-shell-down-'));
    const service = new BrowserService({
      storageDir,
      resolveTarget: () => ({ kind: 'shell', debugPort: 1, controlPort: 1, controlToken: TOKEN }),
      cdpRetry: { budgetMs: 200, intervalMs: 40 },
    });
    try {
      await assert.rejects(
        service.ensureSession({ sessionId: 'sess-4', workspaceId: 'ws-1' }),
        (err: unknown) => {
          assert.ok(err instanceof BrowserUnavailableError);
          assert.equal(err.code, 'browser_start_failed');
          assert.match(err.message, /control channel is unreachable/);
          return true;
        },
      );
      assert.equal(service.getLastShellError()?.kind, 'control_channel');
    } finally {
      await service.shutdown().catch(() => undefined);
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('debug port not exposing the view → debug_port classification (cold-start budget)', async () => {
    const h = await startHarness({ serveJson: false });
    try {
      await assert.rejects(
        h.service.ensureSession({ sessionId: 'sess-5', workspaceId: 'ws-1' }),
        /debug port did not expose/,
      );
      assert.equal(h.service.getLastShellError()?.kind, 'debug_port');
      // The orphan view is cleaned up best-effort.
      assert.deepEqual(
        h.manager.calls.map((c) => c.method),
        ['createView', 'destroyView'],
      );
    } finally {
      await h.cleanup();
    }
  });

  it('view creation rejected by the shell → view_creation classification', async () => {
    const h = await startHarness();
    try {
      h.manager.failCreate = (err) => {
        throw err;
      };
      await assert.rejects(
        h.service.ensureSession({ sessionId: 'sess-6', workspaceId: 'ws-1' }),
        /could not create the browser view/,
      );
      assert.equal(h.service.getLastShellError()?.kind, 'view_creation');
    } finally {
      await h.cleanup();
    }
  });

  it('misconfigured override fails loud with the env-var guidance', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-svc-shell-mis-'));
    const service = new BrowserService({
      storageDir,
      resolveTarget: () => ({ kind: 'misconfigured', reason: 'COMATE_BROWSER_CDP_TARGET=shell but …' }),
    });
    try {
      await assert.rejects(
        service.ensureSession({ sessionId: 'sess-7', workspaceId: 'ws-1' }),
        /COMATE_BROWSER_CDP_TARGET/,
      );
    } finally {
      await service.shutdown().catch(() => undefined);
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('concurrent shell sessions get independent views and targets', async () => {
    const h = await startHarness();
    try {
      const [a, b] = await Promise.all([
        h.service.ensureSession({ sessionId: 'sess-a', workspaceId: 'ws-1' }),
        h.service.ensureSession({ sessionId: 'sess-b', workspaceId: 'ws-1' }),
      ]);
      assert.notEqual(a.sessionId, b.sessionId);
      assert.equal(h.manager.calls.filter((c) => c.method === 'createView').length, 2);
      // Both handles are shell views; teardown wipes each partition.
      await h.service.teardownWorkspace('ws-1');
      assert.equal(h.manager.calls.filter((c) => c.method === 'wipePartition').length, 2);
    } finally {
      await h.cleanup();
    }
  });

  it('ShellViewHandle.stop falls back to closing the external target when no client', async () => {
    // External-mode handle: no control client — stop() must not throw even
    // when the endpoint is gone (best-effort teardown).
    const handle = new ShellViewHandle({
      sessionId: 'ext-1',
      debugPort: 1,
      targetId: 'T',
      browserContextId: 'ctx-1',
    });
    await handle.stop();
    await handle.wipe();
    assert.equal(handle.baseUrl, 'http://127.0.0.1:1/__comate-cdp__/t/T');
    assert.equal(handle.userDataDir, 'cdp-context:ctx-1');
    assert.equal(await handle.probeHealth(), false);
  });
});
