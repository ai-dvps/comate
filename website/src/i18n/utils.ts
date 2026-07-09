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

export function localizePath(path: string, targetLocale: Lang): string {
  const normalized = stripLocalePrefix(path);
  if (normalized === '/') {
    return `/${targetLocale}/`;
  }
  return `/${targetLocale}${normalized}`;
}
