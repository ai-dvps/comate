import '../../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createServer, type Server } from 'node:http';
import {
  BrowserService,
  BrowserUnavailableError,
  DEFAULT_MAX_BROWSER_SESSIONS,
  type BrowserServiceDeps,
  type BrowserServiceEvent,
} from '../browser-service.js';
import {
  commitSessionNavigation,
  getVisitedDomains,
  isSubmitSemanticsRef,
  setSubmitSemanticsRefs,
} from '../browser-gate-state.js';
import type { ShellControlClient, ShellViewEvent } from '../browser-shell-client.js';

/**
 * browser-service orchestration tests (U9: native stack). The registry/state
 * machine runs against an injected fake control client (createView /
 * destroyView / wipePartition / event stream) plus a fake /json debug-port
 * endpoint — fast and deterministic. The REAL control channel + SSE stream
 * are covered end to end in browser-service-shell.test.ts.
 */

class FakeControlClient {
  readonly calls: Array<{ method: string; sessionId?: string }> = [];
  readonly reconcileKeeps: string[][] = [];
  lastMarker: string | null = null;
  failCreate: Error | null = null;
  /** Set by tests to gate createView completion (spawn/teardown race). */
  createViewGate: (() => void) | null = null;
  private listener: ((event: ShellViewEvent) => void) | null = null;

  async createView({ sessionId, marker }: { sessionId: string; marker: string }) {
    this.calls.push({ method: 'createView', sessionId });
    if (this.failCreate) throw this.failCreate;
    this.lastMarker = marker;
    if (this.createViewGate) {
      await new Promise<void>((resolve) => {
        this.createViewGate = resolve;
      });
    }
    return {
      partition: `persist:comate-browser-${sessionId}`,
      targetMarker: marker,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null },
    };
  }

  async destroyView(sessionId: string) {
    this.calls.push({ method: 'destroyView', sessionId });
    return true;
  }

  async wipePartition(sessionId: string) {
    this.calls.push({ method: 'wipePartition', sessionId });
  }

  async reconcilePartitions(keep: string[]) {
    this.reconcileKeeps.push(keep);
    return { removed: [], errors: [] };
  }

  subscribeEvents(listener: (event: ShellViewEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  /** Synchronous stand-in for the shell's SSE stream. */
  emit(event: ShellViewEvent): void {
    this.listener?.(event);
  }
}

interface FakeHarness {
  service: BrowserService;
  client: FakeControlClient;
  events: BrowserServiceEvent[];
  releasedCards: string[];
  jsonServer: Server;
  debugPort: number;
  deps: Partial<BrowserServiceDeps> & { storageDir: string };
}

function createHarness(overrides?: {
  maxSessions?: number;
  /** Resolve to a misconfigured target instead of the fake shell. */
  misconfiguredReason?: string;
  /** Serve the created view's marker on /json/list (default true). */
  serveJson?: boolean;
}): FakeHarness {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-svc-test-'));
  const client = new FakeControlClient();
  const events: BrowserServiceEvent[] = [];
  const releasedCards: string[] = [];
  const serveJson = overrides?.serveJson !== false;

  // Fake debug port: /json/list echoes the last view's marker URL.
  const jsonServer = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 'UI-TARGET', type: 'page', url: 'app.comate://localhost/index.html' },
          ...(serveJson && client.lastMarker
            ? [{ id: 'VIEW-TARGET-1', type: 'page', url: `about:blank#${client.lastMarker}` }]
            : []),
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const harness: FakeHarness = {
    service: undefined as unknown as BrowserService,
    client,
    events,
    releasedCards,
    jsonServer,
    debugPort: 0,
    deps: undefined as unknown as FakeHarness['deps'],
  };
  harness.deps = {
    storageDir,
    maxSessions: overrides?.maxSessions ?? DEFAULT_MAX_BROWSER_SESSIONS,
    resolveTarget: () =>
      overrides?.misconfiguredReason
        ? { kind: 'misconfigured', reason: overrides.misconfiguredReason }
        : { kind: 'shell', debugPort: harness.debugPort, controlPort: 1, controlToken: 'tok' },
    createControlClient: () => client as unknown as ShellControlClient,
    cdpRetry: { budgetMs: 400, intervalMs: 40 },
    // Keep the reconcile sweep off the real store singleton.
    listKnownSessionIds: () => ['known-sess'],
  };
  harness.service = new BrowserService(harness.deps);
  harness.service.onEvent((event) => events.push(event));
  harness.service.onPendingCardRelease((sessionId) => releasedCards.push(sessionId));
  return harness;
}

