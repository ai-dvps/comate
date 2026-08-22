import { readdir } from 'node:fs/promises';
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
});
