import '../../test-utils/test-env.js';
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
import {
  searchFederatedSkills,
  searchSkillhubCnSkills,
  searchSkillsAPI,
  searchSkillsHubSkills,
  searchWeSkillHubSkills,
} from './search.js';

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

    // The stable id and source preserve the upstream identifiers.
    assert.strictEqual(result[0]!.id, 'skills.sh:skill-b');
    assert.strictEqual(result[0]!.slug, 'skill-b');
    assert.strictEqual(result[0]!.source, 'github.com/owner/repo');
  });

  it('strips terminal escape sequences from skill metadata', async () => {
    mockFetch(
      makeJsonResponse({
        skills: [
          {
            id: 'evil[2J[H',
            name: '[31mRed[0m Skill',
            installs: 1,
            source: 'foobar',
          },
        ],
      })
    );

    const result = await searchSkillsAPI('evil');
    assert.strictEqual(result.length, 1);
    // ESC sequences and BEL stripped
    assert.strictEqual(result[0]!.id, 'skills.sh:evil');
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

  it('drops malformed records that cannot be installed', async () => {
    mockFetch(
      makeJsonResponse({
        skills: [
          { id: '', name: 'Missing id', source: 'acme/missing-id' },
          { id: 'missing-source', name: 'Missing source', source: '' },
          { id: 'valid', name: 'Valid', source: 'acme/valid' },
        ],
      })
    );

    const result = await searchSkillsAPI('valid');

    assert.deepStrictEqual(result.map((skill) => skill.slug), ['valid']);
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

    assert.ok(capturedUrl.includes('q=a%20b'));
    assert.ok(capturedUrl.includes('%26') || capturedUrl.includes('&'), 'ampersand should be encoded');
    assert.ok(capturedUrl.includes('%3D') || capturedUrl.includes('='), 'equals should be encoded');
  });
});

