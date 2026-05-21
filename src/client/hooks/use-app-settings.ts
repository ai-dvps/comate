import { useState, useCallback } from 'react'

interface AppSettings {
  defaultModel: string
  reopenLastWorkspace: boolean
}

const STORAGE_KEY = 'app-settings'

function getInitialSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AppSettings>
      return {
        defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : '',
        reopenLastWorkspace: typeof parsed.reopenLastWorkspace === 'boolean' ? parsed.reopenLastWorkspace : false,
      }
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return { defaultModel: '', reopenLastWorkspace: false }
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

  return {
    defaultModel: settings.defaultModel,
    reopenLastWorkspace: settings.reopenLastWorkspace,
    setDefaultModel,
    setReopenLastWorkspace,
  }
}
