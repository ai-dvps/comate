import '../../test-utils/test-env.js';

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildWeSkillHubUrl,
  createWeSkillHubClient,
  normalizeWeSkillHubBaseUrl,
  WeSkillHubError,
  WESKILLHUB_JSON_MAX_BYTES,
} from './weskillhub.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function success(records: unknown[]): unknown {
  return { code: '0', data: { data: records } };
}

describe('WeSkillHub client configuration', () => {
  it('normalizes HTTP(S) bases and rejects unsafe URL components', () => {
    assert.strictEqual(
      normalizeWeSkillHubBaseUrl('HTTPS://Example.COM:443/api/v1'),
      'https://example.com/api/v1/',
    );

    for (const baseUrl of [
      'file:///api/v1',
      'https://user:secret@example.com/api/v1',
      'https://example.com/api/v1?tenant=internal',
      'https://example.com/api/v1?',
      'https://example.com/api/v1#fragment',
      'https://example.com/api/v1#',
    ]) {
      assert.throws(
        () => normalizeWeSkillHubBaseUrl(baseUrl),
        (error) => error instanceof WeSkillHubError
          && error.category === 'configuration'
          && error.message === 'WeSkillHub configuration error',
      );
    }
  });

  it('constructs encoded endpoints on the configured origin', () => {
    const url = buildWeSkillHubUrl(
      'https://catalog.example:8443/api/v1/',
      ['skills', 'nested/slug'],
      new URLSearchParams({ search: 'a b&c=d' }),
    );

    assert.strictEqual(url.origin, 'https://catalog.example:8443');
    assert.strictEqual(url.pathname, '/api/v1/skills/nested%2Fslug');
    assert.strictEqual(url.searchParams.get('search'), 'a b&c=d');
    assert.throws(
      () => buildWeSkillHubUrl('https://catalog.example/api/v1/', ['..', 'outside']),
      (error) => error instanceof WeSkillHubError && error.category === 'configuration',
    );
  });
});

describe('WeSkillHub search transport', () => {
  it('uses the exact origin, encoded query, fresh deadlines, no credentials, and redirect rejection', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      return jsonResponse(success([]));
    };
    const client = createWeSkillHubClient({
      baseUrl: 'https://catalog.example:8443/api/v1',
      fetchImpl,
    });

    await client.searchSkills({ search: 'a b&c=d', sort: 'hot' });
    await client.searchSkills({ search: 'second', sort: 'downloads' });

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0]!.url.origin, 'https://catalog.example:8443');
    assert.strictEqual(requests[0]!.url.pathname, '/api/v1/skills');
    assert.strictEqual(requests[0]!.url.searchParams.get('search'), 'a b&c=d');
    assert.strictEqual(requests[0]!.url.searchParams.get('page'), '1');
    assert.strictEqual(requests[0]!.url.searchParams.get('page_size'), '10');
    assert.strictEqual(requests[0]!.url.searchParams.get('sort_by'), 'hot');
    assert.strictEqual(requests[0]!.init?.redirect, 'error');
    assert.strictEqual(requests[0]!.init?.credentials, 'omit');
    assert.deepStrictEqual(requests[0]!.init?.headers, { Accept: 'application/json' });
    assert.ok(requests[0]!.init?.signal instanceof AbortSignal);
    assert.ok(requests[1]!.init?.signal instanceof AbortSignal);
    assert.notStrictEqual(requests[0]!.init?.signal, requests[1]!.init?.signal);
  });

  it('normalizes valid records while dropping invalid identities and sanitizing metadata', async () => {
    const client = createWeSkillHubClient({
      baseUrl: 'https://catalog.example/api/v1',
      fetchImpl: async () => jsonResponse(success([
        {
          id: 116,
          name: '\u001b[31mtodo\u001b[0m',
          slug: 'weoa-todo',
          description: 'Plan\nwork\u0007 safely',
          downloads: 42,
          update_date: '2026-08-02 03:04:05',
        },
        { id: '116', name: 'String id', slug: 'string-id' },
        { id: 117, name: '', slug: 'empty-name' },
        { id: 118, name: 'Unsafe slug', slug: '../escape' },
        { id: 119, name: 'Defaults', slug: 'defaults', downloads: -1, update_date: 'not-a-date' },
      ])),
    });

    assert.deepStrictEqual(await client.searchSkills({ search: 'todo', sort: 'hot' }), [
      {
        id: 116,
        name: 'todo',
        slug: 'weoa-todo',
        description: 'Plan work safely',
        downloads: 42,
        updatedAt: Date.parse('2026-08-02T03:04:05Z'),
      },
      {
        id: 119,
        name: 'Defaults',
        slug: 'defaults',
        description: '',
        downloads: 0,
      },
    ]);
  });

  it('maps protocol failures to sanitized public categories', async () => {
    const cases: Array<{ response: () => Response | Promise<Response>; category: string }> = [
      { response: () => jsonResponse({ internal: 'secret\u0007' }, { status: 502 }), category: 'http' },
      { response: () => new Response('not-json'), category: 'invalid-response' },
      { response: () => jsonResponse({ code: '19', message: 'secret payload' }), category: 'provider' },
      { response: () => jsonResponse({ code: '0', data: { data: {} } }), category: 'invalid-response' },
      {
        response: () => new Response('x'.repeat(WESKILLHUB_JSON_MAX_BYTES + 1), {
          headers: { 'Content-Length': String(WESKILLHUB_JSON_MAX_BYTES + 1) },
        }),
        category: 'response-too-large',
      },
    ];

    for (const testCase of cases) {
      const client = createWeSkillHubClient({
        baseUrl: 'https://private.example/api/v1',
        fetchImpl: async () => testCase.response(),
      });
      await assert.rejects(
        () => client.searchSkills({ search: 'x', sort: 'hot' }),
        (error) => error instanceof WeSkillHubError
          && error.category === testCase.category
          && !error.message.includes('private.example')
          && !error.message.includes('secret')
          && !hasControlCharacter(error.message),
      );
    }
  });

  it('classifies fetch failures without exposing their messages', async () => {
    const client = createWeSkillHubClient({
      baseUrl: 'https://private.example/api/v1',
      fetchImpl: async () => { throw new Error('redirect to http://secret.internal/path\u0007'); },
    });

    await assert.rejects(
      () => client.searchSkills({ search: 'x', sort: 'hot' }),
      (error) => error instanceof WeSkillHubError
        && error.category === 'network'
        && error.message === 'WeSkillHub network error',
    );
  });
});

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 32 || codePoint === 127;
  });
}
