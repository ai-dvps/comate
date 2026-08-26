import '../test-utils/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Thread } from '../generated/codex-protocol/v2/Thread.js';
import type { ThreadUsage } from '../generated/codex-protocol/v2/ThreadUsage.js';
import type { OpencodeRestMessage } from './opencode-transcript.js';
import {
  extractCodexSessionAnalytics,
  extractOpenCodeSessionAnalytics,
} from './analytics-backend-readers.js';

describe('analytics backend readers', () => {
  it('extracts OpenCode tokens, cost, duration, model, tools, and activity', () => {
    const messages: OpencodeRestMessage[] = [
      {
        info: {
          id: 'user-1',
          role: 'user',
          time: { created: Date.parse('2026-08-24T08:00:00.000Z') },
        },
        parts: [{ id: 'text-1', messageID: 'user-1', type: 'text', text: 'hello' }],
      },
      {
        info: {
          id: 'assistant-1',
          role: 'assistant',
          time: {
            created: Date.parse('2026-08-24T08:00:01.000Z'),
            completed: Date.parse('2026-08-24T08:00:04.000Z'),
          },
          modelID: 'kimi-k2.5',
          providerID: 'comate-provider-1',
          cost: 0.0125,
          tokens: {
            input: 100,
            output: 40,
            reasoning: 10,
            cache: { read: 25, write: 5 },
          },
        },
        parts: [
          {
            id: 'tool-1',
            messageID: 'assistant-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp' },
          },
        ],
      },
    ];

    const row = extractOpenCodeSessionAnalytics({
      sessionId: 'comate-oc-1',
      workspaceId: 'ws-1',
      fingerprint: 123,
      extractedAt: 456,
      messages,
    });

    assert.equal(row.totalTokens, 180);
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 50);
    assert.equal(row.cacheReadTokens, 25);
    assert.equal(row.cacheCreationTokens, 5);
    assert.equal(row.estimatedCostUsd, 0.0125);
    assert.equal(row.costCoveragePercent, 100);
    assert.equal(row.durationMs, 3_000);
    assert.equal(row.messageCount, 1);
    assert.deepEqual(row.modelUsage, [{
      model: 'kimi-k2.5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheCreationTokens: 5,
      totalTokens: 180,
    }]);
    assert.deepEqual(row.toolUsage, [{ tool: 'Bash', count: 1 }]);
    assert.equal(row.dailyStats.length, 1);
    assert.equal(row.dailyStats[0]?.tokens, 180);
    assert.equal(row.dailyStats[0]?.messages, 1);
    assert.equal(row.dailyStats[0]?.durationMs, 3_000);
  });

  it('extracts Codex thread usage and authoritative turn activity without inventing daily tokens', () => {
    const thread = {
      id: 'codex-thread-1',
      createdAt: Date.parse('2026-08-24T08:00:00.000Z') / 1_000,
      updatedAt: Date.parse('2026-08-25T09:30:00.000Z') / 1_000,
      turns: [
        {
          id: 'turn-1',
          startedAt: Date.parse('2026-08-24T08:00:00.000Z') / 1_000,
          completedAt: Date.parse('2026-08-24T08:00:03.000Z') / 1_000,
          durationMs: 3_000,
          status: 'completed',
          error: null,
          itemsView: { type: 'full' },
          items: [
            { type: 'agentMessage', id: 'agent-1', text: 'done', phase: null, memoryCitation: null, delivery: null },
            {
              type: 'commandExecution', id: 'cmd-1', pluginId: null, scriptPath: null,
              command: 'pwd', cwd: '/tmp', processId: null, source: 'user_shell',
              status: 'completed', commandActions: [], aggregatedOutput: '/tmp', exitCode: 0, durationMs: 10,
            },
          ],
        },
        {
          id: 'turn-2',
          startedAt: Date.parse('2026-08-25T09:30:00.000Z') / 1_000,
          completedAt: Date.parse('2026-08-25T09:30:02.000Z') / 1_000,
          durationMs: 2_000,
          status: 'completed',
          error: null,
          itemsView: { type: 'full' },
          items: [{ type: 'contextCompaction', id: 'compact-1' }],
        },
      ],
    } as unknown as Thread;
    const usage = {
      threadId: thread.id,
      estimatedUsageCreditsMicros: 0n,
      estimatedUsageUsdMicros: 25_000n,
      groups: [{
        model: 'gpt-5.6',
        reasoningEffort: 'high',
        speed: null,
        estimatedUsageCreditsMicros: 0n,
        netNewInputTokens: 120n,
        cachedInputTokens: 30n,
        inputTokens: 150n,
        outputTokens: 50n,
        totalTokens: 200n,
      }],
    } satisfies ThreadUsage;

    const row = extractCodexSessionAnalytics({
      sessionId: 'comate-codex-1',
      workspaceId: 'ws-1',
      fingerprint: 789,
      extractedAt: 999,
      thread,
      usage,
    });

    assert.equal(row.totalTokens, 200);
    assert.equal(row.inputTokens, 120);
    assert.equal(row.outputTokens, 50);
    assert.equal(row.cacheReadTokens, 30);
    assert.equal(row.cacheCreationTokens, 0);
    assert.equal(row.estimatedCostUsd, 0.025);
    assert.equal(row.costCoveragePercent, 100);
    assert.equal(row.durationMs, 5_000);
    assert.equal(row.messageCount, 2);
    assert.deepEqual(row.toolUsage, [{ tool: 'Bash', count: 1 }]);
    assert.equal(row.hasCompaction, true);
    assert.equal(row.dailyStats.length, 2);
    assert.equal(row.dailyStats.reduce((sum, day) => sum + day.messages, 0), 2);
    assert.equal(row.dailyStats.reduce((sum, day) => sum + day.tokens, 0), 0);
    assert.equal(row.heatmap.reduce((sum, cell) => sum + cell.messages, 0), 2);
  });
});
