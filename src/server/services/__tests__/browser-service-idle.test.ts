import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { createIsolatedStore } from '../../test-utils/test-store.js';
import type { SqliteStore } from '../../storage/sqlite-store.js';
import {
  BrowserService,
  type BrowserServiceEvent,
  type BrowserServiceTimer,
} from '../browser-service.js';
import type { SteelExitInfo, SteelProcessHandle, SteelProcessOptions } from '../browser-steel-process.js';

/**
 * U3 — idle reclaim: a per-session idle timer that prompts then auto-closes.
 * Drives a deterministic fake timer (no real waits), covering: prompt→close,
 * activity reset, snooze, human confirm, handoff_pending suppression, and
 * timer cleanup on teardown/crash.
 */

class FakeSteelHandle implements SteelProcessHandle {
  readonly baseUrl: string;
  stopped = false;
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
    return this.stopped ? undefined : 20_000 + this.options.port;
  }
  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  onExit(listener: (info: SteelExitInfo) => void): void {
    this.exitListeners.add(listener);
  }
  fireExit(): void {
    for (const listener of this.exitListeners) {
      listener({ code: 1, signal: null });
    }
  }
}

/** Deterministic FIFO timer: set/clear track live handles; fireOldest fires in order. */
class FakeTimer implements BrowserServiceTimer {
  private nextId = 1;
  private live = new Map<number, () => void>();
  private order: number[] = [];

  set = (fn: () => void): unknown => {
    const id = this.nextId++;
    this.live.set(id, fn);
    this.order.push(id);
    return id;
  };
  clear = (handle: unknown): void => {
    const id = handle as number;
    this.live.delete(id);
    this.order = this.order.filter((x) => x !== id);
  };
  fireOldest(): void {
    const id = this.order.shift();
    if (id === undefined) return;
    const fn = this.live.get(id);
    this.live.delete(id);
    if (fn) fn();
  }
  get pending(): number {
    return this.order.length;
  }
}

interface Harness {
  service: BrowserService;
  store: SqliteStore;
  storageDir: string;
  workspaceId: string;
  timer: FakeTimer;
  handles: FakeSteelHandle[];
  events: BrowserServiceEvent[];
  auditVerbs: string[];
}

function makeHarness(): Harness {
  const store = createIsolatedStore();
  const timer = new FakeTimer();
  const handles: FakeSteelHandle[] = [];
  const events: BrowserServiceEvent[] = [];
  const auditVerbs: string[] = [];
  let nextPort = 42_000;
  const storageDir = mkdtempSync(path.join(tmpdir(), 'browser-idle-'));

  const service = new BrowserService({
    storageDir,
    maxSessions: 4,
    allocatePort: async () => nextPort++,
    resolveChromiumPath: async () => '/fake/chrome',
    createProcess: (options: SteelProcessOptions) => {
      const handle = new FakeSteelHandle(options);
      handles.push(handle);
      return handle;
    },
    cleanupStale: async () => ({ scanned: 0, killed: 0, removed: 0, skipped: 0 }),
    now: () => Date.now(),
    store,
    currentPageUrl: async () => null,
    exportContext: async () => ({}),
    timer,
    idlePromptMs: 1000,
    idleCloseMs: 2000,
    audit: {
      logSiteAuth: () => null,
      logControl: (input) => {
        auditVerbs.push(input.verb);
        return null;
      },
    },
  });
  service.onEvent((event) => events.push(event));

  return { service, store, storageDir, workspaceId: '', timer, handles, events, auditVerbs };
}

function idlePromptEvents(h: Harness): BrowserServiceEvent[] {
  return h.events.filter((e) => e.type === 'browser_idle_prompt');
}

/**
 * The idle auto-close is fire-and-forget from the timer callback
 * (onIdleCloseFire -> void closeSession). The teardown's profile-wipe (`rm`)
 * is async I/O, so poll for the real completion signal (browser_closed)
 * rather than assuming a single microtask flush is enough.
 */
async function waitForClosed(h: Harness, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (h.events.some((e) => e.type === 'browser_closed')) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('waitForClosed timed out — browser_closed never emitted');
}

