import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTheme } from '../hooks/use-theme'
import { useAppSettings } from '../hooks/use-app-settings'
import i18n from '../i18n'
import type { Workspace } from '../stores/workspace-store'
import {
  X,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Save,
  Sun,
  Moon,
  Monitor,
  AlertTriangle,
} from 'lucide-react'

interface SettingsPanelProps {
  onClose: () => void
}

type SettingsTab = 'general' | 'appearance' | 'workspace' | 'skills' | 'mcp' | 'hooks'

interface WorkspaceFormState {
  name: string
  description: string
  folderPath: string
  model: string
  apiKey: string
  skills: { name: string }[]
  mcpServers: { name: string; command: string; args: string }[]
  hooks: { name: string; scriptPath: string }[]
  wecomBotId: string
  wecomBotSecret: string
  wecomBotEnabled: boolean
  wecomBotName: string
  wecomCorpId: string
  wecomCorpSecret: string
}

function buildWorkspaceFormState(workspace: Workspace): WorkspaceFormState {
  return {
    name: workspace.name,
    description: workspace.description,
    folderPath: workspace.folderPath,
    model: (workspace.settings?.model as string) || '',
    apiKey: (workspace.settings?.apiKey as string) || '',
    skills: [...workspace.skills],
    mcpServers: workspace.mcpServers.map((m) => ({
      ...m,
      args: m.args?.join(' ') || '',
    })),
    hooks: [...workspace.hooks],
    wecomBotId: (workspace.settings?.wecomBotId as string) || '',
    wecomBotSecret: (workspace.settings?.wecomBotSecret as string) || '',
    wecomBotEnabled: (workspace.settings?.wecomBotEnabled as boolean) || false,
    wecomBotName: (workspace.settings?.wecomBotName as string) || '',
    wecomCorpId: (workspace.settings?.wecomCorpId as string) || '',
    wecomCorpSecret: (workspace.settings?.wecomCorpSecret as string) || '',
  }
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation('settings')
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)

  const { defaultModel, setDefaultModel, reopenLastWorkspace, setReopenLastWorkspace } = useAppSettings()
  const windowCap = useChatStore((s) => s.windowCap)
  const setWindowCap = useChatStore((s) => s.setWindowCap)

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const [pendingClose, setPendingClose] = useState(false)

  // App-level form state
  const [appModel, setAppModel] = useState(defaultModel)
  const [appReopen, setAppReopen] = useState(reopenLastWorkspace)
  const [windowCapInput, setWindowCapInput] = useState(String(windowCap))

  // Workspace form state (keyed by workspace id)
  const [workspaceState, setWorkspaceState] = useState<Record<string, WorkspaceFormState>>({})

  // Snapshot for dirty tracking
  const snapshotRef = useRef({
    appModel: defaultModel,
    appReopen: reopenLastWorkspace,
    appWindowCap: windowCap,
    workspaceState: {} as Record<string, WorkspaceFormState>,
  })

  const hasInitialized = useRef(false)

  // Initialize once on mount
  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    const initial: Record<string, WorkspaceFormState> = {}
    workspaces.forEach((w) => {
      initial[w.id] = buildWorkspaceFormState(w)
    })
    setWorkspaceState(initial)
    snapshotRef.current = {
      appModel: defaultModel,
      appReopen: reopenLastWorkspace,
      appWindowCap: windowCap,
      workspaceState: JSON.parse(JSON.stringify(initial)),
    }
    setAppModel(defaultModel)
    setAppReopen(reopenLastWorkspace)
    setWindowCapInput(String(windowCap))

    if (workspaces.length > 0) {
      setSelectedWorkspaceId(activeWorkspaceId || workspaces[0].id)
    }
  }, [workspaces, defaultModel, reopenLastWorkspace, activeWorkspaceId, windowCap])

  useEffect(() => {
    setWindowCapInput(String(windowCap))
  }, [windowCap])

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId)

  const isDirty = useCallback(() => {
    if (appModel !== snapshotRef.current.appModel) return true
    if (appReopen !== snapshotRef.current.appReopen) return true
    if (windowCap !== snapshotRef.current.appWindowCap) return true
    return JSON.stringify(workspaceState) !== JSON.stringify(snapshotRef.current.workspaceState)
  }, [appModel, appReopen, windowCap, workspaceState])

  const handleClose = useCallback(() => {
    if (isDirty()) {
      setShowUnsavedDialog(true)
      setPendingClose(true)
    } else {
      onClose()
    }
  }, [isDirty, onClose])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showUnsavedDialog) {
          setShowUnsavedDialog(false)
          setPendingClose(false)
        } else {
          handleClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleClose, showUnsavedDialog])

  const handleSave = async () => {
    setIsSaving(true)

    // Save app settings
    setDefaultModel(appModel)
    setReopenLastWorkspace(appReopen)
    const parsedCap = parseInt(windowCapInput, 10)
    if (!isNaN(parsedCap)) {
      setWindowCap(parsedCap)
    }

    // Save workspace settings for selected workspace
    if (selectedWorkspaceId && workspaceState[selectedWorkspaceId]) {
      const ws = workspaceState[selectedWorkspaceId]
      await updateWorkspace(selectedWorkspaceId, {
        name: ws.name,
        description: ws.description,
        settings: {
          ...selectedWorkspace?.settings,
          model: ws.model || undefined,
          apiKey: ws.apiKey || undefined,
          wecomBotId: ws.wecomBotId || undefined,
          wecomBotSecret: ws.wecomBotSecret || undefined,
          wecomBotEnabled: ws.wecomBotEnabled,
          wecomBotName: ws.wecomBotName || undefined,
          wecomCorpId: ws.wecomCorpId || undefined,
          wecomCorpSecret: ws.wecomCorpSecret || undefined,
        },
        skills: ws.skills,
        mcpServers: ws.mcpServers.map((m) => ({
          name: m.name,
          command: m.command,
          args: m.args ? m.args.split(' ').filter(Boolean) : undefined,
        })),
        hooks: ws.hooks,
      })
    }

    // Update snapshot
    snapshotRef.current = {
      appModel,
      appReopen,
      appWindowCap: windowCap,
      workspaceState: JSON.parse(JSON.stringify(workspaceState)),
    }

    setIsSaving(false)

    if (pendingClose) {
      setPendingClose(false)
      setShowUnsavedDialog(false)
      onClose()
    }
  }

  const handleCancel = () => {
    // Reset to snapshot
    setAppModel(snapshotRef.current.appModel)
    setAppReopen(snapshotRef.current.appReopen)
    setWindowCapInput(String(snapshotRef.current.appWindowCap))
    setWorkspaceState(JSON.parse(JSON.stringify(snapshotRef.current.workspaceState)))
    onClose()
  }

  const handleDiscard = () => {
    setAppModel(snapshotRef.current.appModel)
    setAppReopen(snapshotRef.current.appReopen)
    setWindowCapInput(String(snapshotRef.current.appWindowCap))
    setWorkspaceState(JSON.parse(JSON.stringify(snapshotRef.current.workspaceState)))
    setShowUnsavedDialog(false)
    setPendingClose(false)
    onClose()
  }

  const updateSelectedWorkspace = (updates: Partial<WorkspaceFormState>) => {
    if (!selectedWorkspaceId) return
    setWorkspaceState((prev) => ({
      ...prev,
      [selectedWorkspaceId]: { ...prev[selectedWorkspaceId], ...updates },
    }))
  }

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: t('tabs.general') },
    { id: 'appearance', label: t('tabs.appearance') },
    { id: 'workspace', label: t('tabs.workspace') },
    { id: 'skills', label: t('tabs.skills') },
    { id: 'mcp', label: t('tabs.mcp') },
    { id: 'hooks', label: t('tabs.hooks') },
  ]

  const isWorkspaceTab = activeTab === 'workspace' || activeTab === 'skills' || activeTab === 'mcp' || activeTab === 'hooks'

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      {/* Title bar safe zone */}
      <div className="h-11 pointer-events-none" />

      {/* Modal area */}
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 relative">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={handleClose} />

        {/* Card */}
        <div className="relative w-full h-full max-h-[90vh] max-w-[90vw] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 h-14 flex-shrink-0 border-b border-border/50">
            <h2 className="text-sm font-medium text-text-primary">{t('settings')}</h2>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border/50 flex-shrink-0 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-3 px-4 text-[11px] font-medium transition-all ${
                  activeTab === tab.id
                    ? 'text-text-primary border-b-2 border-accent'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {activeTab === 'general' && (
              <GeneralTab
                defaultModel={appModel}
                onDefaultModelChange={setAppModel}
                reopenLastWorkspace={appReopen}
                onReopenLastWorkspaceChange={setAppReopen}
                windowCap={windowCapInput}
                onWindowCapChange={setWindowCapInput}
                onWindowCapCommit={(val) => {
                  const parsed = parseInt(val, 10)
                  if (!isNaN(parsed)) {
                    setWindowCap(parsed)
                  }
                }}
              />
            )}

            {activeTab === 'appearance' && <AppearanceTab />}

            {isWorkspaceTab && (
              <WorkspaceTabShell
                workspaces={workspaces}
                selectedWorkspaceId={selectedWorkspaceId}
                onSelectWorkspace={setSelectedWorkspaceId}
                activeTab={activeTab}
                workspaceState={selectedWorkspaceId ? workspaceState[selectedWorkspaceId] : null}
                onUpdateWorkspace={updateSelectedWorkspace}
              />
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-border/50 flex-shrink-0">
            <div className="text-[11px] text-text-tertiary">
              {isDirty() && t('unsavedDialog.message')}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                {t('actions.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !isDirty()}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? t('unsavedDialog.saving') : t('actions.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Unsaved Changes Dialog */}
      {showUnsavedDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" />
          <div className="relative bg-surface border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-medium text-text-primary">{t('unsavedDialog.title')}</h3>
                <p className="text-xs text-text-secondary mt-1">
                  {t('unsavedDialog.message')}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => {
                  setShowUnsavedDialog(false)
                  setPendingClose(false)
                }}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                {t('unsavedDialog.keepEditing')}
              </button>
              <button
                onClick={handleDiscard}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                {t('unsavedDialog.discard')}
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? t('unsavedDialog.saving') : t('actions.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- App-level tabs ---

function GeneralTab({
  defaultModel,
  onDefaultModelChange,
  reopenLastWorkspace,
  onReopenLastWorkspaceChange,
  windowCap,
  onWindowCapChange,
  onWindowCapCommit,
}: {
  defaultModel: string
  onDefaultModelChange: (v: string) => void
  reopenLastWorkspace: boolean
  onReopenLastWorkspaceChange: (v: boolean) => void
  windowCap: string
  onWindowCapChange: (v: string) => void
  onWindowCapCommit: (v: string) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className="p-6 max-w-xl">
      <div className="space-y-5">
        <WeComCliSection />
        <PathConfigSection />
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            {t('general.defaultModel')}
          </label>
          <input
            value={defaultModel}
            onChange={(e) => onDefaultModelChange(e.target.value)}
            placeholder={t('general.defaultModelPlaceholder')}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <p className="text-[10px] text-text-tertiary mt-1">
            {t('general.defaultModelHint')}
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            {t('general.messageWindowCap')}
          </label>
          <input
            type="number"
            min={50}
            max={1000}
            value={windowCap}
            onChange={(e) => onWindowCapChange(e.target.value)}
            onBlur={() => onWindowCapCommit(windowCap)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onWindowCapCommit(windowCap)
              }
            }}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <p className="text-[10px] text-text-tertiary mt-1">
            {t('general.messageWindowCapHint')}
          </p>
        </div>

        <div className="flex items-center justify-between py-3 border-t border-border/50">
          <div>
            <label className="block text-xs font-medium text-text-secondary">
              {t('general.reopenLastWorkspace')}
            </label>
            <p className="text-[10px] text-text-tertiary mt-0.5">
              {t('general.reopenLastWorkspaceHint')}
            </p>
          </div>
          <button
            onClick={() => onReopenLastWorkspaceChange(!reopenLastWorkspace)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              reopenLastWorkspace ? 'bg-accent' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                reopenLastWorkspace ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  )
}

function AppearanceTab() {
  const { theme, isFollowingSystem, setTheme, resetToSystem } = useTheme()
  const { language, setLanguage, chatFontSize, setChatFontSize, uiFontSize, setUiFontSize } = useAppSettings()
  const { t } = useTranslation('settings')

  const handleLanguageChange = (lang: string) => {
    setLanguage(lang)
    i18n.changeLanguage(lang)
  }

  const fontSizePresets: { value: 'small' | 'medium' | 'large'; label: string }[] = [
    { value: 'small', label: t('appearance.fontSizeSmall') },
    { value: 'medium', label: t('appearance.fontSizeMedium') },
    { value: 'large', label: t('appearance.fontSizeLarge') },
  ]

  return (
    <div className="p-6 max-w-xl">
      <div className="space-y-5">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">{t('appearance.theme')}</label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme('light')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                theme === 'light' && !isFollowingSystem
                  ? 'bg-accent text-accent-foreground border-accent'
                  : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
              {t('appearance.light')}
            </button>
            <button
              onClick={() => setTheme('dark')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                theme === 'dark' && !isFollowingSystem
                  ? 'bg-accent text-accent-foreground border-accent'
                  : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              <Moon className="w-3.5 h-3.5" />
              {t('appearance.dark')}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Monitor className="w-3 h-3 text-text-tertiary" />
            <span className="text-[11px] text-text-tertiary">
              {isFollowingSystem ? t('appearance.followingSystem') : t('appearance.manualSelection')}
            </span>
            {!isFollowingSystem && (
              <button
                onClick={resetToSystem}
                className="text-[11px] text-accent hover:text-accent-hover underline underline-offset-2"
              >
                {t('appearance.resetToSystem')}
              </button>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">{t('appearance.language')}</label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleLanguageChange('en')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                language === 'en'
                  ? 'bg-accent text-accent-foreground border-accent'
                  : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              English
            </button>
            <button
              onClick={() => handleLanguageChange('zh-CN')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                language === 'zh-CN'
                  ? 'bg-accent text-accent-foreground border-accent'
                  : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              简体中文
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">{t('appearance.chatFontSize')}</label>
          <div className="flex items-center gap-2">
            {fontSizePresets.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setChatFontSize(preset.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  chatFontSize === preset.value
                    ? 'bg-accent text-accent-foreground border-accent'
                    : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">{t('appearance.uiFontSize')}</label>
          <div className="flex items-center gap-2">
            {fontSizePresets.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setUiFontSize(preset.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  uiFontSize === preset.value
                    ? 'bg-accent text-accent-foreground border-accent'
                    : 'bg-bg text-text-secondary border-border hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function PathConfigSection() {
  const { t } = useTranslation('settings')
  const [state, setState] = useState<{
    resolvedPath: string
    customPaths: string[]
    sources: { shell: string[] | null; fallback: string[] | null }
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [inputError, setInputError] = useState('')

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/system/path')
      if (!res.ok) return
      const data = await res.json()
      setState(data)
    } catch {
      setState({ resolvedPath: '', customPaths: [], sources: { shell: null, fallback: null } })
    }
  }, [])

  useEffect(() => {
    fetchState()
  }, [fetchState])

  const isAbsolutePath = (p: string): boolean => {
    if (!p.trim()) return false
    // Windows absolute: C:\... or \\...; Unix absolute: starts with /
    return /^([a-zA-Z]:\\|\\\\|\/)./.test(p.trim())
  }

  const handleAdd = async () => {
    const trimmed = inputValue.trim()
    if (!trimmed) return
    if (!isAbsolutePath(trimmed)) {
      setInputError(t('general.pathConfigInvalidPath'))
      return
    }
    setInputError('')
    setLoading(true)
    try {
      const newPaths = [...(state?.customPaths ?? []), trimmed]
      const res = await fetch('/api/system/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customPaths: newPaths }),
      })
      if (res.ok) {
        const data = await res.json()
        setState(data)
        setInputValue('')
      }
    } catch {
      // ignore
    }
    setLoading(false)
  }

  const handleRemove = async (index: number) => {
    if (!state) return
    setLoading(true)
    try {
      const newPaths = state.customPaths.filter((_, i) => i !== index)
      const res = await fetch('/api/system/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customPaths: newPaths }),
      })
      if (res.ok) {
        const data = await res.json()
        setState(data)
      }
    } catch {
      // ignore
    }
    setLoading(false)
  }

  return (
    <div className="py-3 border-b border-border/50 space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary">{t('general.pathConfigTitle')}</label>
        <p className="text-[10px] text-text-tertiary mt-0.5">{t('general.pathConfigHint')}</p>
      </div>

      {!state ? (
        <p className="text-xs text-text-tertiary">{t('general.pathConfigLoading')}</p>
      ) : (
        <>
          {/* Resolved PATH display */}
          <div>
            <label className="block text-[10px] font-medium text-text-tertiary mb-1">
              {t('general.pathConfigResolvedPath')}
            </label>
            <div className="bg-bg border border-border rounded-lg p-2 overflow-x-auto">
              <pre className="text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all">
                {state.resolvedPath || '(empty)'}
              </pre>
            </div>
            {/* Source breakdown */}
            <div className="flex flex-wrap gap-2 mt-1.5">
              {state.sources.shell && state.sources.shell.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                  {t('general.pathConfigSourceShell')}: {state.sources.shell.length} dirs
                </span>
              )}
              {state.sources.fallback && state.sources.fallback.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                  {t('general.pathConfigSourceFallback')}: {state.sources.fallback.length} dirs
                </span>
              )}
            </div>
          </div>

          {/* Custom paths */}
          <div>
            <label className="block text-[10px] font-medium text-text-tertiary mb-1">
              {t('general.pathConfigCustomPaths')}
            </label>
            <div className="flex gap-2">
              <input
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value)
                  setInputError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd()
                }}
                placeholder={t('general.pathConfigPathPlaceholder')}
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                onClick={handleAdd}
                disabled={loading}
                className="p-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground transition-colors disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {inputError && <p className="text-[11px] text-destructive mt-1">{inputError}</p>}

            <div className="space-y-1 mt-2">
              {state.customPaths.map((p, i) => (
                <div
                  key={`${p}-${i}`}
                  className="flex items-center justify-between px-3 py-2 bg-bg rounded-lg border border-border/50"
                >
                  <code className="text-[11px] font-mono text-text-secondary truncate">{p}</code>
                  <button
                    onClick={() => handleRemove(i)}
                    disabled={loading}
                    className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {state.customPaths.length === 0 && (
                <p className="text-xs text-text-tertiary text-center py-2">
                  {t('general.pathConfigNoCustomPaths')}
                </p>
              )}
            </div>
          </div>

          <p className="text-[10px] text-text-tertiary">{t('general.pathConfigRefreshHint')}</p>
        </>
      )}
    </div>
  )
}

function WeComCliSection() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<{ installed: boolean; path?: string; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/cli/status')
      if (!res.ok) return
      const data = await res.json()
      setStatus(data)
    } catch {
      setStatus({ installed: false, error: t('wecomCli.checkError') })
    }
  }, [t])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleInstall = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/cli/install', { method: 'POST' })
      const data = await res.json()
      setStatus(data)
    } catch {
      setStatus({ installed: false, error: t('wecomCli.installError') })
    }
    setLoading(false)
  }

  const handleUninstall = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/cli/uninstall', { method: 'POST' })
      const data = await res.json()
      setStatus(data)
    } catch {
      setStatus({ installed: false, error: t('wecomCli.uninstallError') })
    }
    setLoading(false)
  }

  const isInstalled = status?.installed

  return (
    <div className="py-3 border-b border-border/50">
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-xs font-medium text-text-secondary">{t('wecomCli.title')}</label>
          <p className="text-[10px] text-text-tertiary mt-0.5">
            {t('wecomCli.hint')}
          </p>
        </div>
        {isInstalled ? (
          <button
            onClick={handleUninstall}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {loading ? t('wecomCli.uninstalling') : t('wecomCli.uninstall')}
          </button>
        ) : (
          <button
            onClick={handleInstall}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground transition-colors disabled:opacity-50"
          >
            {loading ? t('wecomCli.installing') : t('wecomCli.install')}
          </button>
        )}
      </div>

      {status?.error && (
        <p className="text-[11px] text-destructive mt-2">{status.error}</p>
      )}

      {isInstalled && status?.path && (
        <p className="text-[11px] text-success mt-2">
          {t('wecomCli.installedAt')} <code className="font-mono bg-surface-hover px-1 rounded">{status.path}</code>
        </p>
      )}

      {isInstalled && (
        <p className="text-[10px] text-text-tertiary mt-1.5">
          {t('wecomCli.pathHint')}
        </p>
      )}
    </div>
  )
}

