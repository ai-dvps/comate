/**
 * Run via: `npx tsx --test src/server/storage/analytics-cache.test.ts`
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  AnalyticsCache,
  type SessionAnalyticsRow,
} from './analytics-cache.js';

function makeRow(overrides: Partial<SessionAnalyticsRow> = {}): SessionAnalyticsRow {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    transcriptMtime: 1_000,
    extractedAt: 9_000,
    totalTokens: 100,
    inputTokens: 60,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0.5,
    costCoveragePercent: 100,
    durationMs: 5_000,
    messageCount: 2,
    firstMessageTs: 1_000,
    lastMessageTs: 6_000,
    hasCompaction: false,
    modelUsage: [
      {
        model: 'claude-sonnet-4',
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 100,
      },
    ],
    toolUsage: [{ tool: 'Read', count: 3 }],
    dailyStats: [{ date: '2026-06-13', tokens: 100, messages: 2, durationMs: 5_000 }],
    ...overrides,
  };
}

describe('AnalyticsCache', () => {
  let db: InstanceType<typeof Database>;
  let cache: AnalyticsCache;

  beforeEach(() => {
    db = new Database(':memory:');
    cache = new AnalyticsCache(db);
  });

  it('upsert then get returns matching values (JSON blobs round-trip)', () => {
    cache.upsert(makeRow());

    const got = cache.get('sess-1');
    assert.ok(got, 'expected a row');
    assert.equal(got!.sessionId, 'sess-1');
    assert.equal(got!.workspaceId, 'ws-1');
    assert.equal(got!.transcriptMtime, 1_000);
    assert.equal(got!.totalTokens, 100);
    assert.equal(got!.estimatedCostUsd, 0.5);
    assert.equal(got!.hasCompaction, false);
    assert.deepEqual(got!.modelUsage, [
      {
        model: 'claude-sonnet-4',
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 100,
      },
    ]);
    assert.deepEqual(got!.toolUsage, [{ tool: 'Read', count: 3 }]);
    assert.deepEqual(got!.dailyStats, [
      { date: '2026-06-13', tokens: 100, messages: 2, durationMs: 5_000 },
    ]);
  });

  it('upsert twice for the same session id updates the row in place (no duplicate)', () => {
    cache.upsert(makeRow({ totalTokens: 100 }));
    cache.upsert(makeRow({ totalTokens: 250, estimatedCostUsd: 1.25 }));

    const all = cache.listAll();
    assert.equal(all.length, 1, 'should not create a duplicate row');
    const got = cache.get('sess-1');
    assert.equal(got!.totalTokens, 250);
    assert.equal(got!.estimatedCostUsd, 1.25);
  });

  it('staleSessionIds flags a session whose stored mtime is older than provided', () => {
    cache.upsert(makeRow({ sessionId: 's-old', transcriptMtime: 100 }));

    const stale = cache.staleSessionIds([{ sessionId: 's-old', mtime: 500 }]);
    assert.deepEqual(stale, ['s-old']);
  });

  it('staleSessionIds flags a session id with no stored row', () => {
    const stale = cache.staleSessionIds([
      { sessionId: 'never-seen', mtime: 1 },
    ]);
    assert.deepEqual(stale, ['never-seen']);
  });

  it('staleSessionIds returns empty when all stored mtimes match', () => {
    cache.upsert(makeRow({ sessionId: 's-a', transcriptMtime: 42 }));
    cache.upsert(makeRow({ sessionId: 's-b', transcriptMtime: 7 }));

    const stale = cache.staleSessionIds([
      { sessionId: 's-a', mtime: 42 },
      { sessionId: 's-b', mtime: 7 },
    ]);
    assert.deepEqual(stale, []);
  });

  it('rows for different workspaces coexist and are scoped by workspace_id', () => {
    cache.upsert(makeRow({ sessionId: 's-a', workspaceId: 'ws-1', totalTokens: 10 }));
    cache.upsert(makeRow({ sessionId: 's-b', workspaceId: 'ws-2', totalTokens: 20 }));

    const ws1 = cache.listByWorkspace('ws-1');
    const ws2 = cache.listByWorkspace('ws-2');
    assert.equal(ws1.length, 1);
    assert.equal(ws1[0].sessionId, 's-a');
    assert.equal(ws2.length, 1);
    assert.equal(ws2[0].sessionId, 's-b');
    assert.equal(cache.listAll().length, 2);
  });

  it('clearByWorkspace removes only that workspace rows', () => {
    cache.upsert(makeRow({ sessionId: 's-a', workspaceId: 'ws-1' }));
    cache.upsert(makeRow({ sessionId: 's-b', workspaceId: 'ws-1' }));
    cache.upsert(makeRow({ sessionId: 's-c', workspaceId: 'ws-2' }));

    const removed = cache.clearByWorkspace('ws-1');
    assert.equal(removed, 2);
    assert.equal(cache.listByWorkspace('ws-1').length, 0);
    assert.equal(cache.listByWorkspace('ws-2').length, 1);
    assert.equal(cache.get('s-c')?.sessionId, 's-c');
  });

  it('handles a row with no messages (null timestamps, empty distributions)', () => {
    cache.upsert(
      makeRow({
        totalTokens: 0,
        messageCount: 0,
        firstMessageTs: null,
        lastMessageTs: null,
        modelUsage: [],
        toolUsage: [],
        dailyStats: [],
      }),
    );
    const got = cache.get('sess-1');
    assert.ok(got);
    assert.equal(got!.firstMessageTs, null);
    assert.equal(got!.lastMessageTs, null);
    assert.deepEqual(got!.modelUsage, []);
    assert.deepEqual(got!.dailyStats, []);
  });
});
