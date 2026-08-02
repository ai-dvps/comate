import '../../test-utils/test-env.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getExpertPackage,
  getExpertPackageDefinition,
  getExpertSkill,
  listExpertPackages,
} from './expert-packages.js';

const originalFetch = global.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('expert package provider', () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes list rows without returning orchestration content', async () => {
    let requestedUrl = '';
    global.fetch = ((input: string | URL | Request) => {
      requestedUrl = input.toString();
      return Promise.resolve(json({
        total: 1,
        skillSets: [{
          slug: 'tech-test-automation',
          displayName: '自动化测试',
          summary: '完整自动化测试工作流',
          scene: 'tech',
          subScene: 'test',
          skillCount: 6,
          skills: [{ namespace: 'axelhu', slug: 'superpowers-tdd' }],
          content: 'must not leak',
          contentEn: 'must not leak',
        }],
      }));
    }) as typeof fetch;

    const result = await listExpertPackages({
      keyword: 'test',
      scene: 'tech',
      page: 2,
      pageSize: 12,
    });

    assert.match(requestedUrl, /keyword=test/);
    assert.match(requestedUrl, /scene=tech/);
    assert.match(requestedUrl, /page=2/);
    assert.deepStrictEqual(result, {
      total: 1,
      packages: [{
        slug: 'tech-test-automation',
        displayName: '自动化测试',
        summary: '完整自动化测试工作流',
        scene: 'tech',
        subScene: 'test',
        skillCount: 6,
        source: 'skillhub.cn',
      }],
    });
    assert.strictEqual('content' in result.packages[0]!, false);
  });

  it('marks a package incomplete when a child cannot be resolved', async () => {
    global.fetch = ((input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/skillsets/')) {
        return Promise.resolve(json({
          slug: 'tech-test-automation',
          displayName: '自动化测试',
          summary: '完整工作流',
          scene: 'tech',
          content: '---\nname: tech-test-automation\n---\n# Workflow',
          skills: [
            { namespace: 'axelhu', slug: 'superpowers-tdd' },
            { namespace: 'missing', slug: 'gone' },
          ],
        }));
      }
      if (url.includes('superpowers-tdd')) {
        return Promise.resolve(json({
          slug: 'superpowers-tdd',
          namespace: { handle: 'axelhu' },
          owner: { handle: 'axelhu', displayName: 'axelhu' },
          skill: { slug: 'superpowers-tdd', displayName: 'Superpowers TDD', summary: 'TDD', category: 'dev', stats: {} },
          latestVersion: { version: '1.0.0' },
          securityReports: {
            keen: { status: 'benign', statusText: 'Safe', reportUrl: 'https://example.com/report' },
          },
        }));
      }
      return Promise.resolve(json({ message: 'not found' }, 404));
    }) as typeof fetch;

    const result = await getExpertPackage('tech-test-automation');

    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.children.length, 2);
    assert.strictEqual(result.children[0]!.available, true);
    assert.deepStrictEqual(result.children[0]!.securityReports, [{
      provider: 'keen',
      status: 'benign',
      statusText: 'Safe',
      reportUrl: 'https://example.com/report',
    }]);
    assert.strictEqual(result.children[1]!.available, false);
  });

  it('marks packages with colliding install names structurally incomplete', async () => {
    global.fetch = (() => Promise.resolve(json({
      slug: 'collision-package',
      displayName: 'Collision package',
      summary: 'Conflicting flat install names',
      scene: 'tech',
      content: '---\nname: collision-package\n---\n# Workflow',
      skills: [
        { namespace: 'first', slug: 'shared-name' },
        { namespace: 'second', slug: 'shared-name' },
      ],
    }))) as typeof fetch;

    const result = await getExpertPackageDefinition('collision-package');

    assert.strictEqual(result.structurallyComplete, false);
  });

  it('normalizes included Skill metadata and security reports', async () => {
    global.fetch = (() => Promise.resolve(json({
      slug: 'superpowers-tdd',
      namespace: { handle: 'axelhu' },
      owner: { handle: 'axelhu', displayName: 'Axel Hu' },
      skill: {
        slug: 'superpowers-tdd',
        displayName: 'Superpowers TDD',
        summary: 'Strict TDD workflow',
        summary_zh: '严格 TDD 工作流',
        category: 'dev-programming',
        stats: { downloads: 2881, installs: 31 },
      },
      latestVersion: { version: '1.0.0' },
      securityReports: {
        keen: { status: 'benign', statusText: '安全', reportUrl: 'https://example.com/report' },
      },
    }))) as typeof fetch;

    const result = await getExpertSkill('axelhu', 'superpowers-tdd');

    assert.strictEqual(result.owner.displayName, 'Axel Hu');
    assert.strictEqual(result.summary, '严格 TDD 工作流');
    assert.strictEqual(result.version, '1.0.0');
    assert.deepStrictEqual(result.stats, { downloads: 2881, installs: 31 });
    assert.deepStrictEqual(result.securityReports, [{
      provider: 'keen',
      status: 'benign',
      statusText: '安全',
      reportUrl: 'https://example.com/report',
    }]);
  });
});
