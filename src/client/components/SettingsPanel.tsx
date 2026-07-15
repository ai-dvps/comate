import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  Plus,
  Trash2,
  Save,
  Sun,
  Moon,
  Monitor,
  AlertTriangle,
  Loader2,
  ChevronRight,
  Bot,
} from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTheme } from '../hooks/use-theme'
import { useAppSettings } from '../hooks/use-app-settings'
import { useUpdaterStore } from '../stores/updater-store'
import { checkForUpdates, getAppVersion, downloadAndInstallUpdate, restartToUpdate, dismissUpdate } from '../lib/updater-api'
import i18n from '../i18n'
import type { Workspace } from '../stores/workspace-store'
import ProviderSection from './ProviderSection'
import DeleteWorkspaceDialog from './DeleteWorkspaceDialog'
import BotManagementPage, { type BotManagementPageHandle } from './BotManagementPage'
import UnsavedChangesDialog from './UnsavedChangesDialog'

interface SettingsPanelProps {
  onClose: () => void
}

type SettingsTab = 'general' | 'appearance' | 'workspace' | 'providers' | 'bots'

type WorkspaceSection = 'general' | 'bot' | 'security' | 'danger'

interface WorkspaceFormState {
  name: string
  description: string
  folderPath: string
  skills: { name: string }[]
  mcpServers: { name: string; command: string; args: string }[]
  hooks: { name: string; scriptPath: string }[]
  wecomFilePromptTemplate: string
  promptHistoryRetentionDays: string
  sensitiveFileDenylist: string[]
}

