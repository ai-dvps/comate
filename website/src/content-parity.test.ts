import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertBilingualContentParity,
  getLocalizedEntries,
} from './i18n/utils.js';
import {
  controlPillars,
  financeScenarioStages,
  platformFacts,
  primaryCtaSlots,
  providerPrerequisite,
  siteLocales,
} from './lib/site-facts.js';

const collections = ['home', 'features', 'usage', 'faq'] as const;

async function contentIds(collection: (typeof collections)[number]): Promise<string[]> {
  const root = new URL(`./content/${collection}/`, import.meta.url);
  const localeFolders = ['zh-CN', 'en'] as const;
  const ids: string[] = [];

  for (const locale of localeFolders) {
    for (const file of await readdir(new URL(`${locale}/`, root))) {
      if (file.endsWith('.mdx')) ids.push(`${locale}/${file.replace(/\.mdx$/, '')}`);
    }
  }

  return ids;
}

async function collectionSource(collection: 'features' | 'usage', locale: 'zh-CN' | 'en') {
  const directory = new URL(`./content/${collection}/${locale}/`, import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.mdx')).sort();
  return Promise.all(files.map((file) => readFile(new URL(file, directory), 'utf8')));
}

describe('bilingual content contracts', () => {
  it.each(collections)('pairs every %s slug between zh-CN and en', async (collection) => {
    const ids = await contentIds(collection);
    expect(ids.length).toBeGreaterThan(0);
    expect(() => assertBilingualContentParity(ids.map((id) => ({ id })))).not.toThrow();
  });

  it('fails with the missing locale and slug when a peer is absent', () => {
    expect(() =>
      assertBilingualContentParity([
        { id: 'zh-CN/paired' },
        { id: 'en/paired' },
        { id: 'zh-CN/missing-in-english' },
      ])
    ).toThrow(/missing-in-english.*en/i);
  });

  it('accepts Astro-normalized lowercase locale IDs', () => {
    expect(() =>
      assertBilingualContentParity([{ id: 'zh-cn/hero' }, { id: 'en/hero' }])
    ).not.toThrow();
  });

  it('reports a missing peer for Astro-normalized lowercase locale IDs', () => {
    expect(() => assertBilingualContentParity([{ id: 'zh-cn/hero' }])).toThrow(
      /hero.*missing en/i
    );
    expect(() => assertBilingualContentParity([{ id: 'en/hero' }])).toThrow(
      /hero.*missing zh-CN/i
    );
  });

  it('rejects a duplicate semantic key within one locale', () => {
    expect(() =>
      assertBilingualContentParity([
        { id: 'zh-CN/hero' },
        { id: 'zh-CN/hero' },
        { id: 'en/hero' },
      ])
    ).toThrow(/duplicate zh-CN\/hero/i);
  });

  it('never resolves Chinese content for an English production page', () => {
    const entries = [
      { id: 'zh-CN/hero', marker: 'Chinese' },
      { id: 'en/hero', marker: 'English' },
    ];
    expect(getLocalizedEntries(entries, 'en')).toEqual([
      { id: 'en/hero', marker: 'English' },
    ]);
  });

  it('keeps critical facts complete in both locales', () => {
    const criticalFacts = [
      ...platformFacts,
      ...controlPillars,
      ...financeScenarioStages,
      ...primaryCtaSlots,
    ];

    for (const item of criticalFacts) {
      for (const locale of siteLocales) expect(item.label[locale]).toBeTruthy();
    }
    for (const locale of siteLocales) {
      expect(providerPrerequisite.disclosure[locale]).toBeTruthy();
    }
  });

  it('keeps the complete finance flow and control proof bilingual', () => {
    expect(financeScenarioStages.map(({ key }) => key)).toEqual([
      'request-through-im',
      'acknowledge-with-task-id',
      'use-approved-intelligence',
      'collect-and-analyze',
      'request-permission-or-attention',
      'publish-finished-report',
      'notify-with-status-and-link',
    ]);
    expect(controlPillars).toHaveLength(5);

    for (const locale of siteLocales) {
      expect(financeScenarioStages.map(({ label }) => label[locale])).toHaveLength(7);
      expect(controlPillars.map(({ label }) => label[locale])).toHaveLength(5);
    }
  });

  it('keeps feature terminology distinct and outcome-oriented in both locales', async () => {
    const [english, chinese] = await Promise.all([
      collectionSource('features', 'en'),
      collectionSource('features', 'zh-CN'),
    ]);
    const sources = [english.join('\n'), chinese.join('\n')];

    for (const source of sources) {
      expect(source).toMatch(/Agent/);
      expect(source).toMatch(/Provider/);
      expect(source).toMatch(/Skills/);
      expect(source).toMatch(/MCP/);
      expect(source).toMatch(/SkillHub/);
      expect(source).toMatch(/browser|浏览器/i);
      expect(source).toMatch(/scheduled|定时任务/i);
    }
    expect(english.join('\n')).toMatch(/Agent backend[\s\S]*Provider/);
    expect(chinese.join('\n')).toMatch(/Agent 后端[\s\S]*Provider/);
  });

  it('keeps Provider prerequisites and recovery branches in paired usage content', async () => {
    const [english, chinese] = await Promise.all([
      collectionSource('usage', 'en'),
      collectionSource('usage', 'zh-CN'),
    ]);
    expect(english).toHaveLength(7);
    expect(chinese).toHaveLength(7);

    const en = english.join('\n');
    const zh = chinese.join('\n');
    expect(en).toMatch(/no Provider is configured/i);
    expect(en).toMatch(/credential or endpoint check fails/i);
    expect(en).toMatch(/needs permission or attention/i);
    expect(en).toMatch(/create a Workspace and draft a Session[\s\S]*execution cannot complete/i);
    expect(zh).toMatch(/还没有 Provider/);
    expect(zh).toMatch(/凭据或服务地址检查失败/);
    expect(zh).toMatch(/需要权限或人工关注/);
    expect(zh).toMatch(/创建工作区和草稿会话[\s\S]*无法执行并完成任务/);
  });
});
