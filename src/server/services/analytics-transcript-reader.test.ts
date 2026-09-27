import '../test-utils/test-env.js';
/**
 * Run via: `npx tsx --test src/server/services/analytics-transcript-reader.test.ts`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractFromTranscriptText,
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
    assert.ok(agg.costCoveragePercent > 30 && agg.costCoveragePercent < 40);
  });
});