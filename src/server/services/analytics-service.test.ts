import '../test-utils/test-env.js';
/**
 * Run via: `npx tsx --test src/server/services/analytics-service.test.ts`
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalyticsCache } from '../storage/analytics-cache.js';
import { AnalyticsService, type AnalyticsSdkLike, type AnalyticsStoreLike } from './analytics-service.js';
import type { Workspace } from '../models/workspace.js';

/**
 * Build a tiny SDKSessionInfo-bearing assistant line in JSONL. Adjusted via
 * overrides so each test controls model / tokens / mtime / timestamp.
 */
function assistantJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-13T14:30:00.000Z',
    message: {
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
      content: [{ type: 'tool_use', name: 'Read' }],
    },
    ...overrides,
  });
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Test',
    description: null,
    folderPath: '/fake/path',
    settings: {
      wecomBotEnabled: false,
      wecomBotId: null,
      wecomBotSecret: null,
      defaultApprovalMode: 'default',
      defaultProviderId: null,
      defaultPermissionMode: 'default',
      defaultAgentName: null,
    },
    skills: null,
    mcpServers: null,
    hooks: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as Workspace;
}

class StubStore implements AnalyticsStoreLike {
  workspaces: Workspace[] = [];
  cache: AnalyticsCache;

  constructor(db: Database.Database) {
    this.cache = new AnalyticsCache(db);
  }

  async list(): Promise<Workspace[]> {
    return this.workspaces;
  }

  async get(id: string): Promise<Workspace | null> {
    return this.workspaces.find((w) => w.id === id) ?? null;
  }

  getAnalyticsCache(): AnalyticsCache {
    return this.cache;
  }
}

/**
 * Build a SDK stub whose listSessions returns the registered sessions for the
 * requested directory. This mirrors the real SDK's `dir → sessions` mapping
 * without needing an actual `~/.claude/projects` tree.
 */
class DirAwareStubSdk implements AnalyticsSdkLike {
  constructor(private readonly sessionsByDir: Map<string, Array<{ sessionId: string; lastModified: number }>>) {}

  async listSessions(options?: { dir?: string }): Promise<Array<{ sessionId: string; lastModified: number; summary: string }>> {
    const dir = options?.dir ?? '';
    const sessions = this.sessionsByDir.get(dir) ?? [];
    return sessions.map((s) => ({ ...s, summary: 'stub' }));
  }
}

