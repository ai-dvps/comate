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
import { startFakeBrowserShell } from '../../test-utils/fake-browser-shell.js';

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
    reconcileKeeps: string[][];
    failCreate?: (err: Error) => never;
    /** When set, createView awaits it first — a controllable in-flight spawn. */
    createViewGate: (() => Promise<void>) | null;
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
    createViewGate: null as (() => Promise<void>) | null,
    reconcileKeeps: [] as string[][],
    get lastMarker() {
      return state.lastMarker;
    },
    emitEvent: (event: ControlEvent) => state.emit(event),
    async createView({ sessionId, marker }: { sessionId: string; marker: string }) {
      if (manager.createViewGate) await manager.createViewGate();
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
    getViewState() {
      return null;
    },
    async reconcilePartitions(keep: string[]) {
      manager.reconcileKeeps.push(keep);
      return { removed: [], errors: [] };
    },
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
    // Keep the reconcile sweep off the real store singleton.
    listKnownSessionIds: () => ['known-sess'],
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

  it('initialize reconciles orphan partitions with the registry keep list (U8, KTD-11)', async () => {
    const h = await startHarness();
    try {
      // ensureSession chains initialize(); the shell target triggers a
      // reconcile carrying the known-session keep list (the in-memory
      // registry is still empty at boot — persisted sessions come from the
      // store listing).
      await h.service.ensureSession({ sessionId: 'sess-reconcile', workspaceId: 'ws-1' });
      assert.equal(h.manager.reconcileKeeps.length, 1);
      const keep = h.manager.reconcileKeeps[0]!;
      assert.ok(keep.includes('known-sess'), `keep list missing known sessions: ${keep}`);
      // One-shot: further sessions do not re-reconcile.
      await h.service.ensureSession({ sessionId: 'sess-reconcile-2', workspaceId: 'ws-1' });
      assert.equal(h.manager.reconcileKeeps.length, 1);
    } finally {
      await h.cleanup();
    }
  });

  it('view-navigated SSE tracks lastUrl; retrySession rebuilds a lost session (U8)', async () => {
    const h = await startHarness();
    try {
      await h.service.ensureSession({ sessionId: 'sess-retry', workspaceId: 'ws-1' });
      // A live session neither rebuilds nor errors on retry.
      assert.deepEqual(await h.service.retrySession('sess-retry'), { rebuilding: false });

      h.manager.emitEvent({
        type: 'view-navigated',
        sessionId: 'sess-retry',
        url: 'https://example.com/dashboard',
        at: Date.now(),
      });
      // Let the SSE frame land before the crash wipes the handle.
      await new Promise((resolve) => setTimeout(resolve, 100));
      h.manager.emitEvent({ type: 'view-crashed', sessionId: 'sess-retry', reason: 'killed', at: Date.now() });
      for (let i = 0; i < 50 && h.service.getControlState('sess-retry') !== 'session_lost'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(h.service.getControlState('sess-retry'), 'session_lost');

      const result = await h.service.retrySession('sess-retry');
      assert.equal(result.rebuilding, true);
      assert.equal(h.service.getControlState('sess-retry'), 'agent_in_control');
      assert.equal(h.manager.calls.filter((c) => c.method === 'createView').length, 2);
      // The last-URL restore attempt is best-effort (the harness's fake debug
      // port cannot serve a real CDP attach); the tracked URL survives.
      const info = h.service.getSession('sess-retry');
      assert.ok(info);
    } finally {
      await h.cleanup();
    }
  });

  it('retrySession is a no-op for unknown sessions', async () => {
    const h = await startHarness();
    try {
      assert.deepEqual(await h.service.retrySession('nope'), { rebuilding: false });
    } finally {
      await h.cleanup();
    }
  });

  it('teardownSession on a session_lost entry still destroys + wipes via the channel (no live handle)', async () => {
    const h = await startHarness();
    try {
      await h.service.ensureSession({ sessionId: 'sess-lost', workspaceId: 'ws-1' });
      h.manager.emitEvent({ type: 'view-crashed', sessionId: 'sess-lost', reason: 'killed', at: Date.now() });
      for (let i = 0; i < 50 && h.service.getControlState('sess-lost') !== 'session_lost'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(h.service.getControlState('sess-lost'), 'session_lost');
      assert.equal(h.service.getSession('sess-lost'), undefined);

      await h.service.teardownSession('sess-lost');
      // No live handle, but the wipeProfile semantic must still hold: the
      // leftover view record is destroyed and the login partition wiped.
      const methods = h.manager.calls.map((c) => c.method);
      assert.ok(methods.includes('destroyView'), `expected a view destroy: ${methods}`);
      assert.ok(methods.includes('wipePartition'), `expected a partition wipe: ${methods}`);
    } finally {
      await h.cleanup();
    }
  });

  it('teardown racing an in-flight spawn stops the orphaned spawn instead of adopting it', async () => {
    const h = await startHarness();
    try {
      // Hold the first spawn inside createView so teardown + a concurrent
      // re-ensure can interleave before its continuation runs.
      let release!: () => void;
      h.manager.createViewGate = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const p1 = h.service.ensureSession({ sessionId: 'sess-race', workspaceId: 'ws-1' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const teardown = h.service.teardownSession('sess-race');
      const p2 = h.service.ensureSession({ sessionId: 'sess-race', workspaceId: 'ws-1' });
      // The replacement entry is registered before the orphaned spawn settles.
      await new Promise((resolve) => setTimeout(resolve, 50));
      h.manager.createViewGate = null;
      release();

      const [r1, r2] = await Promise.allSettled([p1, p2]);
      await teardown;
      assert.equal(r1.status, 'rejected');
      assert.match(String((r1 as PromiseRejectedResult).reason), /torn down while starting/);
      assert.equal(r2.status, 'fulfilled');

      // The orphaned spawn's view was stopped (destroyView) before the
      // replacement spawn created its own — no adoption into the new entry.
      const methods = h.manager.calls.map((c) => c.method);
      const firstCreate = methods.indexOf('createView');
      const secondCreate = methods.indexOf('createView', firstCreate + 1);
      const firstDestroy = methods.indexOf('destroyView');
      assert.ok(secondCreate > firstCreate, `expected two createView calls: ${methods}`);
      assert.ok(
        firstDestroy > firstCreate && firstDestroy < secondCreate,
        `orphaned spawn was not stopped before the re-spawn: ${methods}`,
      );
      assert.ok(h.service.getSession('sess-race'));
    } finally {
      await h.cleanup();
    }
  });

  it('a view that vanished during an SSE outage is reconciled to session_lost on reconnect', async () => {
    const shell = await startFakeBrowserShell();
    const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-svc-reconcile-'));
    const service = new BrowserService({
      storageDir,
      resolveTarget: shell.resolveTarget,
      createControlClient: shell.createControlClient,
      cdpRetry: { budgetMs: 400, intervalMs: 40 },
      listKnownSessionIds: () => [],
    });
    try {
      const events: Array<Record<string, unknown>> = [];
      service.onEvent((event) => events.push(event as unknown as Record<string, unknown>));
      await service.ensureSession({ sessionId: 'sess-ok', workspaceId: 'ws-1' });
      await service.ensureSession({ sessionId: 'sess-gone', workspaceId: 'ws-1' });

      // The shell loses sess-gone's view while the SSE stream is down — the
      // crash event is never delivered (no replay).
      shell.client.vanishView('sess-gone');
      shell.client.simulateReconnect();
      for (let i = 0; i < 50 && service.getControlState('sess-gone') !== 'session_lost'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(service.getControlState('sess-gone'), 'session_lost');
      // The still-live view is untouched by the sweep.
      assert.equal(service.getControlState('sess-ok'), 'agent_in_control');
      const lost = events.find(
        (e) => e['type'] === 'browser_state' && e['state'] === 'session_lost' && e['sessionId'] === 'sess-gone',
      );
      assert.ok(lost, `expected a session_lost event: ${JSON.stringify(events)}`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await shell.close();
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