function stateEvents(
  events: BrowserServiceEvent[],
  state: string,
): Extract<BrowserServiceEvent, { type: 'browser_state' }>[] {
  return events.filter(
    (event): event is Extract<BrowserServiceEvent, { type: 'browser_state' }> =>
      event.type === 'browser_state' && event.state === state,
  );
}

function unavailableEvents(
  events: BrowserServiceEvent[],
): Extract<BrowserServiceEvent, { type: 'browser_unavailable' }>[] {
  return events.filter(
    (event): event is Extract<BrowserServiceEvent, { type: 'browser_unavailable' }> =>
      event.type === 'browser_unavailable',
  );
}

describe('browser-service', { concurrency: false }, () => {
  const harnesses: FakeHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.service.shutdown().catch(() => undefined);
      await new Promise<void>((resolve) => harness.jsonServer.close(() => resolve()));
      rmSync(harness.deps.storageDir, { recursive: true, force: true });
    }
  });

  async function track(harness: FakeHarness): Promise<FakeHarness> {
    await new Promise<void>((resolve) =>
      harness.jsonServer.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = harness.jsonServer.address();
    if (!address || typeof address === 'string') throw new Error('json server did not bind');
    harness.debugPort = address.port;
    harnesses.push(harness);
    return harness;
  }

  it('spawn → ready → registry lookup → teardown destroys the view and wipes the partition', async () => {
    const { service, client, events, debugPort } = await track(createHarness());

    const info = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.strictEqual(info.sessionId, 's1');
    assert.strictEqual(info.workspaceId, 'w1');
    assert.strictEqual(info.state, 'agent_in_control');
    assert.strictEqual(info.port, debugPort);
    assert.match(info.baseUrl, /\/__comate-cdp__\/t\/VIEW-TARGET-1$/);
    assert.strictEqual(info.pid, undefined, 'native views have no sidecar-owned pid');
    assert.strictEqual(info.userDataDir, 'partition:persist:comate-browser-s1');
    assert.deepStrictEqual(
      client.calls.map((c) => c.method),
      ['createView'],
    );

    // Orphan-partition reconciliation ran exactly once (lazy initialize).
    assert.strictEqual(client.reconcileKeeps.length, 1);
    assert.ok(client.reconcileKeeps[0].includes('known-sess'));

    // Registry is queryable
    assert.deepStrictEqual(service.getSession('s1'), info);
    assert.strictEqual(service.getControlState('s1'), 'agent_in_control');
    assert.strictEqual(service.listSessions().length, 1);
    assert.strictEqual(stateEvents(events, 'agent_in_control').length, 1);

    // Teardown: view destroyed, partition wiped, registry cleared, closed event emitted
    await service.teardownSession('s1');
    assert.deepStrictEqual(
      client.calls.map((c) => c.method),
      ['createView', 'destroyView', 'wipePartition'],
    );
    assert.strictEqual(service.getSession('s1'), undefined);
    assert.strictEqual(service.listSessions().length, 0);
    assert.ok(events.some((e) => e.type === 'browser_closed' && e.sessionId === 's1'));
  });

  it('rebinds to the live view on repeated and concurrent ensureSession (KTD-5)', async () => {
    const { service, client } = await track(createHarness());

    const first = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    const second = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.deepStrictEqual(second, first);
    assert.strictEqual(
      client.calls.filter((c) => c.method === 'createView').length,
      1,
      'rebind must not create a second view',
    );

    const [a, b] = await Promise.all([
      service.ensureSession({ sessionId: 's2', workspaceId: 'w1' }),
      service.ensureSession({ sessionId: 's2', workspaceId: 'w1' }),
    ]);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(
      client.calls.filter((c) => c.method === 'createView' && c.sessionId === 's2').length,
      1,
      'concurrent ensure must share one spawn',
    );
  });

  it('enforces the concurrency cap with a structured error + browser_unavailable event', async () => {
    const { service, events } = await track(createHarness({ maxSessions: 4 }));

    for (let i = 1; i <= 4; i += 1) {
      await service.ensureSession({ sessionId: `s${i}`, workspaceId: 'w1' });
    }

    await assert.rejects(
      service.ensureSession({ sessionId: 's5', workspaceId: 'w1' }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserUnavailableError);
        assert.strictEqual(err.code, 'browser_limit_reached');
        return true;
      },
    );
    const unavailable = unavailableEvents(events);
    assert.strictEqual(unavailable.length, 1);
    assert.strictEqual(unavailable[0].code, 'browser_limit_reached');
    assert.strictEqual(unavailable[0].sessionId, 's5');

    // No phantom registry entry for the rejected session.
    assert.strictEqual(service.getControlState('s5'), undefined);
    assert.strictEqual(service.listSessions().length, 4);

    // Freeing a slot lets the next session in.
    await service.teardownSession('s1');
    const info = await service.ensureSession({ sessionId: 's5', workspaceId: 'w1' });
    assert.strictEqual(info.state, 'agent_in_control');
  });

  it('crash → pending-card release + session_lost → next ensureSession rebuilds', async () => {
    const { service, client, events, releasedCards } = await track(createHarness());

    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    client.emit({ type: 'view-crashed', sessionId: 's1', reason: 'killed' });

    // Crash transitions the registry entry to session_lost and releases cards.
    assert.strictEqual(service.getControlState('s1'), 'session_lost');
    assert.deepStrictEqual(releasedCards, ['s1']);
    const lost = stateEvents(events, 'session_lost');
    assert.strictEqual(lost.length, 1);
    assert.strictEqual(lost[0].sessionId, 's1');
    assert.match(lost[0].reason ?? '', /crashed or was destroyed/);

    // The registry entry survives (rebuildable) but reports no live session.
    assert.strictEqual(service.getSession('s1'), undefined);

    // Next tool call rebuilds transparently.
    const rebuilt = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.strictEqual(
      client.calls.filter((c) => c.method === 'createView').length,
      2,
      'a new view must be created',
    );
    assert.strictEqual(rebuilt.state, 'agent_in_control');
    assert.strictEqual(service.getControlState('s1'), 'agent_in_control');
  });

  it('teardown path: session deletion tears down only that session', async () => {
    const { service, client } = await track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w1' });

    await service.teardownSession('s1');
    assert.deepStrictEqual(
      client.calls,
      [
        { method: 'createView', sessionId: 's1' },
        { method: 'createView', sessionId: 's2' },
        { method: 'destroyView', sessionId: 's1' },
        { method: 'wipePartition', sessionId: 's1' },
      ],
    );
    assert.deepStrictEqual(
      service.listSessions().map((info) => info.sessionId),
      ['s2'],
    );

    // Idempotent
    await service.teardownSession('s1');
    assert.strictEqual(client.calls.length, 4);
  });

  it('teardown path: workspace deletion cascades to all its sessions', async () => {
    const { service, client, events } = await track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's3', workspaceId: 'w2' });

    await service.teardownWorkspace('w1');
    assert.deepStrictEqual(
      client.calls.filter((c) => c.method === 'wipePartition').map((c) => c.sessionId),
      ['s1', 's2'],
      'every session of the deleted workspace is torn down and wiped',
    );
    assert.deepStrictEqual(
      service.listSessions().map((info) => info.sessionId),
      ['s3'],
    );
    const closed = events.filter((e) => e.type === 'browser_closed');
    assert.strictEqual(closed.length, 2);
  });

  it('teardown clears the canUseTool-layer gate state for the session (F17)', async () => {
    const { service } = await track(createHarness());
    await service.ensureSession({ sessionId: 'gate-s1', workspaceId: 'w1' });
    setSubmitSemanticsRefs('gate-s1', ['e5-ab']);
    commitSessionNavigation('gate-s1', 'example.com');
    assert.strictEqual(isSubmitSemanticsRef('gate-s1', 'e5-ab'), true);
    assert.deepStrictEqual(getVisitedDomains('gate-s1'), ['example.com']);

    await service.teardownSession('gate-s1');
    assert.strictEqual(isSubmitSemanticsRef('gate-s1', 'e5-ab'), false);
    assert.deepStrictEqual(getVisitedDomains('gate-s1'), []);
  });

  it('workspace teardown clears gate state for every session it cascades to (F17)', async () => {
    const { service } = await track(createHarness());
    await service.ensureSession({ sessionId: 'gate-w1', workspaceId: 'w1' });
    setSubmitSemanticsRefs('gate-w1', ['e1-aa']);

    await service.teardownWorkspace('w1');
    assert.strictEqual(isSubmitSemanticsRef('gate-w1', 'e1-aa'), false);
  });

  it('shutdown() destroys every view but does not wipe partitions', async () => {
    const { service, client } = await track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w2' });

    await service.shutdown();
    assert.deepStrictEqual(
      client.calls.filter((c) => c.method === 'destroyView').map((c) => c.sessionId),
      ['s1', 's2'],
    );
    // Partitions survive app restarts — only session/workspace deletion wipes.
    assert.strictEqual(client.calls.filter((c) => c.method === 'wipePartition').length, 0);
    assert.strictEqual(service.listSessions().length, 0);
  });

  it('view creation failure surfaces a structured error and leaves no phantom entry', async () => {
    const harness = createHarness();
    const { service, client, events } = await track(harness);

    client.failCreate = new Error('renderer exploded');

    await assert.rejects(
      service.ensureSession({ sessionId: 's1', workspaceId: 'w1' }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserUnavailableError);
        assert.strictEqual(err.code, 'browser_start_failed');
        assert.ok(err.message.includes('renderer exploded'));
        return true;
      },
    );
    assert.strictEqual(unavailableEvents(events)[0]?.code, 'browser_start_failed');
    assert.strictEqual(service.getControlState('s1'), undefined, 'no phantom entry');
    assert.strictEqual(service.getLastShellError()?.kind, 'view_creation');

    // Recovery: next call succeeds once the shell creates views again.
    client.failCreate = null;
    const info = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.strictEqual(info.state, 'agent_in_control');
    assert.strictEqual(
      client.calls.filter((c) => c.method === 'createView').length,
      2,
    );
  });

  it('debug port not exposing the view → browser_start_failed + orphan view destroyed', async () => {
    const { service, client, events } = await track(createHarness({ serveJson: false }));

    await assert.rejects(
      service.ensureSession({ sessionId: 's1', workspaceId: 'w1' }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserUnavailableError);
        assert.strictEqual(err.code, 'browser_start_failed');
        assert.match(err.message, /debug port did not expose/);
        return true;
      },
    );
    assert.strictEqual(unavailableEvents(events)[0]?.code, 'browser_start_failed');
    assert.strictEqual(service.getLastShellError()?.kind, 'debug_port');
    assert.deepStrictEqual(
      client.calls.map((c) => c.method),
      ['createView', 'destroyView'],
      'the orphan view is cleaned up best-effort',
    );
  });

  it('misconfigured target → browser_start_failed with the resolution reason', async () => {
    const { service, client, events } = await track(
      createHarness({ misconfiguredReason: 'COMATE_BROWSER_CDP_TARGET=shell but no shell env' }),
    );

    await assert.rejects(
      service.ensureSession({ sessionId: 's1', workspaceId: 'w1' }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserUnavailableError);
        assert.strictEqual(err.code, 'browser_start_failed');
        assert.match(err.message, /COMATE_BROWSER_CDP_TARGET/);
        return true;
      },
    );
    assert.strictEqual(unavailableEvents(events)[0]?.code, 'browser_start_failed');
    assert.strictEqual(
      client.calls.length,
      0,
      'no view may be created for a misconfigured target',
    );
    assert.strictEqual(service.getControlState('s1'), undefined, 'no phantom entry');
  });

  it('teardown racing an in-flight spawn destroys the fresh view (no leak)', async () => {
    const { service, client } = await track(createHarness());

    client.createViewGate = () => undefined; // arm the gate
    const spawn = service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    // Wait until createView is in flight, then delete the session mid-spawn.
    for (let i = 0; i < 50 && !client.calls.some((c) => c.method === 'createView'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const teardown = service.teardownSession('s1');
    client.createViewGate?.(); // release the gate — spawn completes after teardown
    await assert.rejects(spawn, /torn down while starting/);
    await teardown;
    assert.deepStrictEqual(
      client.calls.map((c) => c.method),
      ['createView', 'destroyView'],
      'the raced view is destroyed, and session deletion after the race wiped nothing extra',
    );
    assert.strictEqual(service.getSession('s1'), undefined);
  });

  it('setControlState transitions the registry and re-emits browser_state', async () => {
    const { service, events } = await track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });

    service.setControlState('s1', 'user_in_control', 'handoff granted');
    assert.strictEqual(service.getControlState('s1'), 'user_in_control');
    const transitions = stateEvents(events, 'user_in_control');
    assert.strictEqual(transitions.length, 1);
    assert.strictEqual(transitions[0].reason, 'handoff granted');

    // Unknown session is a no-op; same-state is a no-op.
    service.setControlState('nope', 'user_in_control');
    service.setControlState('s1', 'user_in_control');
    assert.strictEqual(stateEvents(events, 'user_in_control').length, 1);
  });
});