describe('AnalyticsService', () => {
  let db: InstanceType<typeof Database>;
  let stubStore: StubStore;

  beforeEach(() => {
    db = new Database(':memory:');
    stubStore = new StubStore(db);
  });

  it('extracts a workspace session from disk, caches it, and rolls it up', async () => {
    // Stage a fake transcript at the resolved path. The service resolves the
    // path via resolveTranscriptFile(folderPath, sessionId); rather than mock
    // that, we point folderPath at a temp dir and place the file at the
    // expected location under .claude/projects/<encoded-cwd>/.
    const home = mkdtempSync(join(tmpdir(), 'analytics-svc-home-'));
    process.env.HOME = home;
    const folderPath = join(home, 'my-project');
    const encoded = folderPath.replace(/[/\]/g, '-');
    const projectsDir = join(home, '.claude', 'projects', encoded);
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'sess-1.jsonl'), assistantJson());

    stubStore.workspaces = [makeWorkspace({ id: 'ws-1', folderPath })];
    const sdk = new DirAwareStubSdk(
      new Map([[folderPath, [{ sessionId: 'sess-1', lastModified: 1_000 }]]]),
    );
    const service = new AnalyticsService(sdk, stubStore);

    const summary = await service.getWorkspaceSummary('ws-1');

    assert.ok(summary);
    assert.equal(summary!.totalSessions, 1);
    assert.equal(summary!.totalTokens, 165);
    assert.equal(summary!.totalMessages, 1);
    assert.equal(summary!.mostUsedTools.length, 1);
    assert.equal(summary!.mostUsedTools[0]!.tool, 'Read');

    // Verify the row landed in the cache.
    const cached = stubStore.cache.get('sess-1');
    assert.ok(cached);
    assert.equal(cached!.workspaceId, 'ws-1');

    delete process.env.HOME;
  });

  it('returns null for an unknown workspace id', async () => {
    const service = new AnalyticsService(new DirAwareStubSdk(new Map()), stubStore);
    const summary = await service.getWorkspaceSummary('nope');
    assert.equal(summary, null);
  });

  it('skips re-extraction when the cache row is fresh (mtime matches)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'analytics-svc-home-'));
    process.env.HOME = home;
    const folderPath = join(home, 'my-project');
    const encoded = folderPath.replace(/[/\]/g, '-');
    const projectsDir = join(home, '.claude', 'projects', encoded);
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'sess-stable.jsonl'), assistantJson());

    stubStore.workspaces = [makeWorkspace({ id: 'ws-1', folderPath })];
    const sdk = new DirAwareStubSdk(
      new Map([[folderPath, [{ sessionId: 'sess-stable', lastModified: 5_000 }]]]),
    );
    const service = new AnalyticsService(sdk, stubStore);

    // First call extracts.
    await service.getWorkspaceSummary('ws-1');
    // Mutate the transcript behind the cache's back: the service should NOT
    // re-read because the SDK still reports lastModified=5_000 (matches cache).
    writeFileSync(join(projectsDir, 'sess-stable.jsonl'), assistantJson() + '
' + assistantJson({ timestamp: '2026-06-13T15:00:00.000Z' }));

    await service.getWorkspaceSummary('ws-1');
    const cached = stubStore.cache.get('sess-stable');
    assert.ok(cached);
    // Should still reflect ONE assistant entry — the file change was invisible
    // to the staleness check (mtime from the SDK didn't change).
    assert.equal(cached!.messageCount, 1);

    delete process.env.HOME;
  });

  it('re-extracts when the SDK reports a newer lastModified than the cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'analytics-svc-home-'));
    process.env.HOME = home;
    const folderPath = join(home, 'my-project');
    const encoded = folderPath.replace(/[/\]/g, '-');
    const projectsDir = join(home, '.claude', 'projects', encoded);
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'sess-grow.jsonl'), assistantJson());

    stubStore.workspaces = [makeWorkspace({ id: 'ws-1', folderPath })];
    let reportedMtime = 1_000;
    const sdk = new DirAwareStubSdk(
      new Map([[folderPath, [{ sessionId: 'sess-grow', lastModified: reportedMtime }]]]),
    );
    const service = new AnalyticsService(sdk, stubStore);

    await service.getWorkspaceSummary('ws-1');
    let cached = stubStore.cache.get('sess-grow');
    assert.equal(cached!.messageCount, 1);

    // Grow the transcript and bump the SDK's reported mtime.
    writeFileSync(
      join(projectsDir, 'sess-grow.jsonl'),
      assistantJson() + '
' + assistantJson({ timestamp: '2026-06-13T15:00:00.000Z' }),
    );
    reportedMtime = 2_000;
    // Rebuild the SDK with the new mtime.
    const sdk2 = new DirAwareStubSdk(
      new Map([[folderPath, [{ sessionId: 'sess-grow', lastModified: reportedMtime }]]]),
    );
    const service2 = new AnalyticsService(sdk2, stubStore);
    await service2.getWorkspaceSummary('ws-1');
    cached = stubStore.cache.get('sess-grow');
    assert.equal(cached!.messageCount, 2);

    delete process.env.HOME;
  });

  it('aggregates across multiple workspaces in getGlobalSummary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'analytics-svc-home-'));
    process.env.HOME = home;

    const folderA = join(home, 'proj-a');
    const folderB = join(home, 'proj-b');
    const sessionIds = ['sess-a', 'sess-b'];
    const folders = [folderA, folderB];
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i]!;
      const encoded = folder.replace(/[/\]/g, '-');
      const dir = join(home, '.claude', 'projects', encoded);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionIds[i]}.jsonl`), assistantJson());
    }

    stubStore.workspaces = [
      makeWorkspace({ id: 'ws-a', name: 'A', folderPath: folderA }),
      makeWorkspace({ id: 'ws-b', name: 'B', folderPath: folderB }),
    ];
    const sdk = new DirAwareStubSdk(
      new Map([
        [folderA, [{ sessionId: 'sess-a', lastModified: 1 }]],
        [folderB, [{ sessionId: 'sess-b', lastModified: 1 }]],
      ]),
    );
    const service = new AnalyticsService(sdk, stubStore);

    const summary = await service.getGlobalSummary();
    assert.equal(summary.totalWorkspaces, 2);
    assert.equal(summary.totalSessions, 2);
    assert.equal(summary.totalTokens, 330);
    assert.equal(summary.topWorkspaces.length, 2);

    delete process.env.HOME;
  });

  it('survives an SDK listSessions failure by falling back to whatever is cached', async () => {
    // Pre-seed the cache directly so the service has something to roll up
    // even when the SDK throws.
    stubStore.cache.upsert({
      sessionId: 'sess-old',
      workspaceId: 'ws-1',
      transcriptMtime: 1,
      extractedAt: 1,
      totalTokens: 42,
      inputTokens: 20,
      outputTokens: 22,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      costCoveragePercent: 100,
      durationMs: 0,
      messageCount: 1,
      firstMessageTs: null,
      lastMessageTs: null,
      hasCompaction: false,
      modelUsage: [],
      toolUsage: [],
      dailyStats: [],
      heatmap: [],
    });
    stubStore.workspaces = [makeWorkspace({ id: 'ws-1', folderPath: '/nowhere' })];

    const failingSdk: AnalyticsSdkLike = {
      async listSessions() {
        throw new Error('sdk unavailable');
      },
    };
    const service = new AnalyticsService(failingSdk, stubStore);
    const summary = await service.getWorkspaceSummary('ws-1');

    assert.ok(summary);
    assert.equal(summary!.totalTokens, 42);
    assert.equal(summary!.totalSessions, 1);
  });
});