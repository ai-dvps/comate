/**
 * Run via: `npx tsx --test src/server/services/analytics-transcript-reader.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractFromTranscriptText,
  extractSessionAnalytics,
} from './analytics-transcript-reader.js';

function assistantLine(overrides: Record<string, unknown> = {}): string {
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
      content: [{ type: 'text', text: 'hi' }],
    },
    ...overrides,
  });
}

function turnDurationLine(durationMs: number, timestamp = '2026-06-13T14:30:01.000Z'): string {
  return JSON.stringify({
    type: 'system',
    timestamp,
    durationMs,
    messageCount: 2,
  });
}

function compactBoundaryLine(): string {
  return JSON.stringify({
    type: 'compact_boundary',
    timestamp: '2026-06-13T14:00:00.000Z',
    compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 200, durationMs: 500 },
  });
}

describe('extractFromTranscriptText', () => {
  it('sums usage across assistant entries and attributes tokens to the per-turn model', () => {
    const text = [assistantLine(), assistantLine()].join('\n');
    const agg = extractFromTranscriptText(text);

    assert.equal(agg.totalTokens, 330); // 165 × 2
    assert.equal(agg.inputTokens, 200);
    assert.equal(agg.outputTokens, 100);
    assert.equal(agg.cacheCreationTokens, 20);
    assert.equal(agg.cacheReadTokens, 10);
    assert.equal(agg.messageCount, 2);
    assert.equal(agg.modelUsage.length, 1);
    assert.equal(agg.modelUsage[0].model, 'claude-sonnet-4');
    assert.equal(agg.modelUsage[0].totalTokens, 330);
  });

  it('attributes cost only to models with explicit pricing and computes coverage over known models', () => {
    const text = [
      assistantLine(), // claude-sonnet-4 (priced)
      assistantLine({
        message: {
          model: 'claude-future-9',
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [],
        },
      }),
    ].join('\n');
    const agg = extractFromTranscriptText(text);

    // claude-sonnet-4: 100 in + 50 out + 10 ccw + 5 cr
    //   = 100/1M*3 + 50/1M*15 + 10/1M*3.75 + 5/1M*0.3
    //   ≈ 0.001089 USD; unknown model contributes 0 cost.
    assert.ok(agg.estimatedCostUsd > 0);
    // Coverage: 165 of 465 tokens are priced → ~35.48%
    assert.equal(agg.totalTokens, 465);
    assert.ok(Math.abs(agg.costCoveragePercent - (165 / 465) * 100) < 0.01);
  });

  it('counts tool_use blocks by name across turns', () => {
    const text = [
      assistantLine({
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: 'tool_use', name: 'Read' },
            { type: 'tool_use', name: 'Read' },
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      }),
    ].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.deepEqual(
      agg.toolUsage,
      [
        { tool: 'Read', count: 2 },
        { tool: 'Bash', count: 1 },
      ],
    );
  });

  it('sums durationMs across system/turn_duration entries', () => {
    const text = [
      turnDurationLine(5_000),
      turnDurationLine(3_000, '2026-06-13T15:00:00.000Z'),
    ].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.equal(agg.durationMs, 8_000);
  });

  it('sets hasCompaction when a compact_boundary entry is present', () => {
    const text = [assistantLine(), compactBoundaryLine(), assistantLine()].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.equal(agg.hasCompaction, true);
  });

  it('keeps hasCompaction false when no compact_boundary entry appears', () => {
    const agg = extractFromTranscriptText(assistantLine());
    assert.equal(agg.hasCompaction, false);
  });

  it('buckets assistant entries into daily stats keyed by local YYYY-MM-DD', () => {
    const text = [
      assistantLine({ timestamp: '2026-06-13T14:30:00.000Z' }),
      assistantLine({ timestamp: '2026-06-14T01:00:00.000Z' }),
    ].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.equal(agg.dailyStats.length, 2);
    assert.deepEqual(
      agg.dailyStats.map((d) => d.date),
      ['2026-06-13', '2026-06-14'].sort(),
    );
  });

  it('records first and last message timestamps across all entries', () => {
    const text = [
      assistantLine({ timestamp: '2026-06-13T14:30:00.000Z' }),
      turnDurationLine(1_000, '2026-06-13T14:31:00.000Z'),
      assistantLine({ timestamp: '2026-06-13T15:00:00.000Z' }),
    ].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.equal(agg.firstMessageTs, Date.parse('2026-06-13T14:30:00.000Z'));
    assert.equal(agg.lastMessageTs, Date.parse('2026-06-13T15:00:00.000Z'));
  });

  it('emits a heatmap cell per distinct dayOfWeek-hour bucket', () => {
    const text = [
      assistantLine({ timestamp: '2026-06-13T14:30:00.000Z' }), // Sat 14:30 (local)
      assistantLine({ timestamp: '2026-06-13T14:45:00.000Z' }), // same bucket
      assistantLine({ timestamp: '2026-06-13T16:00:00.000Z' }), // Sat 16:00
    ].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.equal(agg.heatmap.length, 2);
    const doubled = agg.heatmap.find((c) => c.messages === 2);
    assert.ok(doubled, 'expected one cell with 2 messages');
    assert.equal(doubled!.tokens, 330);
  });

  it('returns zero aggregates for empty text', () => {
    const agg = extractFromTranscriptText('');
    assert.equal(agg.totalTokens, 0);
    assert.equal(agg.messageCount, 0);
    assert.equal(agg.costCoveragePercent, 100); // no tokens → full coverage by convention
    assert.deepEqual(agg.modelUsage, []);
    assert.deepEqual(agg.toolUsage, []);
    assert.deepEqual(agg.dailyStats, []);
    assert.deepEqual(agg.heatmap, []);
    assert.equal(agg.firstMessageTs, null);
    assert.equal(agg.hasCompaction, false);
  });

  it('skips malformed JSON lines without throwing', () => {
    const text = ['{not valid json', assistantLine(), ''].join('\n');
    const agg = extractFromTranscriptText(text);
    assert.equal(agg.messageCount, 1);
  });
});

describe('extractSessionAnalytics', () => {
  it('reads a real file from disk and returns a complete row including metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analytics-reader-'));
    const path = join(dir, 'sess-1.jsonl');
    writeFileSync(path, assistantLine());

    const outcome = extractSessionAnalytics({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      transcriptPath: path,
      transcriptMtime: 1_000,
      extractedAt: 9_000,
    });

    assert.ok(outcome.row);
    assert.equal(outcome.row!.sessionId, 'sess-1');
    assert.equal(outcome.row!.workspaceId, 'ws-1');
    assert.equal(outcome.row!.transcriptMtime, 1_000);
    assert.equal(outcome.row!.extractedAt, 9_000);
    assert.equal(outcome.row!.messageCount, 1);
  });

  it('returns reason="not-found" when the transcript file is missing', () => {
    const outcome = extractSessionAnalytics({
      sessionId: 'sess-x',
      workspaceId: 'ws-1',
      transcriptPath: '/nonexistent/path/sess-x.jsonl',
      transcriptMtime: 0,
      extractedAt: 0,
    });
    assert.equal(outcome.row, null);
    assert.equal(outcome.reason, 'not-found');
  });

  it('returns reason="empty" when the transcript file exists but is blank', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analytics-reader-'));
    const path = join(dir, 'sess-2.jsonl');
    writeFileSync(path, '   \n  \n');

    const outcome = extractSessionAnalytics({
      sessionId: 'sess-2',
      workspaceId: 'ws-1',
      transcriptPath: path,
      transcriptMtime: 1,
      extractedAt: 2,
    });
    assert.equal(outcome.row, null);
    assert.equal(outcome.reason, 'empty');
  });
});
