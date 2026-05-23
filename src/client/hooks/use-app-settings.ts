import { useState, useCallback, useEffect } from 'react'
import i18n from '../i18n'

interface AppSettings {
  defaultModel: string
  reopenLastWorkspace: boolean
  language: string
}

const STORAGE_KEY = 'app-settings'

const SUPPORTED_LANGUAGES = ['en', 'zh-CN']

function getInitialSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AppSettings>
      return {
        defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : '',
        reopenLastWorkspace: typeof parsed.reopenLastWorkspace === 'boolean' ? parsed.reopenLastWorkspace : false,
        language: SUPPORTED_LANGUAGES.includes(parsed.language ?? '') ? parsed.language! : 'en',
      }
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return { defaultModel: '', reopenLastWorkspace: false, language: 'en' }
}

function saveSettings(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage not available
  }
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(getInitialSettings)

  // Sync stored language preference to i18next on mount
  useEffect(() => {
    if (settings.language && i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setDefaultModel = useCallback((defaultModel: string) => {
    setSettings((prev) => {
      const next = { ...prev, defaultModel }
      saveSettings(next)
      return next
    })
  }, [])

  const setReopenLastWorkspace = useCallback((reopenLastWorkspace: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, reopenLastWorkspace }
      saveSettings(next)
      return next
    })
  }, [])

  const setLanguage = useCallback((language: string) => {
    setSettings((prev) => {
      const next = { ...prev, language }
      saveSettings(next)
      return next
    })
  }, [])

  return {
    defaultModel: settings.defaultModel,
    reopenLastWorkspace: settings.reopenLastWorkspace,
    language: settings.language,
    setDefaultModel,
    setReopenLastWorkspace,
    setLanguage,
  }
}
