import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactGithubError } from './github-types.js';

const ACCESS = 'ghp_SENTINEL_ACCESS_TOKEN';
const REFRESH = 'gho_SENTINEL_REFRESH_TOKEN';

/** An octokit-shaped error that leaks the token in every place redaction must cover. */
function octokitError(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: 'RequestError',
    message: 'POST https://api.github.com/repos/owner/repo/issues failed',
    status: 500,
    request: {
      method: 'POST',
      url: 'https://api.github.com/repos/owner/repo/issues?token=' + ACCESS,
      headers: {
        authorization: 'Bearer ' + ACCESS,
        cookie: 'session=' + ACCESS,
        'user-agent': 'comate',
      },
      body: { title: 'x' },
    },
    response: {
      status: 500,
      headers: { 'x-ratelimit-limit': '5000' },
      data: {
        message: 'Server Error',
        access_token: ACCESS,
        refresh_token: REFRESH,
      },
    },
    ...overrides,
  };
}

describe('redactGithubError (R13)', () => {
  it('strips authorization/cookie headers and token-bearing response data', () => {
    const redacted = redactGithubError(octokitError());
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes(ACCESS), 'access token leaked: ' + serialized);
    assert.ok(!serialized.includes(REFRESH), 'refresh token leaked: ' + serialized);
    // No raw Bearer value survives — only the safe 'Bearer [REDACTED]' marker.
    assert.ok(!serialized.includes('Bearer ghp'), 'raw Bearer value leaked');
    // Safe metadata survives so callers can branch on status/method.
    assert.equal(redacted.status, 500);
    assert.equal(redacted.request?.method, 'POST');
    assert.equal(redacted.response?.status, 500);
    // Sensitive keys are marked, not dropped, so logs show *that* a header existed.
    assert.equal((redacted.request as { headers?: unknown }).headers, undefined);
  });

  it('scrubs Bearer and token= forms out of arbitrary strings (deep response data)', () => {
    const redacted = redactGithubError({
      message: 'failed with Bearer ' + ACCESS + ' and token=' + REFRESH,
      response: { data: { nested: 'see ' + ACCESS + ' and ' + REFRESH } },
    });
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes(ACCESS));
    assert.ok(!serialized.includes(REFRESH));
    assert.ok(serialized.includes('Bearer [REDACTED]'));
    assert.ok(serialized.includes('token=[REDACTED]'));
  });

  it('handles non-Error / nullish input without throwing', () => {
    assert.doesNotThrow(() => redactGithubError(null));
    assert.doesNotThrow(() => redactGithubError(undefined));
    assert.doesNotThrow(() => redactGithubError('plain string ' + ACCESS));
    const r = redactGithubError('plain string ' + ACCESS);
    assert.ok(!r.message.includes(ACCESS));
  });

  it('does not crash on circular references in response data', () => {
    const circular: Record<string, unknown> = { token: ACCESS };
    circular.self = circular;
    const redacted = redactGithubError({ message: 'x', response: { data: circular } });
    assert.ok(!JSON.stringify(redacted).includes(ACCESS));
  });
});