// --- Workspace tabs shell ---

function WorkspaceTabShell({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  activeTab,
  workspaceState,
  onUpdateWorkspace,
}: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  onSelectWorkspace: (id: string) => void
  activeTab: 'workspace' | 'skills' | 'mcp' | 'hooks'
  workspaceState: WorkspaceFormState | null
  onUpdateWorkspace: (updates: Partial<WorkspaceFormState>) => void
}) {
  const { t } = useTranslation('settings')

  if (workspaces.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-text-tertiary">{t('workspaceSwitcher.noWorkspaces')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Left column: workspace list */}
      <div className="w-64 border-r border-border/50 flex-shrink-0 overflow-y-auto">
        <div className="p-3">
          <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-2 px-2">
            {t('workspaceSwitcher.workspaces')}
          </p>
          <div className="space-y-0.5">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => onSelectWorkspace(ws.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  selectedWorkspaceId === ws.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                {ws.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right column: settings content */}
      <div className="flex-1 overflow-y-auto p-6">
        {!workspaceState ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-tertiary">{t('workspaceSwitcher.switchWorkspace')}</p>
          </div>
        ) : (
          <>
            {activeTab === 'workspace' && (
              <WorkspaceDetailsTab state={workspaceState} onUpdate={onUpdateWorkspace} workspaceId={selectedWorkspaceId!} />
            )}
            {activeTab === 'skills' && (
              <SkillsTab state={workspaceState} onUpdate={onUpdateWorkspace} />
            )}
            {activeTab === 'mcp' && (
              <McpTab state={workspaceState} onUpdate={onUpdateWorkspace} />
            )}
            {activeTab === 'hooks' && (
              <HooksTab state={workspaceState} onUpdate={onUpdateWorkspace} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function WorkspaceDetailsTab({
  state,
  onUpdate,
  workspaceId,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
  workspaceId: string
}) {
  const { t } = useTranslation('settings')
  const [showApiKey, setShowApiKey] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [showCorpSecret, setShowCorpSecret] = useState(false)
  const [status, setStatus] = useState<string>('unknown')
  const [users, setUsers] = useState<WeComWorkspaceUser[]>([])

  // Fetch connection status
  useEffect(() => {
    let cancelled = false
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/bot/status`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setStatus(data.status || 'unknown')
      } catch {
        if (!cancelled) setStatus('unknown')
      }
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceId])

  // Fetch WeCom workspace users
  useEffect(() => {
    let cancelled = false
    const fetchUsers = async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/wecom/users`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setUsers(data.users || [])
      } catch {
        if (!cancelled) setUsers([])
      }
    }
    fetchUsers()
    const interval = setInterval(fetchUsers, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceId])

  const statusColor =
    status === 'connected'
      ? 'text-success'
      : status === 'error'
        ? 'text-destructive'
        : 'text-text-tertiary'

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.name')}</label>
        <input
          value={state.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.description')}</label>
        <textarea
          value={state.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          rows={3}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary resize-none"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.folderPath')}</label>
        <div className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg text-text-secondary overflow-x-auto">
          <code className="font-mono text-[11px] whitespace-pre-wrap break-all">{state.folderPath}</code>
        </div>
        <p className="text-[10px] text-text-tertiary mt-1">{t('workspace.folderPathHint')}</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.modelOverride')}</label>
        <input
          value={state.model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          placeholder={t('workspace.modelOverridePlaceholder')}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <p className="text-[10px] text-text-tertiary mt-1">{t('workspace.modelOverrideHint')}</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.apiKey')}</label>
        <div className="flex gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={state.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder={t('workspace.apiKeyPlaceholder')}
            className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
          >
            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-[10px] text-text-tertiary mt-1">
          {t('workspace.apiKeyHint')}
        </p>
      </div>

      {/* WeCom Bot Configuration */}
      <div className="pt-6 border-t border-border/50 space-y-4">
        <div className="flex items-center justify-between py-2">
          <div>
            <label className="block text-xs font-medium text-text-secondary">
              {t('wecom.enableBot')}
            </label>
            <p className="text-[10px] text-text-tertiary mt-0.5">
              {t('wecom.enableBotHint')}
            </p>
          </div>
          <button
            onClick={() => onUpdate({ wecomBotEnabled: !state.wecomBotEnabled })}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              state.wecomBotEnabled ? 'bg-accent' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                state.wecomBotEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('wecom.botName')}</label>
          <input
            value={state.wecomBotName}
            onChange={(e) => onUpdate({ wecomBotName: e.target.value })}
            placeholder={t('wecom.botNamePlaceholder')}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <p className="text-[10px] text-text-tertiary mt-1">{t('wecom.botNameHint')}</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('wecom.botId')}</label>
          <input
            value={state.wecomBotId}
            onChange={(e) => onUpdate({ wecomBotId: e.target.value })}
            placeholder={t('wecom.botIdPlaceholder')}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('wecom.botSecret')}</label>
          <div className="flex gap-2">
            <input
              type={showSecret ? 'text' : 'password'}
              value={state.wecomBotSecret}
              onChange={(e) => onUpdate({ wecomBotSecret: e.target.value })}
              placeholder={t('wecom.botSecretPlaceholder')}
              className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
            >
              {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div className="pt-4 border-t border-border/50">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('wecom.corpId')}</label>
          <input
            value={state.wecomCorpId}
            onChange={(e) => onUpdate({ wecomCorpId: e.target.value })}
            placeholder={t('wecom.corpIdPlaceholder')}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('wecom.corpSecret')}</label>
          <div className="flex gap-2">
            <input
              type={showCorpSecret ? 'text' : 'password'}
              value={state.wecomCorpSecret}
              onChange={(e) => onUpdate({ wecomCorpSecret: e.target.value })}
              placeholder={t('wecom.corpSecretPlaceholder')}
              className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <button
              onClick={() => setShowCorpSecret(!showCorpSecret)}
              className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
            >
              {showCorpSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <span className="text-[11px] font-medium text-text-secondary">{t('wecom.status')}</span>
          <span className={`text-[11px] font-medium capitalize ${statusColor}`}>{status}</span>
        </div>

        <div className="text-[10px] text-text-tertiary pt-2">
          <p>{t('wecom.botSessionNote')}</p>
        </div>

        {/* Workspace Users */}
        <div className="pt-6 border-t border-border/50">
          <h3 className="text-xs font-medium text-text-secondary mb-3">{t('wecom.usersTitle')}</h3>
          {users.length === 0 ? (
            <p className="text-[11px] text-text-tertiary">{t('wecom.usersEmpty')}</p>
          ) : (
            <div className="space-y-2">
              {users.map((user) => (
                <div
                  key={user.encryptedUserId}
                  className="px-3 py-2.5 bg-bg rounded-lg border border-border/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {user.plaintextUserId || user.encryptedUserId}
                    </span>
                    {!user.plaintextUserId && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                        {t('wecom.userPending')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="text-[10px] text-text-tertiary">
                      {t('wecom.firstSeen')}: {new Date(user.firstSeenAt).toLocaleString()}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {t('wecom.lastSeen')}: {new Date(user.lastSeenAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ComingSoonPlaceholder() {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-text-primary">{t('placeholder.comingSoon')}</h3>
        <p className="text-xs text-text-secondary max-w-sm">{t('placeholder.contact')}</p>
      </div>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function SkillsTab(_: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  return <ComingSoonPlaceholder />
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function McpTab(_: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  return <ComingSoonPlaceholder />
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function HooksTab(_: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  return <ComingSoonPlaceholder />
}

interface WeComWorkspaceUser {
  encryptedUserId: string
  plaintextUserId?: string
  firstSeenAt: string
  lastSeenAt: string
}