describe('searchFederatedSkills', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('queries all registries concurrently, returning source-aware results', async () => {
    const requestedUrls: string[] = [];
    global.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);
      if (url.includes('skills.sh')) {
        return Promise.resolve(makeJsonResponse({
          skills: [{ id: 'frontend-design', name: 'Frontend Design', installs: 200, source: 'acme/design' }],
        }));
      }

      if (url.includes('skillshub.wtf')) {
        return Promise.resolve(makeJsonResponse({
          data: [{
            skill: {
              slug: 'security-review',
              name: 'Security Review',
              repo: { githubOwner: 'acme', githubRepoName: 'security-skills', starCount: 10 },
            },
          }],
        }));
      }

      if (url.includes('api.skillhub.cn')) {
        return Promise.resolve(makeJsonResponse({
          code: 0,
          data: {
            skills: [{
              slug: 'security-audit',
              name: '安全审计',
              description_zh: '面向代码的安全审计流程',
              downloads: 80,
              namespace: { handle: 'tencent' },
            }],
          },
        }));
      }

      if (url.includes('weskillhub.weoa.com')) {
        return Promise.resolve(makeJsonResponse({
          code: '0',
          data: {
            data: [{
              id: 116,
              slug: 'weoa-todo',
              name: 'todo',
              description: 'Track work',
              downloads: 90,
              update_date: '2026-08-02T03:04:05Z',
            }],
          },
        }));
      }

      return Promise.resolve(makeJsonResponse({ items: [] }));
    }) as typeof fetch;

    const result = await searchFederatedSkills('security review');

    assert.strictEqual(requestedUrls.length, 5);
    assert.deepStrictEqual(
      result.map((skill) => ({ name: skill.name, sourceKind: skill.sourceKind })),
      [
        { name: 'Frontend Design', sourceKind: 'skills.sh' },
        { name: 'Security Review', sourceKind: 'skillshub' },
        { name: '安全审计', sourceKind: 'skillhub-cn' },
        { name: 'todo', sourceKind: 'weskillhub' },
      ]
    );
    assert.strictEqual(result[1]!.description, '');
  });

  it('keeps results from a healthy source when another source fails', async () => {
    global.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('weskillhub.weoa.com')) return Promise.reject(new Error('WeSkillHub unavailable'));
      return Promise.resolve(makeJsonResponse({
        skills: [{ id: 'review', name: 'Review', installs: 10, source: 'acme/review' }],
      }));
    }) as typeof fetch;

    const result = await searchFederatedSkills('review');

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.sourceKind, 'skills.sh');
  });

  it('applies shared downloads and newest sorting to WeSkillHub and peer results', async () => {
    global.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('skills.sh')) {
        return makeJsonResponse({
          skills: [{ id: 'popular', name: 'Popular', installs: 100, source: 'acme/popular' }],
        });
      }
      if (url.includes('weskillhub.weoa.com')) {
        return makeJsonResponse({
          code: '0',
          data: { data: [{
            id: 116,
            name: 'Recent',
            slug: 'recent',
            downloads: 10,
            update_date: '2026-08-02T03:04:05Z',
          }] },
        });
      }
      return makeJsonResponse({ items: [], data: [], code: 0 });
    }) as typeof fetch;

    const byDownloads = await searchFederatedSkills({ keyword: 'x', sort: 'downloads' });
    const byNewest = await searchFederatedSkills({ keyword: 'x', sort: 'newest' });

    assert.deepStrictEqual(byDownloads.map((skill) => skill.name), ['Popular', 'Recent']);
    assert.deepStrictEqual(byNewest.map((skill) => skill.name), ['Recent', 'Popular']);
  });

  it('does not query any source for an empty query', async () => {
    let calls = 0;
    global.fetch = (() => {
      calls += 1;
      return Promise.resolve(makeJsonResponse({}));
    }) as typeof fetch;

    assert.deepStrictEqual(await searchFederatedSkills('  '), []);
    assert.strictEqual(calls, 0);
  });

  it('sets a deadline on each provider request', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    global.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return Promise.resolve(makeJsonResponse({ skills: [], items: [] }));
    }) as typeof fetch;

    await searchFederatedSkills('timeout');

    assert.strictEqual(signals.length, 5);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  });
});

describe('searchSkillsHubSkills', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes Skillshub results to a GitHub repository installer source', async () => {
    mockFetch(makeJsonResponse({
      data: [{
        skill: {
          slug: 'typescript',
          name: 'TypeScript',
          description: 'Type-safe coding guidance',
          repo: {
            githubOwner: 'acme',
            githubRepoName: 'agent-skills',
            starCount: 120,
          },
        },
      }],
    }));

    const result = await searchSkillsHubSkills('typescript');

    assert.deepStrictEqual(result, [{
      id: 'skillshub:acme/agent-skills:typescript',
      name: 'TypeScript',
      slug: 'typescript',
      source: 'acme/agent-skills',
      installSource: 'acme/agent-skills',
      sourceKind: 'skillshub',
      description: 'Type-safe coding guidance',
      installs: 120,
    }]);
  });

  it('compiles semantic task text for SkillsHub and native filters for Tencent', async () => {
    const urls: string[] = [];
    global.fetch = ((input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return Promise.resolve(makeJsonResponse({ data: [], skills: [], items: [], code: 0 }));
    }) as typeof fetch;

    await searchFederatedSkills({
      keyword: 'review',
      scene: 'ai-agent',
      preferChinese: true,
      noApiKey: true,
      sort: 'newest',
    });

    const skillsHubUrl = new URL(urls.find((url) => url.includes('skillshub.wtf'))!);
    assert.strictEqual(skillsHubUrl.pathname, '/api/v1/skills/resolve');
    assert.match(skillsHubUrl.searchParams.get('task') || '', /AI agent/);
    assert.match(skillsHubUrl.searchParams.get('task') || '', /API key/);

    const tencentUrl = new URL(urls.find((url) => url.includes('api.skillhub.cn'))!);
    assert.strictEqual(tencentUrl.searchParams.get('category'), 'ai-agent');
    assert.strictEqual(tencentUrl.searchParams.get('labels'), 'requires_api_key:false');
    assert.strictEqual(tencentUrl.searchParams.get('sortBy'), 'newest');
    assert.strictEqual(tencentUrl.searchParams.get('keyword'), 'review 中文');

    const weSkillHubUrl = new URL(urls.find((url) => url.includes('weskillhub.weoa.com'))!);
    assert.strictEqual(weSkillHubUrl.searchParams.get('search'), 'review');
    assert.strictEqual(weSkillHubUrl.searchParams.get('sort_by'), 'update_date');
    assert.strictEqual(weSkillHubUrl.searchParams.has('scene'), false);
    assert.strictEqual(weSkillHubUrl.searchParams.has('category'), false);
    assert.strictEqual(weSkillHubUrl.searchParams.has('preferChinese'), false);
    assert.strictEqual(weSkillHubUrl.searchParams.has('noApiKey'), false);
    assert.doesNotMatch(weSkillHubUrl.searchParams.get('search') || '', /中文|API/);
  });
});

