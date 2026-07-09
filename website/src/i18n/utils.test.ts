import { describe, expect, it } from 'vitest';
import { localizePath, stripLocalePrefix, useTranslations } from './utils.js';

describe('useTranslations', () => {
  it('returns the Chinese string for the Chinese locale', () => {
    const t = useTranslations('zh');
    expect(t('nav.home')).toBe('首页');
  });

  it('returns the English string for the English locale', () => {
    const t = useTranslations('en');
    expect(t('nav.home')).toBe('Home');
  });

  it('falls back to Chinese when a key is missing', () => {
    const t = useTranslations('en');
    // Cast an unknown key to keep TypeScript happy while testing fallback behavior.
    expect(t('404.backHome' as Parameters<typeof t>[0])).toBe('Back to home');
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
