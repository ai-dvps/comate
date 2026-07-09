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

export function localizePath(path: string, targetLocale: Lang): string {
  const normalized = stripLocalePrefix(path);
  if (normalized === '/') {
    return `/${targetLocale}/`;
  }
  return `/${targetLocale}${normalized}`;
}

