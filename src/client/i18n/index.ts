import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import enCommon from './en/common.json'
import enSettings from './en/settings.json'
import enChat from './en/chat.json'

import zhCNCommon from './zh-CN/common.json'
import zhCNSettings from './zh-CN/settings.json'
import zhCNChat from './zh-CN/chat.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        chat: enChat,
      },
      'zh-CN': {
        common: zhCNCommon,
        settings: zhCNSettings,
        chat: zhCNChat,
      },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-CN'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'app-language',
    },
  })

export default i18n
