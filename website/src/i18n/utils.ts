import { defaultLang, ui, type Lang, type UIKey } from './ui.js';

export { defaultLang, ui, type Lang, type UIKey };

export function useTranslations(lang: Lang) {
  return function t(key: UIKey): string {
    const value = ui[lang][key];
    if (value === undefined) {
      throw new Error(`Missing UI translation key "${String(key)}" for locale "${lang}"`);
    }
    return value;
  };
}

const localeSegmentPattern = /^\/(zh|en)(\/|$)/;

export function stripLocalePrefix(path: string): string {
  return path.replace(localeSegmentPattern, '/');
}

export const contentLocaleMap: Record<Lang, string> = {
  zh: 'zh-CN',
  en: 'en',
};

export function getContentLocale(locale: Lang): string {
  return contentLocaleMap[locale];
}

export function assertBilingualContentParity<T extends { id: string }>(entries: T[]): void {
  const localeTags = Object.values(contentLocaleMap);
  const configuredTagByNormalizedTag = new Map(
    localeTags.map((locale) => [locale.toLowerCase(), locale])
  );
  const localesBySlug = new Map<string, Set<string>>();

  for (const entry of entries) {
    const separatorIndex = entry.id.indexOf('/');
    if (separatorIndex === -1) continue;
    const locale = entry.id.slice(0, separatorIndex).toLowerCase();
    if (!configuredTagByNormalizedTag.has(locale)) continue;
    const slug = entry.id.slice(separatorIndex + 1);
    const locales = localesBySlug.get(slug) ?? new Set<string>();
    if (locales.has(locale)) {
      const configuredLocale = configuredTagByNormalizedTag.get(locale) ?? locale;
      throw new Error(`Bilingual content parity failed: duplicate ${configuredLocale}/${slug}`);
    }
    locales.add(locale);
    localesBySlug.set(slug, locales);
  }

  const missingPeers: string[] = [];
  for (const [slug, locales] of localesBySlug) {
    for (const configuredLocale of localeTags) {
      if (!locales.has(configuredLocale.toLowerCase())) {
        missingPeers.push(`${slug} (missing ${configuredLocale})`);
      }
    }
  }

  if (missingPeers.length > 0) {
    throw new Error(`Bilingual content parity failed: ${missingPeers.sort().join(', ')}`);
  }
}

export function getLocalizedEntries<T extends { id: string }>(
  entries: T[],
  locale: Lang
): T[] {
  assertBilingualContentParity(entries);
  const tag = getContentLocale(locale).toLowerCase();
  return entries.filter((entry) => entry.id.toLowerCase().startsWith(`${tag}/`));
}

export function localizePath(path: string, targetLocale: Lang): string {
  const normalized = stripLocalePrefix(path);
  if (normalized === '/') {
    return `/${targetLocale}/`;
  }
  return `/${targetLocale}${normalized}`;
}
