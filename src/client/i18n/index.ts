import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import enCommon from './en/common.json'
import enSettings from './en/settings.json'
import enChat from './en/chat.json'
import enAnalytics from './en/analytics.json'
import enBrowser from './en/browser.json'

import zhCNCommon from './zh-CN/common.json'
import zhCNSettings from './zh-CN/settings.json'
import zhCNChat from './zh-CN/chat.json'
import zhCNAnalytics from './zh-CN/analytics.json'
import zhCNBrowser from './zh-CN/browser.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        chat: enChat,
        analytics: enAnalytics,
        browser: enBrowser,
      },
      'zh-CN': {
        common: zhCNCommon,
        settings: zhCNSettings,
        chat: zhCNChat,
        analytics: zhCNAnalytics,
        browser: zhCNBrowser,
      },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-CN'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['navigator'],
      caches: [],
    },
  })

export default i18n
