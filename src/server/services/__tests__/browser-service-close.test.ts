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
  type BrowserCloseSource,
  type BrowserServiceEvent,
  type CloseSessionResult,
} from '../browser-service.js';
import type { SteelExitInfo, SteelProcessHandle, SteelProcessOptions } from '../browser-steel-process.js';

/**
 * U1 — closeSession: the explicit-close sink. Covers the explicit-remember
 * contract, source-tagged audit, and idempotency. The registry runs against
 * an injected fake Steel handle; persistence is driven only by a separate
 * Remember action against an isolated store.
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
}

interface Harness {
  service: BrowserService;
  store: SqliteStore;
  storageDir: string;
  workspaceId: string;
  handles: FakeSteelHandle[];
  events: BrowserServiceEvent[];
  auditCalls: { method: 'logSiteAuth' | 'logControl'; input: Record<string, unknown> }[];
  exportedBaseUrls: string[];
  pageUrl: string | null;
  context: unknown;
}

function makeHarness(): Harness {
  const store = createIsolatedStore();
  const handles: FakeSteelHandle[] = [];
  const events: BrowserServiceEvent[] = [];
  const auditCalls: Harness['auditCalls'] = [];
  const exportedBaseUrls: string[] = [];
  let nextPort = 41_000;
  const storageDir = mkdtempSync(path.join(tmpdir(), 'browser-close-'));

  const harness: Harness = {
    store,
    storageDir,
    workspaceId: '',
    handles,
    events,
    auditCalls,
    exportedBaseUrls,
    pageUrl: 'https://example.com/dashboard',
    context: {
      cookies: [{ domain: 'example.com', name: 'sid', value: 'SECRET' }],
      localStorage: {},
      sessionStorage: {},
    },
    service: undefined as unknown as BrowserService,
  };

  harness.service = new BrowserService({
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
    // No-op timer: this suite tests closeSession, not idle behavior, so the
    // spawn-armed idle timer never needs to fire (and must not hold the process).
    timer: { set: () => 0, clear: () => undefined },
    store,
    currentPageUrl: async () => harness.pageUrl,
    exportContext: async (baseUrl) => {
      exportedBaseUrls.push(baseUrl);
      return harness.context;
    },
    audit: {
      logSiteAuth: (input) => {
        auditCalls.push({ method: 'logSiteAuth', input: input as unknown as Record<string, unknown> });
        return null;
      },
      logControl: (input) => {
        auditCalls.push({ method: 'logControl', input: input as unknown as Record<string, unknown> });
        return null;
      },
    },
  });
  harness.service.onEvent((event) => events.push(event));
  return harness;
}

describe('BrowserService.closeSession (U1)', () => {
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

  it('preserves a site only when Remember was explicitly requested before close', async () => {
    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: h.workspaceId });
    const liveBaseUrl = h.handles[0].baseUrl;
    const remembered = await h.service.rememberCurrentSite('sess-1');

    const result: CloseSessionResult = await h.service.closeSession('sess-1', 'agent');

    assert.strictEqual(result.closed, true);
    assert.strictEqual(remembered.key, 'example.com');
    assert.strictEqual(remembered.cookieCount, 1);
    assert.deepStrictEqual(h.exportedBaseUrls, [liveBaseUrl]);

    // Teardown ran: handle stopped, browser_closed emitted.
    assert.strictEqual(h.handles[0].stopped, true);
    assert.ok(h.events.some((e) => e.type === 'browser_closed' && e.sessionId === 'sess-1'));

    // The explicit action, not close, produced exactly one remember row.
    const remember = h.auditCalls.find((c) => c.method === 'logSiteAuth');
    assert.ok(remember, 'expected a logSiteAuth remember row');
    assert.strictEqual(remember.input.action, 'remember');
    assert.strictEqual(h.auditCalls.filter((c) => c.method === 'logSiteAuth').length, 1);
    const closeAudit = h.auditCalls.find(
      (c) => c.method === 'logControl' && String(c.input.verb) === 'browser_closed_agent',
    );
    assert.ok(closeAudit, 'expected a browser_closed_agent control row');
    assert.strictEqual(closeAudit.input.workspaceId, h.workspaceId);
    // Positive-shape discipline: the secret cookie value never reaches audit.
    assert.ok(!JSON.stringify(h.auditCalls).includes('SECRET'), 'cookie value leaked into audit');
  });

  it('does not inspect or persist login state during close', async () => {
    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: h.workspaceId });

    const result = await h.service.closeSession('sess-1', 'human');

    assert.strictEqual(result.closed, true);
    assert.deepStrictEqual(h.exportedBaseUrls, []);
    assert.strictEqual(h.auditCalls.filter((c) => c.method === 'logSiteAuth').length, 0);
    assert.strictEqual(h.handles[0].stopped, true);
    const closeAudit = h.auditCalls.find(
      (c) => c.method === 'logControl' && String(c.input.verb) === 'browser_closed_human',
    );
    assert.ok(closeAudit, 'human close still audited');
    assert.strictEqual(closeAudit.input.detail, undefined);
  });

  it('closes an about:blank browser without attempting Remember', async () => {
    h.pageUrl = null;
    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: h.workspaceId });

    const result = await h.service.closeSession('sess-1', 'idle');

    assert.strictEqual(result.closed, true);
    assert.deepStrictEqual(h.exportedBaseUrls, []);
    assert.strictEqual(h.handles[0].stopped, true);
  });

  it('is idempotent on a session with no live browser', async () => {
    const result = await h.service.closeSession('nonexistent', 'timeout');

    assert.strictEqual(result.closed, false);
    assert.strictEqual(h.auditCalls.length, 0, 'no-op close must not audit');
  });

  it('records each trigger source in the audit verb', async () => {
    const sources: readonly BrowserCloseSource[] = ['agent', 'human', 'idle', 'timeout'];
    for (const source of sources) {
      const sid = `sess-${source}`;
      await h.service.ensureSession({ sessionId: sid, workspaceId: h.workspaceId });
      await h.service.closeSession(sid, source);
    }
    for (const source of sources) {
      assert.ok(
        h.auditCalls.some(
          (c) => c.method === 'logControl' && String(c.input.verb) === `browser_closed_${source}`,
        ),
        `expected a browser_closed_${source} control row`,
      );
    }
  });
});
