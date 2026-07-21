import '../../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
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
import {
  SteelProcess,
  type SteelExitInfo,
  type SteelProcessHandle,
  type SteelProcessOptions,
} from '../browser-steel-process.js';

/**
 * browser-service orchestration tests. The registry/state machine runs
 * against an injected fake Steel handle (fast, deterministic); one
 * integration test drives real child processes through the fake-steel
 * fixture to pin the concurrent-spawn port discipline end to end.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-steel.cjs',
);

class FakeSteelHandle implements SteelProcessHandle {
  readonly baseUrl: string;
  started = false;
  stopped = false;
  failStart: Error | null = null;
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
    return this.exited ? undefined : 20_000 + this.options.port;
  }

  async start(): Promise<void> {
    if (this.failStart) {
      this.exited = true;
      throw this.failStart;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.exited = true;
    this.emitExit({ code: null, signal: 'SIGKILL' });
  }

  async probeHealth(): Promise<boolean> {
    return this.started && !this.exited;
  }

  onExit(listener: (info: SteelExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  crash(info: SteelExitInfo = { code: 1, signal: null }): void {
    this.exited = true;
    this.emitExit(info);
  }

  private emitExit(info: SteelExitInfo): void {
    for (const listener of [...this.exitListeners]) {
      listener(info);
    }
  }
}

interface FakeHarness {
  service: BrowserService;
  handles: FakeSteelHandle[];
  events: BrowserServiceEvent[];
  releasedCards: string[];
  cleanupCalls: string[];
  chromiumCalls: number;
  /** When set, the next spawned handle throws this from start(). */
  failNextStart: Error | null;
  deps: BrowserServiceDeps;
}