describe('BrowserService idle reclaim (U3)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness();
    const ws = await h.store.create({ name: 'Test', folderPath: '/tmp/ws' });
    h.workspaceId = ws.id;
  });

  afterEach(() => {
    h.store.resetData();
    rmSync(h.storageDir, { recursive: true, force: true });
  });

  it('prompts after the idle duration, then auto-closes after the secondary deadline', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    assert.strictEqual(h.timer.pending, 1, 'prompt timer armed on spawn');

    // Idle duration elapses -> prompt.
    h.timer.fireOldest();
    const prompts = idlePromptEvents(h);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].type, 'browser_idle_prompt');
    assert.strictEqual((prompts[0] as { pending: boolean }).pending, true);
    assert.strictEqual(h.timer.pending, 1, 'close timer armed after prompt');

    // Secondary deadline elapses with no response -> auto-close.
    h.timer.fireOldest();
    await waitForClosed(h);
    assert.strictEqual(h.service.getSession('s1'), undefined, 'session torn down');
    assert.ok(h.events.some((e) => e.type === 'browser_closed'));
    assert.ok(h.auditVerbs.includes('browser_closed_timeout'), 'timeout close audited');
  });

  it('agent activity (resetIdle) re-arms the prompt timer and dismisses any in-flight prompt', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    h.timer.fireOldest(); // prompt fires
    assert.strictEqual(idlePromptEvents(h).length, 1);
    assert.strictEqual(h.timer.pending, 1, 'close timer armed');

    // Activity arrives -> prompt dismissed, close timer cleared, prompt re-armed.
    h.service.resetIdle('s1');
    const prompts = idlePromptEvents(h);
    assert.strictEqual(prompts.length, 2, 'dismiss event emitted');
    assert.strictEqual((prompts[1] as { pending: boolean }).pending, false);
    assert.strictEqual(h.timer.pending, 1, 'only the prompt timer is armed after reset');
  });

  it('snooze dismisses the prompt and re-arms for a fresh interval (no auto-close)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    h.timer.fireOldest(); // prompt

    h.service.snoozeIdle('s1');
    const prompts = idlePromptEvents(h);
    assert.strictEqual((prompts.at(-1) as { pending: boolean }).pending, false);
    assert.strictEqual(h.timer.pending, 1, 'close timer cleared, prompt re-armed');

    // The next pending timer is the prompt again (not the close) -> firing it re-prompts.
    h.timer.fireOldest();
    assert.strictEqual(
      (idlePromptEvents(h).at(-1) as { pending: boolean }).pending,
      true,
      'snooze re-arms the prompt, not the close',
    );
  });

  it('confirmIdleClose closes with the idle source', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    h.timer.fireOldest(); // prompt

    await h.service.confirmIdleClose('s1');

    assert.strictEqual(h.service.getSession('s1'), undefined);
    assert.ok(h.auditVerbs.includes('browser_closed_idle'));
  });

  it('does not arm the prompt while a handoff is pending (suppressed)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    h.service.setControlState('s1', 'handoff_pending');

    h.service.resetIdle('s1');
    assert.strictEqual(h.timer.pending, 0, 'no idle timer while handoff_pending');
  });

  it('clears timers on teardown (no fire-after-close)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    assert.ok(h.timer.pending >= 1);

    await h.service.teardownSession('s1');
    assert.strictEqual(h.timer.pending, 0, 'timers cleared on teardown');

    // Firing nothing must not crash or emit.
    h.timer.fireOldest();
    assert.ok(!h.events.some((e) => e.type === 'browser_idle_prompt'));
  });

  it('clears timers on crash (session_lost)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    assert.ok(h.timer.pending >= 1);

    h.handles[0].fireExit();
    assert.strictEqual(h.service.getControlState('s1'), 'session_lost');
    assert.strictEqual(h.timer.pending, 0, 'timers cleared on crash');
  });

  it('does not auto-close mid-handoff: handoff_pending clears the idle close timer (R5)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    h.timer.fireOldest(); // prompt fires → close timer armed
    assert.strictEqual(h.timer.pending, 1);

    // A handoff starting after the prompt must not let the close timer fire.
    h.service.setControlState('s1', 'handoff_pending');
    assert.strictEqual(h.timer.pending, 0, 'idle timers cleared on handoff entry');
    h.timer.fireOldest(); // nothing pending -> no-op

    assert.ok(h.service.getSession('s1'), 'session still live (not auto-closed)');
    assert.ok(!h.auditVerbs.includes('browser_closed_timeout'), 'no timeout close mid-handoff');
  });

  it('defers the idle timer while an agent-close card is pending (R10 dedup)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    assert.strictEqual(h.timer.pending, 1);

    h.service.setCloseCardPending('s1', true);
    assert.strictEqual(h.timer.pending, 0, 'idle timer cleared while close card pending');

    // Resolving the card without teardown (deny) resumes idle counting.
    h.service.setCloseCardPending('s1', false);
    assert.strictEqual(h.timer.pending, 1, 'prompt re-armed after card resolved');
  });

  it('dismisses an in-flight idle prompt when an agent-close card opens (R10)', async () => {
    await h.service.ensureSession({ sessionId: 's1', workspaceId: h.workspaceId });
    h.timer.fireOldest(); // prompt fires → banner up, close timer armed
    const promptShown = idlePromptEvents(h).at(-1) as { pending: boolean };
    assert.strictEqual(promptShown.pending, true);

    h.service.setCloseCardPending('s1', true);
    const afterDismiss = idlePromptEvents(h).at(-1) as { pending: boolean };
    assert.strictEqual(afterDismiss.pending, false, 'idle banner dismissed when close card opens');
    assert.strictEqual(h.timer.pending, 0, 'idle timers cleared');
  });
});
