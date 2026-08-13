import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWecomToolOperation } from './wecom-tool-presentation.js';

describe('summarizeWecomToolOperation', () => {
  it('redacts authorization headers, bearer tokens, and credential flags', () => {
    const summary = summarizeWecomToolOperation(
      {
        command:
          `PASSWORD=hunter2 curl -H 'Authorization: Bearer header-secret' ` +
          `--api-key cli-secret --token=token-secret https://example.com`,
      },
      'Bash',
      500,
    );

    assert.match(summary, /PASSWORD=\[REDACTED\]/);
    assert.match(summary, /'Authorization: \[REDACTED\]'/);
    assert.match(summary, /--api-key \[REDACTED\]/);
    assert.match(summary, /--token=\[REDACTED\]/);
    for (const secret of ['hunter2', 'header-secret', 'cli-secret', 'token-secret']) {
      assert.doesNotMatch(summary, new RegExp(secret));
    }
  });

  it('redacts URL userinfo and sensitive query parameters while retaining useful URL context', () => {
    const summary = summarizeWecomToolOperation(
      {
        url: 'https://alice:password@example.com/v1/items?token=url-secret&limit=20&api_key=key-secret',
      },
      'WebFetch',
      500,
    );

    assert.equal(
      summary,
      'https://[REDACTED]@example.com/v1/items?token=[REDACTED]&limit=20&api_key=[REDACTED]',
    );
  });

  it('redacts sensitive fallback text before applying the display bound', () => {
    const summary = summarizeWecomToolOperation(undefined, 'Bearer fallback-secret for request', 100);
    assert.equal(summary, 'Bearer [REDACTED] for request');
  });
});
