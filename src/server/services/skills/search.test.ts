/**
 * Tests for the Skills adapter's searchSkillsAPI reimplementation.
 *
 * Run via: `npx tsx --test src/server/services/skills/search.test.ts`
 *
 * Mirrors the U2 test scenarios from the plan:
 *   - Happy path: query returns sorted SearchSkill[]
 *   - Error path: fetch throws returns []
 *   - Edge case: empty query returns [] without calling fetch
 *   - Edge case: non-2xx returns []
 *   - Edge case: malformed body returns []
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { searchSkillsAPI } from './search.js';

const originalFetch = global.fetch;

function mockFetch(response: Response | Error): void {
  if (response instanceof Error) {
    global.fetch = (() => Promise.reject(response)) as typeof fetch;
  } else {
    global.fetch = (() => Promise.resolve(response)) as typeof fetch;
  }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('searchSkillsAPI', () => {
  beforeEach(() => {
    // Ensure each test starts clean
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns empty array for empty query without calling fetch', async () => {
    let fetchCalled = false;
    global.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;

    const result = await searchSkillsAPI('');
    assert.deepStrictEqual(result, []);
    assert.strictEqual(fetchCalled, false, 'fetch should not be called for empty query');

    const resultWs = await searchSkillsAPI('   ');
    assert.deepStrictEqual(resultWs, []);
  });

  it('returns sorted SearchSkill[] for a successful query', async () => {
    mockFetch(
      makeJsonResponse({
        skills: [
          { id: 'skill-a', name: 'Skill A', installs: 10, source: 'github.com/owner/repo' },
          { id: 'skill-b', name: 'Skill B', installs: 5000, source: 'github.com/owner/repo' },
          { id: 'skill-c', name: 'Skill C', installs: 200, source: 'github.com/owner/repo' },
        ],
      })
    );

    const result = await searchSkillsAPI('typescript');

    assert.strictEqual(result.length, 3);
    // Sorted descending by installs
    assert.strictEqual(result[0]!.name, 'Skill B');
    assert.strictEqual(result[1]!.name, 'Skill C');
    assert.strictEqual(result[2]!.name, 'Skill A');

    // Slug mirrors `id`, source mirrors `source`
    assert.strictEqual(result[0]!.slug, 'skill-b');
    assert.strictEqual(result[0]!.source, 'github.com/owner/repo');
  });

  it('strips terminal escape sequences from skill metadata', async () => {
    mockFetch(
      makeJsonResponse({
        skills: [
          {
            id: 'evil\x1b[2J\x1b[H',
            name: '\x1b[31mRed\x1b[0m Skill',
            installs: 1,
            source: 'foo\x07bar',
          },
        ],
      })
    );

    const result = await searchSkillsAPI('evil');
    assert.strictEqual(result.length, 1);
    // ESC sequences and BEL stripped
    assert.strictEqual(result[0]!.slug, 'evil');
    assert.strictEqual(result[0]!.name, 'Red Skill');
    assert.strictEqual(result[0]!.source, 'foobar');
  });

  it('defaults missing installs to 0', async () => {
    mockFetch(
      makeJsonResponse({
        skills: [{ id: 'no-installs', name: 'No Installs Skill', source: 'foo/bar' }],
      })
    );

    const result = await searchSkillsAPI('x');
    assert.strictEqual(result[0]!.installs, 0);
  });

  it('returns [] when fetch throws (network error)', async () => {
    mockFetch(new Error('ENOTFOUND'));

    const result = await searchSkillsAPI('broken');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when response is not ok', async () => {
    mockFetch(makeJsonResponse({ error: 'rate limited' }, 429));

    const result = await searchSkillsAPI('ratelimited');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when body is malformed JSON', async () => {
    mockFetch(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await searchSkillsAPI('garbage');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when body is valid JSON but missing skills array', async () => {
    mockFetch(makeJsonResponse({ message: 'no skills here' }));

    const result = await searchSkillsAPI('nothing');
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when skills is not an array', async () => {
    mockFetch(makeJsonResponse({ skills: 'not-an-array' }));

    const result = await searchSkillsAPI('weird');
    assert.deepStrictEqual(result, []);
  });

  it('encodes the query in the URL', async () => {
    let capturedUrl = '';
    global.fetch = ((input: string | URL | Request) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(makeJsonResponse({ skills: [] }));
    }) as typeof fetch;

    await searchSkillsAPI('a b&c=d');

    assert.ok(capturedUrl.includes('q=a+b%26c%3Dd') || capturedUrl.includes('q=a%20b%26c%3Dd'),
      `URL should encode query safely; got: ${capturedUrl}`);
  });
});
