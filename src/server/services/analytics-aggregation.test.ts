/**
 * Run via: `npx tsx --test src/server/services/analytics-aggregation.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  rollupGlobal,
  rollupWorkspace,
  type WorkspaceRollupInput,
} from './analytics-aggregation.js';
import type { SessionAnalyticsRow } from '../storage/analytics-cache.js';

function makeRow(overrides: Partial<SessionAnalyticsRow> = {}): SessionAnalyticsRow {
  return {
    sessionId: 's-1',
    workspaceId: 'ws-1',
    transcriptMtime: 1,
    extractedAt: 100,
    totalTokens: 100,
    inputTokens: 60,
    outputTokens: 30,
    cacheReadTokens: 5,
    cacheCreationTokens: 5,
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
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheCreationTokens: 5,
        totalTokens: 100,
      },
    ],
    toolUsage: [{ tool: 'Read', count: 3 }],
    dailyStats: [{ date: '2026-06-13', tokens: 100, messages: 2, durationMs: 5_000 }],
    heatmap: [{ dayOfWeek: 5, hour: 14, tokens: 100, messages: 2 }],
    ...overrides,
  };
}

describe('rollupWorkspace', () => {
  it('sums token totals across rows and reports the workspace context', () => {
    const summary = rollupWorkspace(
      [makeRow({ totalTokens: 100 }), makeRow({ sessionId: 's-2', totalTokens: 250 })],
      { workspaceId: 'ws-1', workspaceName: 'My Workspace' },
    );
    assert.equal(summary.workspaceId, 'ws-1');
    assert.equal(summary.workspaceName, 'My Workspace');
    assert.equal(summary.totalSessions, 2);
    assert.equal(summary.totalTokens, 350);
    assert.equal(summary.totalMessages, 4);
    assert.equal(summary.totalDurationMs, 10_000);
    assert.equal(summary.averageDurationMs, 5_000);
  });

  it('merges model usage, tool usage, daily stats, and heatmap across rows', () => {
    const summary = rollupWorkspace(
      [
        makeRow({
          modelUsage: [
            { model: 'claude-sonnet-4', inputTokens: 60, outputTokens: 30, cacheReadTokens: 5, cacheCreationTokens: 5, totalTokens: 100 },
          ],
          toolUsage: [{ tool: 'Read', count: 2 }],
          dailyStats: [{ date: '2026-06-13', tokens: 100, messages: 2, durationMs: 1_000 }],
          heatmap: [{ dayOfWeek: 5, hour: 14, tokens: 100, messages: 2 }],
        }),
        makeRow({
          sessionId: 's-2',
          modelUsage: [
            { model: 'claude-sonnet-4', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15 },
            { model: 'claude-opus-4', inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 100 },
          ],
          toolUsage: [{ tool: 'Read', count: 1 }, { tool: 'Bash', count: 4 }],
          dailyStats: [{ date: '2026-06-14', tokens: 115, messages: 3, durationMs: 2_000 }],
          heatmap: [{ dayOfWeek: 5, hour: 14, tokens: 50, messages: 1 }],
        }),
      ],
      { workspaceId: 'ws-1', workspaceName: 'ws' },
    );
    assert.equal(summary.mostUsedTools.length, 2);
    assert.equal(summary.mostUsedTools[0]!.tool, 'Bash');
    assert.equal(summary.mostUsedTools[0]!.count, 4);
    assert.equal(summary.mostUsedTools[1]!.tool, 'Read');
    assert.equal(summary.mostUsedTools[1]!.count, 3);
    assert.equal(summary.activityHeatmap.length, 1);
    assert.equal(summary.activityHeatmap[0]!.messages, 3);
    assert.equal(summary.dailyStats.length, 2);
    assert.deepEqual(
      summary.dailyStats.map((d) => d.date),
      ['2026-06-13', '2026-06-14'],
    );
  });

  it('computes recent growth by comparing last 7 days against prior 7 days', () => {
    const today = new Date('2026-06-14T00:00:00Z');
    const days: { date: string; tokens: number; messages: number; durationMs: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const date = d.toISOString().slice(0, 10);
      days.push({ date, tokens: i < 7 ? 100 : 50, messages: 1, durationMs: 0 });
    }
    const summary = rollupWorkspace(
      [makeRow({ dailyStats: days })],
      { workspaceId: 'ws-1', workspaceName: 'ws' },
    );
    assert.ok(summary.recentGrowth);
    assert.equal(summary.recentGrowth!.current, 700); // 7×100
    assert.equal(summary.recentGrowth!.previous, 350); // 7×50
    assert.equal(summary.recentGrowth!.percentDelta, 100); // +100%
  });

  it('returns recentGrowth=null when there are no daily stats', () => {
    const summary = rollupWorkspace(
      [makeRow({ dailyStats: [] })],
      { workspaceId: 'ws-1', workspaceName: 'ws' },
    );
    assert.equal(summary.recentGrowth, null);
  });

  it('produces a zero-valued summary for an empty row set (R13 empty state)', () => {
    const summary = rollupWorkspace([], { workspaceId: 'ws-empty', workspaceName: 'Empty' });
    assert.equal(summary.totalSessions, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.estimatedCostUsd, 0);
    assert.equal(summary.costCoveragePercent, 100);
    assert.equal(summary.averageDurationMs, 0);
    assert.deepEqual(summary.mostUsedTools, []);
    assert.deepEqual(summary.tokenDistribution, {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    });
  });
});

describe('rollupGlobal', () => {
  it('aggregates across workspaces and ranks top workspaces by tokens', () => {
    const bundles: WorkspaceRollupInput[] = [
      {
        ctx: { workspaceId: 'ws-a', workspaceName: 'Alpha' },
        rows: [
          makeRow({ workspaceId: 'ws-a', totalTokens: 1_000, messageCount: 5 }),
          makeRow({ workspaceId: 'ws-a', sessionId: 's-a2', totalTokens: 500, messageCount: 2 }),
        ],
      },
      {
        ctx: { workspaceId: 'ws-b', workspaceName: 'Beta' },
        rows: [makeRow({ workspaceId: 'ws-b', sessionId: 's-b1', totalTokens: 200, messageCount: 1 })],
      },
      {
        // Empty workspace should be excluded from totalWorkspaces and topWorkspaces.
        ctx: { workspaceId: 'ws-empty', workspaceName: 'Empty' },
        rows: [],
      },
    ];
    const summary = rollupGlobal(bundles);

    assert.equal(summary.totalWorkspaces, 2);
    assert.equal(summary.totalSessions, 3);
    assert.equal(summary.totalMessages, 8);
    assert.equal(summary.totalTokens, 1_700);
    assert.equal(summary.topWorkspaces.length, 2);
    assert.equal(summary.topWorkspaces[0]!.workspaceId, 'ws-a');
    assert.equal(summary.topWorkspaces[0]!.tokens, 1_500);
    assert.equal(summary.topWorkspaces[1]!.workspaceId, 'ws-b');
  });

  it('derives provider distribution from each session primary model', () => {
    const bundles: WorkspaceRollupInput[] = [
      {
        ctx: { workspaceId: 'ws-a', workspaceName: 'A' },
        rows: [
          makeRow({
            sessionId: 's-1',
            modelUsage: [
              { model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 150 },
            ],
            totalTokens: 150,
            messageCount: 1,
          }),
          makeRow({
            sessionId: 's-2',
            modelUsage: [
              { model: 'gpt-4.1', inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 100 },
            ],
            totalTokens: 100,
            messageCount: 1,
          }),
        ],
      },
    ];
    const summary = rollupGlobal(bundles);
    assert.equal(summary.providerDistribution.length, 2);
    const claude = summary.providerDistribution.find((p) => p.providerId === 'claude');
    const openai = summary.providerDistribution.find((p) => p.providerId === 'openai');
    assert.ok(claude);
    assert.ok(openai);
    assert.equal(claude!.tokens, 150);
    assert.equal(openai!.tokens, 100);
    assert.equal(claude!.sessions, 1);
    assert.equal(openai!.sessions, 1);
  });

  it('returns an empty-but-shaped summary for no data', () => {
    const summary = rollupGlobal([]);
    assert.equal(summary.totalWorkspaces, 0);
    assert.equal(summary.totalSessions, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.costCoveragePercent, 100);
    assert.deepEqual(summary.topWorkspaces, []);
    assert.deepEqual(summary.providerDistribution, []);
  });
});
