import '../../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getEnterprise,
  getEnterpriseSkill,
  listEnterprises,
  listEnterpriseIndustries,
  listEnterpriseSkills,
  SkillHubProviderError,
} from './index.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function enterprise(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org-acme',
    name: 'Acme Open Source',
    enterpriseFullName: 'Acme Incorporated',
    enterpriseShortName: 'Acme',
    description: 'Enterprise description',
    industryTags: ['internet_tech'],
    logoUrl: 'https://cdn.example.com/acme.png',
    publishedSkillCount: 23,
    totalDownloads: 1200,
    ...overrides,
  };
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    namespace: { handle: 'acme' },
    slug: 'deploy-helper',
    displayName: 'Deploy Helper',
    description: 'Deploy safely',
    descriptionZh: '安全部署',
    downloads: 120,
    stars: 9,
    createdAt: 1_700_000_000_000,
    iconUrl: 'https://cdn.example.com/skill.png',
    ...overrides,
  };
}

describe('Enterprise Zone provider', () => {
  it('keeps industries dynamic and preserves upstream order', async () => {
    global.fetch = async () => Response.json({ items: [
      { tagKey: 'new_sector_2026', displayNameZh: '新行业', displayNameEn: 'New Sector', sortOrder: 7 },
      { tagKey: 'finance', displayNameZh: '金融', displayNameEn: 'Finance', sortOrder: 2 },
    ] });

    assert.deepStrictEqual(await listEnterpriseIndustries(), [
      { key: 'new_sector_2026', displayName: '新行业', displayNameEn: 'New Sector', sortOrder: 7 },
      { key: 'finance', displayName: '金融', displayNameEn: 'Finance', sortOrder: 2 },
    ]);
  });

  it('forwards combined enterprise filters with a fixed page size', async () => {
    let requested = '';
    global.fetch = async (input) => {
      requested = String(input);
      return Response.json({ items: [enterprise()], page: 2, pageSize: 20, total: 23 });
    };

    const result = await listEnterprises({ keyword: ' cloud ', industry: 'new_sector_2026', page: 2 });
    const url = new URL(requested);
    assert.strictEqual(url.searchParams.get('keyword'), 'cloud');
    assert.strictEqual(url.searchParams.get('industry'), 'new_sector_2026');
    assert.strictEqual(url.searchParams.get('sort'), 'downloads');
    assert.strictEqual(url.searchParams.get('page'), '2');
    assert.strictEqual(url.searchParams.get('pageSize'), '20');
    assert.deepStrictEqual(result, {
      enterprises: [{
        orgId: 'org-acme', name: 'Acme Open Source', fullName: 'Acme Incorporated', shortName: 'Acme',
        description: 'Enterprise description', industryTags: ['internet_tech'],
        logoUrl: 'https://cdn.example.com/acme.png', publishedSkillCount: 23, totalDownloads: 1200,
      }],
      page: 2, pageSize: 20, total: 23,
    });
  });

  it('normalizes an enterprise detail', async () => {
    global.fetch = async () => Response.json(enterprise({ totalStars: 44 }));
    const result = await getEnterprise('org-acme');
    assert.strictEqual(result.orgId, 'org-acme');
    assert.strictEqual(result.totalStars, 44);
  });

  it('forwards all supported Skill sorts and canonicalizes coordinates', async () => {
    for (const sort of ['downloads', 'stars', 'latest'] as const) {
      let requested = '';
      global.fetch = async (input) => {
        requested = String(input);
        return Response.json({ items: [skill()], page: 1, pageSize: 20, total: 1 });
      };
      await listEnterpriseSkills('org-acme', { keyword: ' deploy ', sort, page: 1 });
      const url = new URL(requested);
      assert.strictEqual(url.searchParams.get('sort'), sort);
      assert.strictEqual(url.searchParams.get('keyword'), 'deploy');
      assert.strictEqual(url.searchParams.get('pageSize'), '20');
    }
  });

  it('validates canonical coordinate and publisher membership on detail', async () => {
    global.fetch = async () => Response.json({
      slug: 'deploy-helper',
      namespace: { handle: 'acme' },
      owner: { handle: 'acme', displayName: 'Acme' },
      publisher: { orgId: 'org-acme' },
      latestVersion: { version: '1.0.0' },
      skill: { slug: 'deploy-helper', displayName: 'Deploy Helper', summary: 'Summary', category: 'tech', stats: {} },
      securityReports: {},
    });
    assert.strictEqual((await getEnterpriseSkill('org-acme', 'acme', 'deploy-helper')).publisher?.orgId, 'org-acme');

    global.fetch = async () => Response.json({
      slug: 'deploy-helper', namespace: { handle: 'acme' }, publisher: { orgId: 'org-other' },
      skill: { slug: 'deploy-helper', stats: {} }, securityReports: {},
    });
    await assert.rejects(
      () => getEnterpriseSkill('org-acme', 'acme', 'deploy-helper'),
      (error: unknown) => error instanceof SkillHubProviderError && error.code === 'not-found',
    );
  });

  it('rejects malformed inputs before fetch', async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; return Response.json({}); };
    await assert.rejects(() => listEnterprises({ industry: 'bad/value' }), /Invalid industry/);
    await assert.rejects(() => listEnterpriseSkills('org-acme', { sort: 'popular' as 'downloads' }), /Invalid Enterprise Skill sort/);
    await assert.rejects(() => getEnterprise('../bad'), /Invalid enterprise organization/);
    assert.strictEqual(calls, 0);
  });

  it('rejects overfull pages, duplicate identities, and inconsistent metadata', async () => {
    global.fetch = async () => Response.json({
      items: Array.from({ length: 21 }, (_, index) => enterprise({ orgId: `org-${index}` })),
      page: 1, pageSize: 20, total: 21,
    });
    await assert.rejects(() => listEnterprises(), /malformed/);

    global.fetch = async () => Response.json({ items: [enterprise(), enterprise()], page: 1, pageSize: 20, total: 2 });
    await assert.rejects(() => listEnterprises(), /malformed/);

    global.fetch = async () => Response.json({ items: [skill(), skill()], page: 1, pageSize: 20, total: 2 });
    await assert.rejects(() => listEnterpriseSkills('org-acme'), /malformed/);

    global.fetch = async () => Response.json({ items: [], page: 2, pageSize: 20, total: 0 });
    await assert.rejects(() => listEnterprises({ page: 2 }), /malformed/);
  });
});