function createHarness(overrides?: {
  maxSessions?: number;
  /** Default '/fake/chrome'; pass null to simulate "no Chromium anywhere". */
  chromiumPath?: string | null;
}): FakeHarness {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-svc-test-'));
  const handles: FakeSteelHandle[] = [];
  const events: BrowserServiceEvent[] = [];
  const releasedCards: string[] = [];
  const cleanupCalls: string[] = [];
  let nextPort = 41_000;
  const harness: FakeHarness = {
    service: undefined as unknown as BrowserService,
    handles,
    events,
    releasedCards,
    cleanupCalls,
    chromiumCalls: 0,
    failNextStart: null,
    deps: {
      storageDir,
      maxSessions: overrides?.maxSessions ?? DEFAULT_MAX_BROWSER_SESSIONS,
      allocatePort: async () => nextPort++,
      resolveChromiumPath: async () => {
        harness.chromiumCalls += 1;
        if (overrides?.chromiumPath === null) return undefined;
        return overrides?.chromiumPath ?? '/fake/chrome';
      },
      createProcess: (options) => {
        const handle = new FakeSteelHandle(options);
        if (harness.failNextStart) {
          handle.failStart = harness.failNextStart;
          harness.failNextStart = null;
        }
        handles.push(handle);
        return handle;
      },
      cleanupStale: async (runDir) => {
        cleanupCalls.push(runDir);
        return { scanned: 0, killed: 0, removed: 0, skipped: 0 };
      },
      now: () => Date.now(),
    },
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
      rmSync(harness.deps.storageDir, { recursive: true, force: true });
    }
  });

  function track(harness: FakeHarness): FakeHarness {
    harnesses.push(harness);
    return harness;
  }

  it('spawn → ready → registry lookup → teardown leaves no residue', async () => {
    const { service, handles, events, cleanupCalls, deps } = track(createHarness());

    const info = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.strictEqual(info.sessionId, 's1');
    assert.strictEqual(info.workspaceId, 'w1');
    assert.strictEqual(info.state, 'agent_in_control');
    assert.ok(info.port > 0);
    assert.strictEqual(info.baseUrl, `http://127.0.0.1:${info.port}`);
    assert.ok(info.pid !== undefined);
    assert.strictEqual(handles.length, 1);

    // Lazy startup cleanup ran exactly once with the run dir under storage.
    assert.strictEqual(cleanupCalls.length, 1);
    assert.strictEqual(cleanupCalls[0], path.join(deps.storageDir, 'browser', 'run'));

    // Registry is queryable
    assert.deepStrictEqual(service.getSession('s1'), info);
    assert.strictEqual(service.getControlState('s1'), 'agent_in_control');
    assert.strictEqual(service.listSessions().length, 1);
    assert.strictEqual(stateEvents(events, 'agent_in_control').length, 1);

    // Teardown: process stopped, registry cleared, closed event emitted
    await service.teardownSession('s1');
    assert.strictEqual(handles[0].stopped, true);
    assert.strictEqual(service.getSession('s1'), undefined);
    assert.strictEqual(service.listSessions().length, 0);
    assert.ok(events.some((e) => e.type === 'browser_closed' && e.sessionId === 's1'));
  });

  it('rebinds to the live process on repeated and concurrent ensureSession (KTD-5)', async () => {
    const harness = track(createHarness());
    const { service, handles } = harness;

    const first = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    const second = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.deepStrictEqual(second, first);
    assert.strictEqual(handles.length, 1, 'rebind must not spawn a second process');
    assert.strictEqual(harness.chromiumCalls, 1, 'rebind must not re-resolve Chromium');

    const [a, b] = await Promise.all([
      service.ensureSession({ sessionId: 's2', workspaceId: 'w1' }),
      service.ensureSession({ sessionId: 's2', workspaceId: 'w1' }),
    ]);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(handles.length, 2, 'concurrent ensure must share one spawn');
  });

  it('enforces the concurrency cap with a structured error + browser_unavailable event', async () => {
    const { service, events } = track(createHarness({ maxSessions: 4 }));

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
    const { service, handles, events, releasedCards } = track(createHarness());

    const original = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.ok(original.pid !== undefined);
    handles[0].crash();

    // Crash transitions the registry entry to session_lost and releases cards.
    assert.strictEqual(service.getControlState('s1'), 'session_lost');
    assert.deepStrictEqual(releasedCards, ['s1']);
    const lost = stateEvents(events, 'session_lost');
    assert.strictEqual(lost.length, 1);
    assert.strictEqual(lost[0].sessionId, 's1');
    assert.ok(lost[0].reason?.includes('exited'));

    // The registry entry survives (rebuildable) but reports no live session.
    assert.strictEqual(service.getSession('s1'), undefined);

    // Next tool call rebuilds transparently.
    const rebuilt = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.strictEqual(handles.length, 2, 'a new process must be spawned');
    assert.strictEqual(rebuilt.state, 'agent_in_control');
    assert.strictEqual(service.getControlState('s1'), 'agent_in_control');
    assert.ok(rebuilt.pid !== undefined);
  });

  it('teardown path: session deletion tears down only that session', async () => {
    const { service, handles } = track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w1' });

    await service.teardownSession('s1');
    assert.strictEqual(handles[0].stopped, true);
    assert.strictEqual(handles[1].stopped, false);
    assert.deepStrictEqual(
      service.listSessions().map((info) => info.sessionId),
      ['s2'],
    );

    // Idempotent
    await service.teardownSession('s1');
  });

  it('teardown path: workspace deletion cascades to all its sessions', async () => {
    const { service, handles, events } = track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's3', workspaceId: 'w2' });

    await service.teardownWorkspace('w1');
    assert.strictEqual(handles[0].stopped, true);
    assert.strictEqual(handles[1].stopped, true);
    assert.strictEqual(handles[2].stopped, false, 'other workspace must survive');
    assert.deepStrictEqual(
      service.listSessions().map((info) => info.sessionId),
      ['s3'],
    );
    const closed = events.filter((e) => e.type === 'browser_closed');
    assert.strictEqual(closed.length, 2);
  });

  it('teardown path: workspace delete tears the workspace browsers down', async () => {
    const { service, handles } = track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w2' });

    await service.teardownWorkspace('w1');
    assert.strictEqual(handles[0].stopped, true);
    assert.strictEqual(handles[1].stopped, false);
  });

  it('teardown clears the canUseTool-layer gate state for the session (F17)', async () => {
    const { service } = track(createHarness());
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
    const { service } = track(createHarness());
    await service.ensureSession({ sessionId: 'gate-w1', workspaceId: 'w1' });
    setSubmitSemanticsRefs('gate-w1', ['e1-aa']);

    await service.teardownWorkspace('w1');
    assert.strictEqual(isSubmitSemanticsRef('gate-w1', 'e1-aa'), false);
  });

  it('shutdown() stops every process within the stop budget', async () => {
    const { service, handles } = track(createHarness());
    await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    await service.ensureSession({ sessionId: 's2', workspaceId: 'w2' });

    await service.shutdown();
    assert.ok(handles.every((handle) => handle.stopped));
    assert.strictEqual(service.listSessions().length, 0);
  });

  it('start failure surfaces a structured error and leaves no phantom entry', async () => {
    const harness = track(createHarness());
    const { service, handles, events } = harness;

    harness.failNextStart = new Error('chrome exploded');

    await assert.rejects(
      service.ensureSession({ sessionId: 's1', workspaceId: 'w1' }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserUnavailableError);
        assert.strictEqual(err.code, 'browser_start_failed');
        assert.ok(err.message.includes('chrome exploded'));
        return true;
      },
    );
    assert.strictEqual(unavailableEvents(events)[0]?.code, 'browser_start_failed');
    assert.strictEqual(service.getControlState('s1'), undefined, 'no phantom entry');
    assert.strictEqual(handles.length, 1);

    // Recovery: next call succeeds with a healthy handle.
    const info = await service.ensureSession({ sessionId: 's1', workspaceId: 'w1' });
    assert.strictEqual(info.state, 'agent_in_control');
    assert.strictEqual(handles.length, 2);
  });

  it('missing Chromium surfaces browser_chromium_missing without spawning', async () => {
    const { service, handles, events } = track(createHarness({ chromiumPath: null }));

    await assert.rejects(
      service.ensureSession({ sessionId: 's1', workspaceId: 'w1' }),
      (err: unknown) => {
        assert.ok(err instanceof BrowserUnavailableError);
        assert.strictEqual(err.code, 'browser_chromium_missing');
        return true;
      },
    );
    assert.strictEqual(handles.length, 0, 'no process may be spawned');
    assert.strictEqual(unavailableEvents(events)[0]?.code, 'browser_chromium_missing');
  });

  it('setControlState transitions the registry and re-emits browser_state', async () => {
    const { service, events } = track(createHarness());
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

  it('runs two real Steel children concurrently with distinct loopback ports (integration)', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-int-'));
    const service = new BrowserService({
      storageDir,
      resolveChromiumPath: async () => '/fake/chrome',
      createProcess: (options) =>
        new SteelProcess(options, {
          spawnSpec: () => ({ command: process.execPath, args: [FIXTURE] }),
          healthTimeoutMs: 15_000,
          healthIntervalMs: 50,
        }),
      cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
    });
    try {
      const [a, b] = await Promise.all([
        service.ensureSession({ sessionId: 's1', workspaceId: 'w1' }),
        service.ensureSession({ sessionId: 's2', workspaceId: 'w1' }),
      ]);
      assert.notStrictEqual(a.port, b.port, 'concurrent spawns must not collide on a port');

      for (const info of [a, b]) {
        const res = await fetch(`${info.baseUrl}/v1/health`, {
          signal: AbortSignal.timeout(3000),
        });
        assert.strictEqual(res.status, 200);
        const body = (await res.json()) as { address: string };
        assert.strictEqual(body.address, '127.0.0.1', 'must bind loopback only');
      }
      assert.strictEqual(service.listSessions().length, 2);

      await service.shutdown();
      assert.strictEqual(service.listSessions().length, 0);
    } finally {
      await service.shutdown().catch(() => undefined);
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
