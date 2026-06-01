import { useState, useCallback, useEffect } from 'react'
import i18n from '../i18n'

type FontSizePreset = 'small' | 'medium' | 'large'

interface AppSettings {
  defaultModel: string
  reopenLastWorkspace: boolean
  useModifierToSubmit: boolean
  language: string
  chatFontSize: FontSizePreset
  uiFontSize: FontSizePreset
}

const STORAGE_KEY = 'app-settings'

const SUPPORTED_LANGUAGES = ['en', 'zh-CN']
const FONT_SIZE_PRESETS: FontSizePreset[] = ['small', 'medium', 'large']

function isValidFontSize(value: unknown): value is FontSizePreset {
  return typeof value === 'string' && FONT_SIZE_PRESETS.includes(value as FontSizePreset)
}

function getInitialSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AppSettings>
      return {
        defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : '',
        reopenLastWorkspace: typeof parsed.reopenLastWorkspace === 'boolean' ? parsed.reopenLastWorkspace : false,
        useModifierToSubmit: typeof parsed.useModifierToSubmit === 'boolean' ? parsed.useModifierToSubmit : true,
        language: SUPPORTED_LANGUAGES.includes(parsed.language ?? '') ? parsed.language! : i18n.language,
        chatFontSize: isValidFontSize(parsed.chatFontSize) ? parsed.chatFontSize : 'small',
        uiFontSize: isValidFontSize(parsed.uiFontSize) ? parsed.uiFontSize : 'medium',
      }
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return { defaultModel: '', reopenLastWorkspace: false, useModifierToSubmit: true, language: i18n.language, chatFontSize: 'small', uiFontSize: 'medium' }
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

  const setChatFontSize = useCallback((chatFontSize: FontSizePreset) => {
    setSettings((prev) => {
      const next = { ...prev, chatFontSize }
      saveSettings(next)
      return next
    })
  }, [])

  const setUiFontSize = useCallback((uiFontSize: FontSizePreset) => {
    setSettings((prev) => {
      const next = { ...prev, uiFontSize }
      saveSettings(next)
      return next
    })
  }, [])

  const setUseModifierToSubmit = useCallback((useModifierToSubmit: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, useModifierToSubmit }
      saveSettings(next)
      return next
    })
  }, [])

  return {
    defaultModel: settings.defaultModel,
    reopenLastWorkspace: settings.reopenLastWorkspace,
    useModifierToSubmit: settings.useModifierToSubmit,
    language: settings.language,
    chatFontSize: settings.chatFontSize,
    uiFontSize: settings.uiFontSize,
    setDefaultModel,
    setReopenLastWorkspace,
    setUseModifierToSubmit,
    setLanguage,
    setChatFontSize,
    setUiFontSize,
  }
}
