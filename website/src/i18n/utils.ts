import { defaultLang, ui, type Lang, type UIKey } from './ui.js';

export { defaultLang, ui, type Lang, type UIKey };

export function useTranslations(lang: Lang) {
  return function t(key: UIKey): string {
    return ui[lang][key] ?? ui[defaultLang][key];
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

export function getLocalizedEntries<T extends { id: string }>(
  entries: T[],
  locale: Lang
): T[] {
  const tag = getContentLocale(locale).toLowerCase();
  const defaultTag = getContentLocale(defaultLang).toLowerCase();
  const bySlug = new Map<string, T>();

  const setForTag = (_tag: string, entry: T) => {
    const separatorIndex = entry.id.indexOf('/');
    if (separatorIndex === -1) return;
    const slug = entry.id.slice(separatorIndex + 1);
    bySlug.set(slug, entry);
  };

  entries
    .filter((e) => e.id.startsWith(`${tag}/`))
    .forEach((e) => setForTag(tag, e));

  entries
    .filter((e) => e.id.startsWith(`${defaultTag}/`))
    .forEach((e) => {
      const separatorIndex = e.id.indexOf('/');
      if (separatorIndex === -1) return;
      const slug = e.id.slice(separatorIndex + 1);
      if (!bySlug.has(slug)) {
        bySlug.set(slug, e);
      }
    });

  return Array.from(bySlug.values());
}

export function localizePath(path: string, targetLocale: Lang): string {
  const normalized = stripLocalePrefix(path);
  if (normalized === '/') {
    return `/${targetLocale}/`;
  }
  return `/${targetLocale}${normalized}`;
}