describe('searchWeSkillHubSkills', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes a distinct name and slug to a durable install coordinate', async () => {
    mockFetch(makeJsonResponse({
      code: '0',
      data: {
        data: [{
          id: 116,
          slug: 'weoa-todo',
          name: 'todo',
          description: 'Track work',
          downloads: 42,
          update_date: '2026-08-02T03:04:05Z',
        }],
      },
    }));

    assert.deepStrictEqual(await searchWeSkillHubSkills('todo'), [{
      id: 'weskillhub:116/weoa-todo',
      name: 'todo',
      slug: 'weoa-todo',
      source: 'weskillhub.weoa.com',
      installSource: 'weskillhub:116/weoa-todo',
      sourceKind: 'weskillhub',
      description: 'Track work',
      installs: 42,
      updatedAt: Date.parse('2026-08-02T03:04:05Z'),
    }]);
  });

  it('does not request empty queries and contains provider-local failures', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      throw new Error('unavailable');
    }) as typeof fetch;

    assert.deepStrictEqual(await searchWeSkillHubSkills('  '), []);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(await searchWeSkillHubSkills('todo'), []);
    assert.strictEqual(calls, 1);
  });

  it('maps all shared sort values to supported provider sort parameters', async () => {
    const sorts: string[] = [];
    global.fetch = (async (input) => {
      sorts.push(new URL(String(input)).searchParams.get('sort_by') || '');
      return makeJsonResponse({ code: '0', data: { data: [] } });
    }) as typeof fetch;

    await searchWeSkillHubSkills({ keyword: 'x', sort: 'score' });
    await searchWeSkillHubSkills({ keyword: 'x', sort: 'downloads' });
    await searchWeSkillHubSkills({ keyword: 'x', sort: 'newest' });

    assert.deepStrictEqual(sorts, ['hot', 'downloads', 'update_date']);
  });
});

describe('searchSkillhubCnSkills', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes Tencent SkillHub results to an installable registry coordinate', async () => {
    mockFetch(makeJsonResponse({
      code: 0,
      data: {
        skills: [{
          slug: 'ppt-crate',
          name: 'PPT生成',
          description: '',
          description_zh: '一键生成演示稿',
          downloads: 12_524,
          namespace: { handle: 'user_03e5be41' },
        }],
      },
    }));

    const result = await searchSkillhubCnSkills('ppt');

    assert.deepStrictEqual(result, [{
      id: 'skillhub-cn:user_03e5be41/ppt-crate',
      name: 'PPT生成',
      slug: 'ppt-crate',
      source: 'skillhub.cn',
      installSource: 'skillhub-cn:user_03e5be41/ppt-crate',
      sourceKind: 'skillhub-cn',
      description: '一键生成演示稿',
      installs: 12_524,
    }]);
  });
});
