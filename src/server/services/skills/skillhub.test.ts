import '../../test-utils/test-env.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getSkillHubSkill,
  isSkillHubCoordinate,
  SkillHubProviderError,
} from './skillhub.js';

const originalFetch = global.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SkillHub provider', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes canonical Skill metadata and preserves publisher enterprise identity', async () => {
    global.fetch = (() => Promise.resolve(json({
      slug: 'tencent-docs',
      namespace: { handle: 'tencent-adm' },
      owner: { handle: 'maintainer', displayName: 'Tencent Maintainer' },
      publisher: { orgId: 'org-bv6b8qcb' },
      skill: {
        slug: 'tencent-docs',
        displayName: 'Tencent Docs',
        summary: 'Document workflow',
        summary_zh: '腾讯文档工作流',
        category: 'productivity',
        stats: { downloads: 1250, installs: 42 },
      },
      latestVersion: { version: '2.1.0' },
      securityReports: {
        keen: { status: 'benign', statusText: 'Safe', reportUrl: 'https://skillhub.cn/reports/1' },
      },
    }))) as typeof fetch;

    const result = await getSkillHubSkill('tencent-adm', 'tencent-docs');

    assert.deepStrictEqual(result, {
      namespace: 'tencent-adm',
      slug: 'tencent-docs',
      displayName: 'Tencent Docs',
      summary: '腾讯文档工作流',
      category: 'productivity',
      owner: { handle: 'maintainer', displayName: 'Tencent Maintainer' },
      publisher: { orgId: 'org-bv6b8qcb' },
      version: '2.1.0',
      stats: { downloads: 1250, installs: 42 },
      securityReports: [{
        provider: 'keen',
        status: 'benign',
        statusText: 'Safe',
        reportUrl: 'https://skillhub.cn/reports/1',
      }],
      source: 'skillhub-cn:tencent-adm/tencent-docs',
    });
  });

  it('keeps unknown security providers as untrusted text and rejects unsafe report destinations', async () => {
    global.fetch = (() => Promise.resolve(json({
      slug: 'safe-skill',
      namespace: { handle: 'safe-org' },
      skill: { slug: 'safe-skill', displayName: 'Safe', stats: {} },
      securityReports: {
        keen: { status: 'unknown', statusText: 'Review', reportUrl: 'http://example.com/report' },
        futureScanner: { status: 'review', statusText: 'Unverified', reportUrl: 'https://example.com/future' },
      },
    }))) as typeof fetch;

    const result = await getSkillHubSkill('safe-org', 'safe-skill');

    assert.deepStrictEqual(result.securityReports, [
      { provider: 'keen', status: 'unknown', statusText: 'Review' },
      { provider: 'futureScanner', status: 'review', statusText: 'Unverified' },
    ]);
  });

  it('rejects invalid and oversized coordinates before making a request', async () => {
    let called = false;
    global.fetch = (() => {
      called = true;
      return Promise.resolve(json({}));
    }) as typeof fetch;

    assert.strictEqual(isSkillHubCoordinate('..'), false);
    assert.strictEqual(isSkillHubCoordinate('a'.repeat(129)), false);
    await assert.rejects(() => getSkillHubSkill('..', 'skill'), (error: unknown) =>
      error instanceof SkillHubProviderError && error.code === 'invalid-input');
    await assert.rejects(() => getSkillHubSkill('org', 'a'.repeat(129)), (error: unknown) =>
      error instanceof SkillHubProviderError && error.code === 'invalid-input');
    assert.strictEqual(called, false);
  });

  it('returns stable errors without leaking network diagnostics', async () => {
    global.fetch = (() => Promise.reject(new Error('secret signed-url token=abc\u001b[31m'))) as typeof fetch;

    await assert.rejects(() => getSkillHubSkill('safe-org', 'safe-skill'), (error: unknown) => {
      assert.ok(error instanceof SkillHubProviderError);
      assert.strictEqual(error.code, 'unavailable');
      assert.strictEqual(error.message, 'SkillHub request failed');
      return true;
    });
  });

  it('rejects malformed JSON and oversized declared bodies with stable provider errors', async () => {
    global.fetch = (() => Promise.resolve(new Response('{broken', { status: 200 }))) as typeof fetch;
    await assert.rejects(() => getSkillHubSkill('safe-org', 'safe-skill'), (error: unknown) =>
      error instanceof SkillHubProviderError
      && error.code === 'invalid-response'
      && error.message === 'SkillHub returned invalid JSON');

    global.fetch = (() => Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
    }))) as typeof fetch;
    await assert.rejects(() => getSkillHubSkill('safe-org', 'safe-skill'), (error: unknown) =>
      error instanceof SkillHubProviderError
      && error.code === 'invalid-response'
      && error.message === 'SkillHub response is too large');
  });

  it('rejects oversized display metadata instead of truncating it', async () => {
    global.fetch = (() => Promise.resolve(json({
      slug: 'safe-skill',
      namespace: { handle: 'safe-org' },
      skill: { slug: 'safe-skill', displayName: 'x'.repeat(513), stats: {} },
    }))) as typeof fetch;

    await assert.rejects(() => getSkillHubSkill('safe-org', 'safe-skill'), (error: unknown) =>
      error instanceof SkillHubProviderError
      && error.code === 'invalid-response'
      && error.message === 'SkillHub Skill display name exceeds the size limit');
  });

  it('maps timeout and not-found failures without exposing upstream response content', async () => {
    global.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    await assert.rejects(() => getSkillHubSkill('safe-org', 'safe-skill'), (error: unknown) =>
      error instanceof SkillHubProviderError
      && error.code === 'unavailable'
      && error.message === 'SkillHub request failed');

    global.fetch = (() => Promise.resolve(json({ message: 'private upstream detail' }, 404))) as typeof fetch;
    await assert.rejects(() => getSkillHubSkill('safe-org', 'safe-skill'), (error: unknown) =>
      error instanceof SkillHubProviderError
      && error.code === 'not-found'
      && error.status === 404
      && error.message === 'SkillHub resource not found');
  });
});
