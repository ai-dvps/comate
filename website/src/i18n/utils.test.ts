import { describe, expect, it } from 'vitest';
import {
  assertBilingualContentParity,
  getContentLocale,
  getLocalizedEntries,
  localizePath,
  stripLocalePrefix,
  useTranslations,
} from './utils.js';
import { ui } from './ui.js';

describe('useTranslations', () => {
  it('returns the Chinese string for the Chinese locale', () => {
    const t = useTranslations('zh');
    expect(t('nav.home')).toBe('首页');
  });

  it('returns the English string for the English locale', () => {
    const t = useTranslations('en');
    expect(t('nav.home')).toBe('Home');
  });

  it('throws instead of falling back to Chinese when a key is missing', () => {
    const t = useTranslations('en');
    expect(() => t('missing.key' as Parameters<typeof t>[0])).toThrow(/missing\.key.*en/i);
  });
});

describe('stripLocalePrefix', () => {
  it('removes the Chinese locale prefix', () => {
    expect(stripLocalePrefix('/zh/features/')).toBe('/features/');
  });

  it('removes the English locale prefix', () => {
    expect(stripLocalePrefix('/en/download/')).toBe('/download/');
  });

  it('leaves locale-free paths unchanged', () => {
    expect(stripLocalePrefix('/features/')).toBe('/features/');
  });
});

describe('localizePath', () => {
  it('builds the Chinese path from an English path', () => {
    expect(localizePath('/en/features/', 'zh')).toBe('/zh/features/');
  });

  it('builds the English path from a Chinese path', () => {
    expect(localizePath('/zh/features/', 'en')).toBe('/en/features/');
  });

  it('builds a localized root path', () => {
    expect(localizePath('/', 'en')).toBe('/en/');
  });
});

describe('getContentLocale', () => {
  it('maps zh locale path to zh-CN content tag', () => {
    expect(getContentLocale('zh')).toBe('zh-CN');
  });

  it('keeps en locale path as en', () => {
    expect(getContentLocale('en')).toBe('en');
  });
});

describe('strict locale parity', () => {
  it('keeps shared UI keys identical between locales', () => {
    expect(Object.keys(ui.en).sort()).toEqual(Object.keys(ui.zh).sort());
  });

  it('rejects a content collection with a missing peer locale', () => {
    expect(() => assertBilingualContentParity([{ id: 'zh-CN/hero' }])).toThrow(
      /hero.*missing en/i
    );
  });

  it('returns no cross-locale fallback entry', () => {
    const entries = [
      { id: 'zh-CN/hero', marker: 'Chinese' },
      { id: 'en/hero', marker: 'English' },
    ];
    expect(getLocalizedEntries(entries, 'en')).toEqual([
      { id: 'en/hero', marker: 'English' },
    ]);
  });
});
