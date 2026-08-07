import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { createIsolatedStore } from '../../test-utils/test-store.js';
import {
  startFakeBrowserShell,
  fakeViewBaseUrl,
  type FakeBrowserShell,
} from '../../test-utils/fake-browser-shell.js';
import type { SqliteStore } from '../../storage/sqlite-store.js';
import {
  BrowserService,
  type BrowserCloseSource,
  type BrowserServiceEvent,
  type CloseSessionResult,
} from '../browser-service.js';

/**
 * U1 — closeSession: the explicit-close sink. Covers the explicit-remember
 * contract, source-tagged audit, and idempotency. The registry runs against
 * the fake shell harness (fake control client + fake /json debug port);
 * persistence is driven only by a separate Remember action against an
 * isolated store.
 */

interface Harness {
  service: BrowserService;
  shell: FakeBrowserShell;
  store: SqliteStore;
  storageDir: string;
  workspaceId: string;
  events: BrowserServiceEvent[];
  auditCalls: { method: 'logSiteAuth' | 'logControl'; input: Record<string, unknown> }[];
  exportedBaseUrls: string[];
  pageUrl: string | null;
  context: unknown;
}

async function makeHarness(): Promise<Harness> {
  const store = createIsolatedStore();
  const shell = await startFakeBrowserShell();
  const events: BrowserServiceEvent[] = [];
  const auditCalls: Harness['auditCalls'] = [];
  const exportedBaseUrls: string[] = [];
  const storageDir = mkdtempSync(path.join(tmpdir(), 'browser-close-'));

  const harness: Harness = {
    store,
    shell,
    storageDir,
    workspaceId: '',
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
    resolveTarget: shell.resolveTarget,
    createControlClient: shell.createControlClient,
    cdpRetry: { budgetMs: 400, intervalMs: 40 },
    listKnownSessionIds: () => [],
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
    h = await makeHarness();
    const ws = await h.store.create({ name: 'Test', folderPath: '/tmp/ws' });
    h.workspaceId = ws.id;
  });

  afterEach(async () => {
    await h.service.shutdown().catch(() => undefined);
    await h.shell.close();
    h.store.resetData();
    rmSync(h.storageDir, { recursive: true, force: true });
  });

  /** destroyView + wipePartition over the control channel = the teardown ran. */
  function tornDown(sessionId: string): boolean {
    return (
      h.shell.client.callsFor('destroyView', sessionId).length === 1 &&
      h.shell.client.callsFor('wipePartition', sessionId).length === 1
    );
  }

  it('preserves a site only when Remember was explicitly requested before close', async () => {
    await h.service.ensureSession({ sessionId: 'sess-1', workspaceId: h.workspaceId });
    const liveBaseUrl = fakeViewBaseUrl(h.shell.debugPort);
    const remembered = await h.service.rememberCurrentSite('sess-1');

    const result: CloseSessionResult = await h.service.closeSession('sess-1', 'agent');

    assert.strictEqual(result.closed, true);
    assert.strictEqual(remembered.key, 'example.com');
    assert.strictEqual(remembered.cookieCount, 1);
    assert.deepStrictEqual(h.exportedBaseUrls, [liveBaseUrl]);

    // Teardown ran: view destroyed + partition wiped, browser_closed emitted.
    assert.ok(tornDown('sess-1'), 'expected destroyView + wipePartition for sess-1');
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
    assert.ok(tornDown('sess-1'), 'expected destroyView + wipePartition for sess-1');
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
    assert.ok(tornDown('sess-1'), 'expected destroyView + wipePartition for sess-1');
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