function buildWorkspaceFormState(workspace: Workspace): WorkspaceFormState {
  return {
    name: workspace.name,
    description: workspace.description,
    folderPath: workspace.folderPath,
    skills: [...workspace.skills],
    mcpServers: workspace.mcpServers.map((m) => ({
      ...m,
      args: m.args?.join(' ') || '',
    })),
    hooks: [...workspace.hooks],
    wecomFilePromptTemplate: (workspace.settings?.wecomFilePromptTemplate as string) || '',
    promptHistoryRetentionDays: String(workspace.settings?.promptHistoryRetentionDays ?? 30),
    sensitiveFileDenylist: (workspace.settings?.sensitiveFileDenylist as string[]) || [],
  }
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation('settings')
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)
  const storeError = useWorkspaceStore((s) => s.error)
  const isStoreLoading = useWorkspaceStore((s) => s.isLoading)

  const { reopenLastWorkspace, setReopenLastWorkspace, useModifierToSubmit, setUseModifierToSubmit, archiveThresholdDays, setArchiveThresholdDays, autoCheckUpdates, setAutoCheckUpdates, notificationSoundsEnabled, setNotificationSoundsEnabled, notificationSoundsVolume, setNotificationSoundsVolume, lastUpdateCheckAt, setLastUpdateCheckAt } = useAppSettings()
  const windowCap = useChatStore((s) => s.windowCap)
  const setWindowCap = useChatStore((s) => s.setWindowCap)
  const updateStatus = useUpdaterStore((s) => s.status)
  const updateError = useUpdaterStore((s) => s.error)
  const updateInfo = useUpdaterStore((s) => s.update)
  const downloadProgress = useUpdaterStore((s) => s.downloadProgress)

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const [pendingClose, setPendingClose] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const botPageRef = useRef<BotManagementPageHandle>(null)

  // App-level form state
  const [appReopen, setAppReopen] = useState(reopenLastWorkspace)
  const [appModifierSubmit, setAppModifierSubmit] = useState(useModifierToSubmit)
  const [appAutoCheckUpdates, setAppAutoCheckUpdates] = useState(autoCheckUpdates)
  const [appNotificationSounds, setAppNotificationSounds] = useState(notificationSoundsEnabled)
  const [appNotificationSoundsVolume, setAppNotificationSoundsVolume] = useState(notificationSoundsVolume)
  const [windowCapInput, setWindowCapInput] = useState(String(windowCap))
  const [archiveThresholdDaysInput, setArchiveThresholdDaysInput] = useState(String(archiveThresholdDays))

  const [workspaceDirty, setWorkspaceDirty] = useState(false)

  // Workspace form state (keyed by workspace id)
  const [workspaceState, setWorkspaceState] = useState<Record<string, WorkspaceFormState>>({})

  // Snapshot for dirty tracking
  const snapshotRef = useRef({
    appReopen: reopenLastWorkspace,
    appModifierSubmit: useModifierToSubmit,
    appAutoCheckUpdates: autoCheckUpdates,
    appNotificationSounds: notificationSoundsEnabled,
    appNotificationSoundsVolume: notificationSoundsVolume,
    appWindowCap: windowCap,
    appArchiveThresholdDays: archiveThresholdDays,
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
      appReopen: reopenLastWorkspace,
      appModifierSubmit: useModifierToSubmit,
      appAutoCheckUpdates: autoCheckUpdates,
      appNotificationSounds: notificationSoundsEnabled,
      appNotificationSoundsVolume: notificationSoundsVolume,
      appWindowCap: windowCap,
      appArchiveThresholdDays: archiveThresholdDays,
      workspaceState: JSON.parse(JSON.stringify(initial)),
    }
    setAppReopen(reopenLastWorkspace)
    setAppModifierSubmit(useModifierToSubmit)
    setAppAutoCheckUpdates(autoCheckUpdates)
    setAppNotificationSounds(notificationSoundsEnabled)
    setAppNotificationSoundsVolume(notificationSoundsVolume)
    setWindowCapInput(String(windowCap))
    setArchiveThresholdDaysInput(String(archiveThresholdDays))

    if (workspaces.length > 0) {
      setSelectedWorkspaceId(activeWorkspaceId || workspaces[0].id)
    }
  }, [workspaces, reopenLastWorkspace, useModifierToSubmit, autoCheckUpdates, notificationSoundsEnabled, notificationSoundsVolume, activeWorkspaceId, windowCap, archiveThresholdDays])

  useEffect(() => {
    setWindowCapInput(String(windowCap))
  }, [windowCap])

  useEffect(() => {
    setArchiveThresholdDaysInput(String(archiveThresholdDays))
  }, [archiveThresholdDays])

  // Guard: reset activeTab if it holds a removed value (hot-reload / stale state)
  useEffect(() => {
    if (
      activeTab !== 'general' &&
      activeTab !== 'appearance' &&
      activeTab !== 'workspace' &&
      activeTab !== 'providers' &&
      activeTab !== 'bots'
    ) {
      setActiveTab('workspace')
    }
  }, [activeTab])

  // Guard: keep selectedWorkspaceId in sync when the selected workspace is deleted.
  useEffect(() => {
    if (!selectedWorkspaceId) return
    if (!workspaces.some((w) => w.id === selectedWorkspaceId)) {
      const fallback = activeWorkspaceId || (workspaces.length > 0 ? workspaces[0].id : null)
      setSelectedWorkspaceId(fallback)
      // Clean up orphaned form state for the deleted workspace.
      setWorkspaceState((prev) => {
        const next = { ...prev }
        delete next[selectedWorkspaceId]
        return next
      })
    }
  }, [workspaces, selectedWorkspaceId, activeWorkspaceId])

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId)

  const isAppDirty = useCallback(() => {
    return (
      appReopen !== snapshotRef.current.appReopen ||
      appModifierSubmit !== snapshotRef.current.appModifierSubmit ||
      appAutoCheckUpdates !== snapshotRef.current.appAutoCheckUpdates ||
      appNotificationSounds !== snapshotRef.current.appNotificationSounds ||
      appNotificationSoundsVolume !== snapshotRef.current.appNotificationSoundsVolume ||
      windowCap !== snapshotRef.current.appWindowCap ||
      archiveThresholdDays !== snapshotRef.current.appArchiveThresholdDays
    )
  }, [
    appReopen,
    appModifierSubmit,
    appAutoCheckUpdates,
    appNotificationSounds,
    appNotificationSoundsVolume,
    windowCap,
    archiveThresholdDays,
  ])

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setWorkspaceDirty(false)
      return
    }
    const current = workspaceState[selectedWorkspaceId]
    const snapshot = snapshotRef.current.workspaceState[selectedWorkspaceId]
    if (!current || !snapshot) {
      setWorkspaceDirty(false)
      return
    }
    setWorkspaceDirty(JSON.stringify(current) !== JSON.stringify(snapshot))
  }, [selectedWorkspaceId, workspaceState])

  const isDirty = useCallback(() => {
    if (activeTab === 'bots' && botPageRef.current?.isDirty()) return true
    return isAppDirty() || workspaceDirty
  }, [activeTab, isAppDirty, workspaceDirty])

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

  const saveAppSettings = useCallback(() => {
    setReopenLastWorkspace(appReopen)
    setUseModifierToSubmit(appModifierSubmit)
    setAutoCheckUpdates(appAutoCheckUpdates)
    setNotificationSoundsEnabled(appNotificationSounds)
    setNotificationSoundsVolume(appNotificationSoundsVolume)

    const parsedCap = parseInt(windowCapInput, 10)
    if (!isNaN(parsedCap) && parsedCap !== windowCap) {
      setWindowCap(parsedCap)
    }

    const parsedArchiveThreshold = parseInt(archiveThresholdDaysInput, 10)
    const nextArchiveThresholdDays =
      !isNaN(parsedArchiveThreshold) && parsedArchiveThreshold > 0
        ? parsedArchiveThreshold
        : archiveThresholdDays
    if (nextArchiveThresholdDays !== archiveThresholdDays) {
      setArchiveThresholdDays(nextArchiveThresholdDays)
    }

    snapshotRef.current = {
      ...snapshotRef.current,
      appReopen,
      appModifierSubmit,
      appAutoCheckUpdates,
      appNotificationSounds,
      appNotificationSoundsVolume,
      appWindowCap: windowCap,
      appArchiveThresholdDays: nextArchiveThresholdDays,
    }
  }, [
    appReopen,
    appModifierSubmit,
    appAutoCheckUpdates,
    appNotificationSounds,
    appNotificationSoundsVolume,
    windowCapInput,
    windowCap,
    archiveThresholdDaysInput,
    archiveThresholdDays,
    setReopenLastWorkspace,
    setUseModifierToSubmit,
    setAutoCheckUpdates,
    setNotificationSoundsEnabled,
    setNotificationSoundsVolume,
    setWindowCap,
    setArchiveThresholdDays,
  ])

  const discardAppSettings = useCallback(() => {
    const snapshot = snapshotRef.current
    setAppReopen(snapshot.appReopen)
    setAppModifierSubmit(snapshot.appModifierSubmit)
    setAppAutoCheckUpdates(snapshot.appAutoCheckUpdates)
    setAppNotificationSounds(snapshot.appNotificationSounds)
    setAppNotificationSoundsVolume(snapshot.appNotificationSoundsVolume)
    setWindowCap(snapshot.appWindowCap)
    setArchiveThresholdDays(snapshot.appArchiveThresholdDays)
    setWindowCapInput(String(snapshot.appWindowCap))
    setArchiveThresholdDaysInput(String(snapshot.appArchiveThresholdDays))
  }, [setWindowCap, setArchiveThresholdDays, setWindowCapInput, setArchiveThresholdDaysInput])

  const saveWorkspace = useCallback(async () => {
    if (!selectedWorkspaceId || !workspaceState[selectedWorkspaceId]) return
    const ws = workspaceState[selectedWorkspaceId]
    const parsedRetention = parseInt(ws.promptHistoryRetentionDays, 10)
    const promptHistoryRetentionDays = !isNaN(parsedRetention) ? parsedRetention : 30
    await updateWorkspace(selectedWorkspaceId, {
      name: ws.name,
      description: ws.description,
      settings: {
        wecomFilePromptTemplate: ws.wecomFilePromptTemplate || undefined,
        promptHistoryRetentionDays,
        sensitiveFileDenylist: ws.sensitiveFileDenylist,
      },
      skills: ws.skills,
      mcpServers: ws.mcpServers.map((m) => ({
        name: m.name,
        command: m.command,
        args: m.args ? m.args.split(' ').filter(Boolean) : undefined,
      })),
      hooks: ws.hooks,
    })

    snapshotRef.current = {
      ...snapshotRef.current,
      workspaceState: {
        ...snapshotRef.current.workspaceState,
        [selectedWorkspaceId]: JSON.parse(JSON.stringify(ws)),
      },
    }
    setWorkspaceDirty(false)
  }, [selectedWorkspaceId, workspaceState, updateWorkspace])

  const discardWorkspace = useCallback(() => {
    if (!selectedWorkspaceId) return
    setWorkspaceState((prev) => {
      const snapshot = snapshotRef.current.workspaceState[selectedWorkspaceId]
      if (snapshot) {
        return {
          ...prev,
          [selectedWorkspaceId]: JSON.parse(JSON.stringify(snapshot)),
        }
      }
      const ws = workspaces.find((w) => w.id === selectedWorkspaceId)
      if (ws) {
        return {
          ...prev,
          [selectedWorkspaceId]: buildWorkspaceFormState(ws),
        }
      }
      return prev
    })
  }, [selectedWorkspaceId, workspaces])

  const handleSaveApp = async () => {
    setIsSaving(true)
    try {
      saveAppSettings()
    } finally {
      setIsSaving(false)
    }
  }

  const handleDiscardApp = () => {
    discardAppSettings()
  }

  const handleSaveWorkspace = async () => {
    setIsSaving(true)
    try {
      await saveWorkspace()
    } finally {
      setIsSaving(false)
    }
  }

  const handleDiscardWorkspace = () => {
    discardWorkspace()
  }

  const handleSaveAll = async () => {
    setIsSaving(true)
    try {
      if (activeTab === 'bots' && botPageRef.current?.isDirty()) {
        await botPageRef.current.save()
      }
      if (isAppDirty()) {
        saveAppSettings()
      }
      if (workspaceDirty) {
        await saveWorkspace()
      }
      if (pendingClose) {
        setPendingClose(false)
        setShowUnsavedDialog(false)
        onClose()
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleDiscardAll = () => {
    if (activeTab === 'bots') {
      botPageRef.current?.discard()
    }
    discardAppSettings()
    discardWorkspace()
    setShowUnsavedDialog(false)
    setPendingClose(false)
    onClose()
  }

  const handleOpenDeleteDialog = () => {
    setShowDeleteDialog(true)
  }

  const handleCancelDelete = () => {
    setShowDeleteDialog(false)
  }

  const handleConfirmDelete = async () => {
    if (!selectedWorkspaceId) return
    await deleteWorkspace(selectedWorkspaceId)
    if (!useWorkspaceStore.getState().error) {
      setShowDeleteDialog(false)
    }
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
    { id: 'providers', label: t('tabs.providers') },
    { id: 'bots', label: t('tabs.bots') },
  ]

  const isWorkspaceTab = activeTab === 'workspace'

  return (
    <div className="fixed top-11 inset-x-0 bottom-0 z-50 flex flex-col">
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
                reopenLastWorkspace={appReopen}
                onReopenLastWorkspaceChange={setAppReopen}
                useModifierToSubmit={appModifierSubmit}
                onUseModifierToSubmitChange={setAppModifierSubmit}
                autoCheckUpdates={appAutoCheckUpdates}
                onAutoCheckUpdatesChange={setAppAutoCheckUpdates}
                notificationSounds={appNotificationSounds}
                onNotificationSoundsChange={setAppNotificationSounds}
                notificationSoundsVolume={appNotificationSoundsVolume}
                onNotificationSoundsVolumeChange={setAppNotificationSoundsVolume}
                lastUpdateCheckAt={lastUpdateCheckAt}
                updateStatus={updateStatus}
                updateError={updateError}
                updateInfo={updateInfo}
                downloadProgress={downloadProgress}
                onRecordUpdateCheck={() => setLastUpdateCheckAt(new Date().toISOString())}
                windowCap={windowCapInput}
                onWindowCapChange={setWindowCapInput}
                onWindowCapCommit={(val) => {
                  const parsed = parseInt(val, 10)
                  if (!isNaN(parsed)) {
                    setWindowCap(parsed)
                  }
                }}
                archiveThresholdDays={archiveThresholdDaysInput}
                onArchiveThresholdDaysChange={setArchiveThresholdDaysInput}
                onArchiveThresholdDaysCommit={(val) => {
                  const parsed = parseInt(val, 10)
                  if (!isNaN(parsed) && parsed > 0) {
                    setArchiveThresholdDays(parsed)
                  }
                }}
                isDirty={isAppDirty()}
                onSave={handleSaveApp}
                onCancel={handleDiscardApp}
                isSaving={isSaving}
                error={storeError}
              />
            )}

            {activeTab === 'appearance' && <AppearanceTab />}

            {activeTab === 'providers' && <ProviderSection />}

            {activeTab === 'bots' && <BotManagementPage ref={botPageRef} />}

            {isWorkspaceTab && (
              <WorkspaceTabShell
                workspaces={workspaces}
                selectedWorkspaceId={selectedWorkspaceId}
                onSelectWorkspace={setSelectedWorkspaceId}
                workspaceState={selectedWorkspaceId ? workspaceState[selectedWorkspaceId] : null}
                onUpdateWorkspace={updateSelectedWorkspace}
                onDelete={handleOpenDeleteDialog}
                onManageBots={() => setActiveTab('bots')}
                footer={
                  <>
                    <span className="text-[11px] text-text-tertiary">
                      {storeError ? (
                        <span className="text-destructive">{storeError}</span>
                      ) : workspaceDirty ? (
                        t('unsavedDialog.message')
                      ) : null}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleDiscardWorkspace}
                        disabled={isSaving || !workspaceDirty}
                        className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
                      >
                        {t('actions.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSaveWorkspace()}
                        disabled={isSaving || !workspaceDirty}
                        className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
                      >
                        {isSaving ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {t('unsavedDialog.saving')}
                          </>
                        ) : (
                          <>
                            {t('actions.save')}
                          </>
                        )}
                      </button>
                    </div>
                  </>
                }
                isDirty={workspaceDirty}
                isSaving={isSaving}
                onSaveWorkspace={handleSaveWorkspace}
                onDiscardWorkspace={handleDiscardWorkspace}
              />
            )}
          </div>

          {/* Footer removed: per-tab local controls */}
        </div>
      </div>

      <UnsavedChangesDialog
        isOpen={showUnsavedDialog}
        title={t('unsavedDialog.title')}
        message={t('unsavedDialog.message')}
        onSave={handleSaveAll}
        onDiscard={handleDiscardAll}
        onKeepEditing={() => {
          setShowUnsavedDialog(false)
          setPendingClose(false)
        }}
        isSaving={isSaving}
      />

      {/* Delete Workspace Dialog */}
      {selectedWorkspace && (
        <DeleteWorkspaceDialog
          workspaceName={selectedWorkspace.name}
          isOpen={showDeleteDialog}
          isLoading={isStoreLoading}
          error={storeError}
          onCancel={handleCancelDelete}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  )
}

// --- App-level tabs ---

export function GeneralTab({
  reopenLastWorkspace,
  onReopenLastWorkspaceChange,
  useModifierToSubmit,
  onUseModifierToSubmitChange,
  autoCheckUpdates,
  onAutoCheckUpdatesChange,
  notificationSounds,
  onNotificationSoundsChange,
  notificationSoundsVolume,
  onNotificationSoundsVolumeChange,
  lastUpdateCheckAt,
  updateStatus,
  updateError,
  updateInfo,
  downloadProgress,
  onRecordUpdateCheck,
  windowCap,
  onWindowCapChange,
  onWindowCapCommit,
  archiveThresholdDays,
  onArchiveThresholdDaysChange,
  onArchiveThresholdDaysCommit,
  isDirty,
  onSave,
  onCancel,
  isSaving,
  error,
}: {
  reopenLastWorkspace: boolean
  onReopenLastWorkspaceChange: (v: boolean) => void
  useModifierToSubmit: boolean
  onUseModifierToSubmitChange: (v: boolean) => void
  autoCheckUpdates: boolean
  onAutoCheckUpdatesChange: (v: boolean) => void
  notificationSounds: boolean
  onNotificationSoundsChange: (v: boolean) => void
  notificationSoundsVolume: number
  onNotificationSoundsVolumeChange: (v: number) => void
  lastUpdateCheckAt: string | null
  updateStatus: import('../stores/updater-store').UpdaterStatus
  updateError: string | null
  updateInfo: import('../stores/updater-store').UpdateInfo | null
  downloadProgress: number
  onRecordUpdateCheck: () => void
  windowCap: string
  onWindowCapChange: (v: string) => void
  onWindowCapCommit: (v: string) => void
  archiveThresholdDays: string
  onArchiveThresholdDaysChange: (v: string) => void
  onArchiveThresholdDaysCommit: (v: string) => void
  isDirty: boolean
  onSave: () => void | Promise<void>
  onCancel: () => void
  isSaving: boolean
  error: string | null
}) {
  const { t } = useTranslation('settings')
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [checkingNow, setCheckingNow] = useState(false)

  useEffect(() => {
    getAppVersion().then(setAppVersion)
  }, [])

  const handleCheckNow = async () => {
    if (checkingNow || updateStatus === 'downloading' || updateStatus === 'ready' || updateStatus === 'restarting') return
    setCheckingNow(true)
    try {
      await checkForUpdates()
      onRecordUpdateCheck()
    } finally {
      setCheckingNow(false)
    }
  }

  const statusText = useMemo(() => {
    if (updateError) return t('general.updateStatusError', { error: updateError })
    switch (updateStatus) {
      case 'checking':
        return t('general.updateStatusChecking')
      case 'available':
        return t('general.updateStatusAvailable')
      case 'downloading':
        return t('general.updateStatusDownloading')
      case 'ready':
        return t('general.updateStatusReady')
      default:
        return lastUpdateCheckAt
          ? t('general.updateStatusLastCheck', { time: new Date(lastUpdateCheckAt).toLocaleString() })
          : t('general.updateStatusNeverChecked')
    }
  }, [updateStatus, updateError, lastUpdateCheckAt, t])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl space-y-5">
          <PathConfigSection />

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

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('general.archiveThresholdDays')}
            </label>
            <input
              type="number"
              min={1}
              value={archiveThresholdDays}
              onChange={(e) => onArchiveThresholdDaysChange(e.target.value)}
              onBlur={() => onArchiveThresholdDaysCommit(archiveThresholdDays)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onArchiveThresholdDaysCommit(archiveThresholdDays)
                }
              }}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('general.archiveThresholdDaysHint')}
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

          <div className="flex items-center justify-between py-3 border-t border-border/50">
            <div>
              <label className="block text-xs font-medium text-text-secondary">
                {t('general.useModifierToSubmit')}
              </label>
              <p className="text-[10px] text-text-tertiary mt-0.5">
                {t('general.useModifierToSubmitHint')}
              </p>
            </div>
            <button
              onClick={() => onUseModifierToSubmitChange(!useModifierToSubmit)}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                useModifierToSubmit ? 'bg-accent' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  useModifierToSubmit ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between py-3 border-t border-border/50">
            <div>
              <label className="block text-xs font-medium text-text-secondary">
                {t('general.notificationSounds')}
              </label>
              <p className="text-[10px] text-text-tertiary mt-0.5">
                {t('general.notificationSoundsHint')}
              </p>
            </div>
            <button
              onClick={() => onNotificationSoundsChange(!notificationSounds)}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                notificationSounds ? 'bg-accent' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  notificationSounds ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className={`py-3 border-t border-border/50 ${!notificationSounds ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-text-secondary" htmlFor="notification-sounds-volume">
                {t('general.notificationSoundsVolume')}
              </label>
              <span className="text-xs font-medium text-text-secondary">{notificationSoundsVolume}%</span>
            </div>
            <input
              id="notification-sounds-volume"
              type="range"
              min={0}
              max={100}
              step={1}
              value={notificationSoundsVolume}
              disabled={!notificationSounds}
              onChange={(e) => onNotificationSoundsVolumeChange(parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-accent disabled:cursor-not-allowed"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('general.notificationSoundsVolumeHint')}
            </p>
          </div>

          <div className="py-3 border-t border-border/50 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-xs font-medium text-text-secondary">
                  {t('general.updaterTitle')}
                </label>
                <p className="text-[10px] text-text-tertiary mt-0.5">
                  {t('general.updaterVersion', { version: appVersion ?? t('general.updaterVersionUnknown') })}
                </p>
              </div>
              {(updateStatus === 'idle' || updateStatus === 'checking' || updateError) && (
                <button
                  onClick={handleCheckNow}
                  disabled={checkingNow || updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'ready' || updateStatus === 'restarting'}
                  className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
                >
                  {checkingNow || updateStatus === 'checking'
                    ? t('general.updaterChecking')
                    : t('general.updaterCheckNow')}
                </button>
              )}
              {updateStatus === 'available' && (
                <button
                  onClick={() => void downloadAndInstallUpdate()}
                  className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
                >
                  {t('general.updaterDownload')}
                </button>
              )}
            </div>

            {(updateStatus === 'idle' || updateError) && (
              <p className={`text-[10px] ${updateError ? 'text-destructive' : 'text-text-tertiary'}`}>
                {statusText}
              </p>
            )}

            {updateStatus === 'checking' && (
              <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                {statusText}
              </div>
            )}

            {updateStatus === 'available' && updateInfo && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-text-primary">
                  {t('general.updaterNewVersionAvailable', { version: updateInfo.version })}
                </p>
                {updateInfo.body && (
                  <div className="max-h-32 overflow-y-auto rounded-lg bg-bg border border-border p-3">
                    <p className="text-xs text-text-secondary whitespace-pre-wrap">{updateInfo.body}</p>
                  </div>
                )}
              </div>
            )}

            {updateStatus === 'downloading' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] text-text-secondary">
                  <span>{statusText}</span>
                  <span>{t('general.updaterDownloadingProgress', { progress: downloadProgress })}</span>
                </div>
                <div
                  className="w-full h-1.5 bg-border rounded-full overflow-hidden"
                  role="progressbar"
                  aria-valuenow={downloadProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full bg-accent transition-all duration-200"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {updateStatus === 'ready' && (
              <div className="space-y-2">
                <p className="text-[10px] text-text-secondary">{statusText}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void restartToUpdate()}
                    className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
                  >
                    {t('general.updaterInstallNow')}
                  </button>
                  <button
                    onClick={dismissUpdate}
                    className="px-3 py-1.5 text-[11px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                  >
                    {t('general.updaterLater')}
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <div>
                <label className="block text-xs font-medium text-text-secondary">
                  {t('general.updaterAutoCheck')}
                </label>
                <p className="text-[10px] text-text-tertiary mt-0.5">
                  {t('general.updaterAutoCheckHint')}
                </p>
              </div>
              <button
                onClick={() => onAutoCheckUpdatesChange(!autoCheckUpdates)}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  autoCheckUpdates ? 'bg-accent' : 'bg-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    autoCheckUpdates ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-t border-border/50">
        <span className="text-[11px] text-text-tertiary">
          {error ? <span className="text-destructive">{error}</span> : isDirty ? t('unsavedDialog.message') : null}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving || !isDirty}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
          >
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={isSaving || !isDirty}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('unsavedDialog.saving')}
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                {t('actions.save')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function AppearanceTab() {
  const { theme, isFollowingSystem, setTheme, resetToSystem } = useTheme()
  const { language, setLanguage, chatFontSize, setChatFontSize, uiFontSize, setUiFontSize, displayMode, setDisplayMode } = useAppSettings()
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

  const displayModePresets: { value: 'result' | 'linear'; label: string }[] = [
    { value: 'result', label: t('appearance.displayModeResult') },
    { value: 'linear', label: t('appearance.displayModeLinear') },
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

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">{t('appearance.displayMode')}</label>
          <div className="flex items-center gap-2">
            {displayModePresets.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setDisplayMode(preset.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  displayMode === preset.value
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
  const [resolvedPathExpanded, setResolvedPathExpanded] = useState(false)

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
            <button
              type="button"
              onClick={() => setResolvedPathExpanded((prev) => !prev)}
              className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary mb-1 hover:text-text-secondary transition-colors"
            >
              <ChevronRight
                className={`w-3 h-3 transition-transform ${resolvedPathExpanded ? 'rotate-90' : ''}`}
              />
              {t('general.pathConfigResolvedPath')}
            </button>
            {resolvedPathExpanded && (
              <>
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
              </>
            )}
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

// --- Workspace tabs shell ---

function WorkspaceTabShell({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  workspaceState,
  onUpdateWorkspace,
  onDelete,
  onManageBots,
  footer,
  isDirty,
  isSaving,
  onSaveWorkspace,
  onDiscardWorkspace,
}: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  onSelectWorkspace: (id: string) => void
  workspaceState: WorkspaceFormState | null
  onUpdateWorkspace: (updates: Partial<WorkspaceFormState>) => void
  onDelete: () => void
  onManageBots: () => void
  footer?: React.ReactNode
  isDirty?: boolean
  isSaving?: boolean
  onSaveWorkspace?: () => Promise<void>
  onDiscardWorkspace?: () => void
}) {
  const { t } = useTranslation('settings')
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('general')
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)

  // Reset to General when switching workspaces
  useEffect(() => {
    setActiveSection('general')
  }, [selectedWorkspaceId])

  if (workspaces.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-text-tertiary">{t('workspaceSwitcher.noWorkspaces')}</p>
      </div>
    )
  }

  const sections: { id: WorkspaceSection; label: string }[] = [
    { id: 'general', label: t('workspaceSections.general') },
    { id: 'bot', label: t('workspaceSections.bot') },
    { id: 'security', label: t('workspaceSections.security') },
    { id: 'danger', label: t('workspaceSections.danger') },
  ]

  const handleSelectWorkspace = (id: string) => {
    if (id === selectedWorkspaceId) return
    if (isDirty) {
      setPendingWorkspaceId(id)
      setShowUnsavedDialog(true)
      return
    }
    onSelectWorkspace(id)
  }

  const handleDialogSave = async () => {
    await onSaveWorkspace?.()
    if (pendingWorkspaceId) {
      onSelectWorkspace(pendingWorkspaceId)
    }
    setPendingWorkspaceId(null)
    setShowUnsavedDialog(false)
  }

  const handleDialogDiscard = () => {
    onDiscardWorkspace?.()
    if (pendingWorkspaceId) {
      onSelectWorkspace(pendingWorkspaceId)
    }
    setPendingWorkspaceId(null)
    setShowUnsavedDialog(false)
  }

  const handleDialogKeepEditing = () => {
    setPendingWorkspaceId(null)
    setShowUnsavedDialog(false)
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
                onClick={() => handleSelectWorkspace(ws.id)}
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
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Section tabs */}
        <div className="flex border-b border-border/50 flex-shrink-0 px-6">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`py-2 px-3 text-[11px] font-medium transition-all ${
                activeSection === section.id
                  ? 'text-text-primary border-b-2 border-accent'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {section.label}
            </button>
          ))}
        </div>

        {/* Section content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!workspaceState ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-text-tertiary">{t('workspaceSwitcher.switchWorkspace')}</p>
            </div>
          ) : (
            <>
              {activeSection === 'general' && (
                <GeneralSection state={workspaceState} onUpdate={onUpdateWorkspace} />
              )}
              {activeSection === 'bot' && (
                <BotSection
                  workspaceId={selectedWorkspaceId!}
                  state={workspaceState}
                  onUpdate={onUpdateWorkspace}
                  onManageBots={onManageBots}
                />
              )}
              {activeSection === 'security' && (
                <SecuritySection state={workspaceState} onUpdate={onUpdateWorkspace} />
              )}
              {activeSection === 'danger' && <DangerSection onDelete={onDelete} />}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border/50 flex-shrink-0">
          {footer}
        </div>

        <UnsavedChangesDialog
          isOpen={showUnsavedDialog}
          title={t('unsavedDialog.title')}
          message={t('unsavedDialog.message')}
          onSave={handleDialogSave}
          onDiscard={handleDialogDiscard}
          onKeepEditing={handleDialogKeepEditing}
          isSaving={isSaving}
        />
      </div>
    </div>
  )
}

function GeneralSection({
  state,
  onUpdate,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="max-w-xl space-y-5">
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
    </div>
  )
}

function BotSection({
  workspaceId,
  state,
  onUpdate,
  onManageBots,
}: {
  workspaceId: string
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
  onManageBots: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="max-w-xl space-y-5">
      <BoundBotCard workspaceId={workspaceId} onManageBots={onManageBots} />

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('wecom.filePromptTemplate')}</label>
        <textarea
          value={state.wecomFilePromptTemplate}
          onChange={(e) => onUpdate({ wecomFilePromptTemplate: e.target.value })}
          placeholder={t('wecom.filePromptTemplatePlaceholder')}
          rows={4}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
        />
        <p className="text-[10px] text-text-tertiary mt-1">{t('wecom.filePromptTemplateHint')}</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.promptHistoryRetentionDays')}</label>
        <input
          type="number"
          value={state.promptHistoryRetentionDays}
          onChange={(e) => onUpdate({ promptHistoryRetentionDays: e.target.value })}
          placeholder={t('workspace.promptHistoryRetentionDaysPlaceholder')}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <p className="text-[10px] text-text-tertiary mt-1">{t('workspace.promptHistoryRetentionDaysHint')}</p>
      </div>
    </div>
  )
}

function SecuritySection({
  state,
  onUpdate,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  return (
    <div className="max-w-xl space-y-5">
      <SensitiveFileDenylistEditor
        value={state.sensitiveFileDenylist}
        onChange={(next) => onUpdate({ sensitiveFileDenylist: next })}
      />
    </div>
  )
}

function DangerSection({ onDelete }: { onDelete: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h3 className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
          {t('deleteWorkspace.title')}
        </h3>
        <p className="text-[10px] text-text-tertiary mb-3">{t('deleteWorkspace.folderUntouched')}</p>
        <button
          onClick={onDelete}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/30 rounded-lg transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          {t('deleteWorkspace.delete')}
        </button>
      </div>
    </div>
  )
}

function SensitiveFileDenylistEditor({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const { t } = useTranslation('settings')
  const text = value.join('\n')

  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('workspace.sensitiveFileDenylistTitle')}</label>
      <p className="text-[10px] text-text-tertiary mb-2">{t('workspace.sensitiveFileDenylistHint')}</p>
      <textarea
        value={text}
        onChange={(e) => {
          const lines = e.target.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
          onChange(lines)
        }}
        placeholder={t('workspace.sensitiveFileDenylistPlaceholder')}
        rows={6}
        className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
      />
    </div>
  )
}

interface BoundBot {
  id: string
  name: string
  activeWorkspaceId: string | null
  channelSettings: {
    wecom?: { enabled?: boolean }
    feishu?: { enabled?: boolean }
  }
}

function BoundBotCard({ workspaceId, onManageBots }: { workspaceId: string; onManageBots: () => void }) {
  const { t } = useTranslation('settings')
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [bot, setBot] = useState<BoundBot | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/workspaces/${workspaceId}/bot`)
      .then(async (res) => {
        if (!cancelled) {
          if (res.ok) {
            const data = (await res.json()) as { bot: BoundBot }
            setBot(data.bot)
          } else {
            setBot(null)
          }
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBot(null)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const activeWorkspace = workspaces.find((w) => w.id === bot?.activeWorkspaceId)

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5" />
          {t('workspace.boundBotTitle')}
        </h4>
        <button
          type="button"
          onClick={onManageBots}
          className="text-[11px] text-accent hover:text-accent-hover underline underline-offset-2"
        >
          {t('workspace.boundBotManage')}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('common.loading', 'Loading...')}
        </div>
      ) : bot ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">{bot.name}</span>
            <div className="flex items-center gap-1.5">
              {bot.channelSettings.wecom?.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success">
                  {t('workspace.boundBotChannelWecom')}
                </span>
              )}
              {bot.channelSettings.feishu?.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-info/10 text-info">
                  {t('workspace.boundBotChannelFeishu')}
                </span>
              )}
            </div>
          </div>
          <p className="text-[11px] text-text-secondary">
            {t('workspace.boundBotActiveWorkspace', { name: activeWorkspace?.name ?? t('workspace.noActiveWorkspace') })}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-text-tertiary">{t('workspace.boundBotNone')}</p>
      )}
    </div>
  )
}



