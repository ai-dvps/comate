import { useCallback, useEffect, useSyncExternalStore } from 'react'
import i18n from '../i18n'
import { clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../lib/font-size'

export type DisplayMode = 'result' | 'linear'
export type ApprovalMode = 'auto' | 'readonly' | 'manual'

interface AppSettings {
  defaultModel: string
  reopenLastWorkspace: boolean
  useModifierToSubmit: boolean
  language: string
  chatFontSize: number
  uiFontSize: number
  archiveThresholdDays: number
  autoCheckUpdates: boolean
  notificationSoundsEnabled: boolean
  notificationSoundsVolume: number
  lastUpdateCheckAt: string | null
  displayMode: DisplayMode
  outputStyle: string | null
  approvalMode: ApprovalMode
}

const STORAGE_KEY = 'app-settings'

const SUPPORTED_LANGUAGES = ['en', 'zh-CN']
const DEFAULT_ARCHIVE_THRESHOLD_DAYS = 14
function storedFontSize(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE) {
    return value
  }
  switch (value) {
    case 'small':
      return 12
    case 'medium':
      return 14
    case 'large':
      return 16
    default:
      return fallback
  }
}

const defaultSettings: AppSettings = {
  defaultModel: '',
  reopenLastWorkspace: false,
  useModifierToSubmit: true,
  language: i18n.language,
  chatFontSize: 12,
  uiFontSize: 14,
  archiveThresholdDays: DEFAULT_ARCHIVE_THRESHOLD_DAYS,
  autoCheckUpdates: true,
  notificationSoundsEnabled: true,
  notificationSoundsVolume: 100,
  lastUpdateCheckAt: null,
  // Result-focused mode is the primary experience for new sessions.
  displayMode: 'result',
  outputStyle: null,
  approvalMode: 'auto',
}

/** Validate/migrate a parsed stored blob into a complete AppSettings object. */
type StoredAppSettings = Omit<Partial<AppSettings>, 'chatFontSize' | 'uiFontSize'> & {
  chatFontSize?: unknown
  uiFontSize?: unknown
}

function fromStored(parsed: StoredAppSettings | null | undefined): AppSettings {
  if (!parsed) return { ...defaultSettings }
  const archiveThresholdDays =
    typeof parsed.archiveThresholdDays === 'number' && parsed.archiveThresholdDays > 0
      ? parsed.archiveThresholdDays
      : DEFAULT_ARCHIVE_THRESHOLD_DAYS
  return {
    defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : '',
    reopenLastWorkspace: typeof parsed.reopenLastWorkspace === 'boolean' ? parsed.reopenLastWorkspace : false,
    useModifierToSubmit: typeof parsed.useModifierToSubmit === 'boolean' ? parsed.useModifierToSubmit : true,
    language: SUPPORTED_LANGUAGES.includes(parsed.language ?? '') ? parsed.language! : i18n.language,
    chatFontSize: storedFontSize(parsed.chatFontSize, defaultSettings.chatFontSize),
    uiFontSize: storedFontSize(parsed.uiFontSize, defaultSettings.uiFontSize),
    archiveThresholdDays,
    autoCheckUpdates: typeof parsed.autoCheckUpdates === 'boolean' ? parsed.autoCheckUpdates : true,
    notificationSoundsEnabled:
      typeof parsed.notificationSoundsEnabled === 'boolean' ? parsed.notificationSoundsEnabled : true,
    notificationSoundsVolume:
      typeof parsed.notificationSoundsVolume === 'number' &&
      parsed.notificationSoundsVolume >= 0 &&
      parsed.notificationSoundsVolume <= 100
        ? parsed.notificationSoundsVolume
        : 100,
    lastUpdateCheckAt:
      typeof parsed.lastUpdateCheckAt === 'string' && parsed.lastUpdateCheckAt ? parsed.lastUpdateCheckAt : null,
    displayMode: parsed.displayMode === 'linear' ? 'linear' : 'result',
    outputStyle: typeof parsed.outputStyle === 'string' && parsed.outputStyle.trim() ? parsed.outputStyle : null,
    approvalMode:
      parsed.approvalMode === 'readonly' || parsed.approvalMode === 'manual'
        ? parsed.approvalMode
        : 'auto',
  }
}

export function getInitialSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return fromStored(JSON.parse(stored))
  } catch {
    // localStorage not available or corrupt data
  }
  return { ...defaultSettings }
}

function saveSettings(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage not available
  }
}

