import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderTokenUsage, sumTurnTokenUsages } from './token-usage.js';

describe('token usage normalization', () => {
  it('keeps absent breakdown fields absent and does not double-count thinking', () => {
    assert.deepStrictEqual(normalizeProviderTokenUsage({
      input_tokens: 10,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 2 },
    }), {
      quality: 'exact', totalTokens: 14, inputTokens: 10, outputTokens: 4,
      thinkingTokens: 2,
    });
  });

  it('rejects usage without any valid non-negative number', () => {
    assert.strictEqual(normalizeProviderTokenUsage({ input_tokens: -1, output_tokens: NaN }), undefined);
  });

  it('sums multiple direct reports as an estimate', () => {
    assert.deepStrictEqual(sumTurnTokenUsages([
      { quality: 'exact', totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      { quality: 'exact', totalTokens: 7, inputTokens: 5, outputTokens: 2 },
    ]), {
      quality: 'estimated', totalTokens: 17, inputTokens: 13, outputTokens: 4,
    });
  });
});
