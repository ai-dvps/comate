import '../../test-utils/test-env.js';

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  buildWeSkillHubUrl,
  createWeSkillHubClient,
  normalizeWeSkillHubBaseUrl,
  WeSkillHubError,
  WESKILLHUB_ARCHIVE_MAX_BYTES,
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

describe('WeSkillHub exact-version transactions', () => {
  it('freezes exactly one valid latest version and its exact download URL', async () => {
    const requested: URL[] = [];
    const client = createWeSkillHubClient({
      baseUrl: 'https://catalog.example/api/v1',
      fetchImpl: async (input) => {
        requested.push(new URL(String(input)));
        return jsonResponse({
          code: '0',
          data: {
            versions: [
              { version: '1.0.0', file_size: 10, sha256: 'a'.repeat(64), is_latest: false },
              { version: '1.1.0', file_size: 1234, sha256: 'ABCDEF'.repeat(10) + 'ABCD', is_latest: true },
            ],
          },
        });
      },
    });

    const transaction = await client.resolveLatestVersion({ id: 116, slug: 'weoa-todo' });

    assert.deepStrictEqual(transaction, {
      id: 116,
      slug: 'weoa-todo',
      version: '1.1.0',
      fileSize: 1234,
      sha256: 'abcdef'.repeat(10) + 'abcd',
      downloadUrl: 'https://catalog.example/api/v1/skills/weoa-todo/download?version=1.1.0',
    });
    assert.strictEqual(Object.isFrozen(transaction), true);
    assert.strictEqual(requested[0]?.pathname, '/api/v1/skills/116/versions');
  });

  it('rejects missing, duplicate, and malformed latest metadata before download', async () => {
    const invalidData = [
      [],
      [
        { version: '1.0.0', file_size: 1, sha256: 'a'.repeat(64), is_latest: true },
        { version: '1.1.0', file_size: 1, sha256: 'b'.repeat(64), is_latest: true },
      ],
      [{ version: '../latest', file_size: 1, sha256: 'a'.repeat(64), is_latest: true }],
      [{ version: '1.0.0', file_size: -1, sha256: 'a'.repeat(64), is_latest: true }],
      [{ version: '1.0.0', file_size: 1.5, sha256: 'a'.repeat(64), is_latest: true }],
      [{ version: '1.0.0', file_size: WESKILLHUB_ARCHIVE_MAX_BYTES + 1, sha256: 'a'.repeat(64), is_latest: true }],
      [{ version: '1.0.0', file_size: 1, sha256: 'not-a-digest', is_latest: true }],
    ];

    for (const data of invalidData) {
      const client = createWeSkillHubClient({
        baseUrl: 'https://catalog.example/api/v1',
        fetchImpl: async () => jsonResponse({ code: '0', data: { versions: data } }),
      });
      await assert.rejects(
        () => client.resolveLatestVersion({ id: 116, slug: 'weoa-todo' }),
        (error) => error instanceof WeSkillHubError
          && error.category === 'invalid-response'
          && !error.message.includes('latest')
          && !error.message.includes('not-a-digest'),
      );
    }
  });

  it('bounds declared and streamed version JSON even with a false Content-Length', async () => {
    for (const response of [
      new Response('x', { headers: { 'Content-Length': String(WESKILLHUB_JSON_MAX_BYTES + 1) } }),
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(WESKILLHUB_JSON_MAX_BYTES + 1));
          controller.close();
        },
      }), { headers: { 'Content-Length': '1' } }),
    ]) {
      const client = createWeSkillHubClient({
        baseUrl: 'https://catalog.example/api/v1',
        fetchImpl: async () => response,
      });
      await assert.rejects(
        () => client.resolveLatestVersion({ id: 116, slug: 'weoa-todo' }),
        (error) => error instanceof WeSkillHubError && error.category === 'response-too-large',
      );
    }
  });

  it('accepts an exact-limit version response and rejects limit plus one', async () => {
    const metadata = JSON.stringify({
      code: '0',
      data: {
        versions: [{ version: '1.0.0', file_size: 0, sha256: 'a'.repeat(64), is_latest: true }],
      },
    });
    const exact = metadata + ' '.repeat(WESKILLHUB_JSON_MAX_BYTES - metadata.length);
    const exactClient = createWeSkillHubClient({
      baseUrl: 'https://catalog.example/api/v1',
      fetchImpl: async () => new Response(exact),
    });
    assert.strictEqual(
      (await exactClient.resolveLatestVersion({ id: 116, slug: 'weoa-todo' })).version,
      '1.0.0',
    );

    const oversizedClient = createWeSkillHubClient({
      baseUrl: 'https://catalog.example/api/v1',
      fetchImpl: async () => new Response(`${exact} `),
    });
    await assert.rejects(
      () => oversizedClient.resolveLatestVersion({ id: 116, slug: 'weoa-todo' }),
      (error) => error instanceof WeSkillHubError && error.category === 'response-too-large',
    );
  });

  it('downloads the frozen version once with fresh safe transport and verifies size and SHA-256', async () => {
    const archive = new TextEncoder().encode('PK\u0003\u0004fixture');
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let versionReads = 0;
    const client = createWeSkillHubClient({
      baseUrl: 'https://catalog.example/api/v1',
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith('/versions')) {
          versionReads += 1;
          return jsonResponse({
            code: '0',
            data: {
              versions: [{ version: '1.0.0', file_size: archive.byteLength, sha256, is_latest: true }],
            },
          });
        }
        return new Response(archive, { headers: { 'Content-Type': 'application/zip; charset=binary' } });
      },
    });

    const transaction = await client.resolveLatestVersion({ id: 116, slug: 'weoa-todo' });
    assert.deepStrictEqual(await client.downloadExactVersion(transaction), archive);
    assert.strictEqual(versionReads, 1);
    assert.strictEqual(requests[1]?.url, transaction.downloadUrl);
    assert.strictEqual(requests[1]?.init?.redirect, 'error');
    assert.strictEqual(requests[1]?.init?.credentials, 'omit');
    assert.ok(requests[1]?.init?.signal instanceof AbortSignal);
    assert.notStrictEqual(requests[0]?.init?.signal, requests[1]?.init?.signal);
  });

  it('sanitizes download redirect, HTTP, type, truncation, size, digest, and streamed-limit failures', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const baseTransaction = Object.freeze({
      id: 116,
      slug: 'weoa-todo',
      version: '1.0.0',
      fileSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      downloadUrl: 'https://catalog.example/api/v1/skills/weoa-todo/download?version=1.0.0',
    });
    const cases: Array<{ response: () => Response | Promise<Response>; category: string }> = [
      { response: async () => { throw new Error('redirect to https://secret.internal/file'); }, category: 'network' },
      // DOMException is an Error subclass on current runtimes, so a fetch that
      // rejects with TimeoutError is the deadline firing → 'timeout', not 'network'.
      { response: async () => { throw new DOMException('private timeout detail', 'TimeoutError'); }, category: 'timeout' },
      { response: () => new Response('secret body', { status: 502 }), category: 'http' },
      { response: () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } }), category: 'archive' },
      { response: () => new Response(bytes.slice(0, 2), { headers: { 'Content-Type': 'application/zip' } }), category: 'archive' },
      { response: () => new Response(new Uint8Array([1, 2, 4]), { headers: { 'Content-Type': 'application/zip' } }), category: 'archive' },
      {
        response: () => new Response(new Uint8Array(WESKILLHUB_ARCHIVE_MAX_BYTES + 1), {
          headers: { 'Content-Type': 'application/zip', 'Content-Length': '1' },
        }),
        category: 'response-too-large',
      },
    ];

    for (const testCase of cases) {
      const client = createWeSkillHubClient({
        baseUrl: 'https://catalog.example/api/v1',
        fetchImpl: async () => testCase.response(),
      });
      await assert.rejects(
        () => client.downloadExactVersion(baseTransaction),
        (error) => error instanceof WeSkillHubError
          && error.category === testCase.category
          && !error.message.includes('secret')
          && !error.message.includes('catalog.example'),
      );
    }
  });
});

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 32 || codePoint === 127;
  });
}