/* ------------------------------------------------------------------ */
/*  Shared reactive store                                              */
/* ------------------------------------------------------------------ */
//
// Previously each component calling `useAppSettings()` held its own useState
// copy, so a change written by one (e.g. the display-mode toggle) was invisible
// to others until a full reload. The settings now live in a module-level
// singleton with a subscribe/notify pair consumed via useSyncExternalStore, so
// every caller observes the same state and re-renders on change (R4).
let currentSettings: AppSettings = getInitialSettings()
const listeners = new Set<() => void>()

function emitChange() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): AppSettings {
  return currentSettings
}

function commitSettings(next: AppSettings) {
  currentSettings = next
  saveSettings(next)
  emitChange()
}

// Keep multiple open windows/tabs in sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        currentSettings = fromStored(JSON.parse(e.newValue))
        emitChange()
      } catch {
        // ignore malformed cross-tab payload
      }
    }
  })
}

/** Re-read settings from storage and notify subscribers (reset, e.g. for tests). */
export function resetAppSettings() {
  currentSettings = getInitialSettings()
  emitChange()
}

export function useAppSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Sync stored language preference to i18next on mount
  useEffect(() => {
    if (settings.language && i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setDefaultModel = useCallback((defaultModel: string) => {
    commitSettings({ ...currentSettings, defaultModel })
  }, [])

  const setReopenLastWorkspace = useCallback((reopenLastWorkspace: boolean) => {
    commitSettings({ ...currentSettings, reopenLastWorkspace })
  }, [])

  const setLanguage = useCallback((language: string) => {
    commitSettings({ ...currentSettings, language })
  }, [])

  const setChatFontSize = useCallback((chatFontSize: number) => {
    commitSettings({ ...currentSettings, chatFontSize: clampFontSize(chatFontSize) })
  }, [])

  const setUiFontSize = useCallback((uiFontSize: number) => {
    commitSettings({ ...currentSettings, uiFontSize: clampFontSize(uiFontSize) })
  }, [])

  const setUseModifierToSubmit = useCallback((useModifierToSubmit: boolean) => {
    commitSettings({ ...currentSettings, useModifierToSubmit })
  }, [])

  const setArchiveThresholdDays = useCallback((archiveThresholdDays: number) => {
    commitSettings({ ...currentSettings, archiveThresholdDays })
  }, [])

  const setAutoCheckUpdates = useCallback((autoCheckUpdates: boolean) => {
    commitSettings({ ...currentSettings, autoCheckUpdates })
  }, [])

  const setNotificationSoundsEnabled = useCallback((notificationSoundsEnabled: boolean) => {
    commitSettings({ ...currentSettings, notificationSoundsEnabled })
  }, [])

  const setNotificationSoundsVolume = useCallback((notificationSoundsVolume: number) => {
    const clamped = Math.min(100, Math.max(0, notificationSoundsVolume))
    commitSettings({ ...currentSettings, notificationSoundsVolume: clamped })
  }, [])

  const setLastUpdateCheckAt = useCallback((lastUpdateCheckAt: string | null) => {
    commitSettings({ ...currentSettings, lastUpdateCheckAt })
  }, [])

  const setDisplayMode = useCallback((displayMode: DisplayMode) => {
    commitSettings({ ...currentSettings, displayMode })
  }, [])

  const setOutputStyle = useCallback((outputStyle: string | null) => {
    commitSettings({ ...currentSettings, outputStyle })
  }, [])

  const setApprovalMode = useCallback((approvalMode: ApprovalMode) => {
    commitSettings({ ...currentSettings, approvalMode })
  }, [])

  return {
    defaultModel: settings.defaultModel,
    reopenLastWorkspace: settings.reopenLastWorkspace,
    useModifierToSubmit: settings.useModifierToSubmit,
    language: settings.language,
    chatFontSize: settings.chatFontSize,
    uiFontSize: settings.uiFontSize,
    archiveThresholdDays: settings.archiveThresholdDays,
    autoCheckUpdates: settings.autoCheckUpdates,
    notificationSoundsEnabled: settings.notificationSoundsEnabled,
    notificationSoundsVolume: settings.notificationSoundsVolume,
    lastUpdateCheckAt: settings.lastUpdateCheckAt,
    displayMode: settings.displayMode,
    outputStyle: settings.outputStyle,
    approvalMode: settings.approvalMode,
    setDefaultModel,
    setReopenLastWorkspace,
    setUseModifierToSubmit,
    setLanguage,
    setChatFontSize,
    setUiFontSize,
    setArchiveThresholdDays,
    setAutoCheckUpdates,
    setNotificationSoundsEnabled,
    setNotificationSoundsVolume,
    setLastUpdateCheckAt,
    setDisplayMode,
    setOutputStyle,
    setApprovalMode,
  }
}
