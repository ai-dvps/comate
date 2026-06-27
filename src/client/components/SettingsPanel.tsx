import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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
  RefreshCw,
  Play,
  Loader2,
  ChevronRight,
} from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTheme } from '../hooks/use-theme'
import { useAppSettings } from '../hooks/use-app-settings'
import { useUpdaterStore } from '../stores/updater-store'
import { checkForUpdates, getAppVersion, downloadAndInstallUpdate, restartToUpdate, dismissUpdate } from '../lib/updater-api'
import i18n from '../i18n'
import type { Workspace } from '../stores/workspace-store'
import type { ToolPermissionPolicy } from '../types/wecom-permissions'
import type { WeComBotIsolationSettings } from '../types/wecom-isolation'
import { SAFE_PRESET } from '../types/wecom-permissions'
import { DEFAULT_ISOLATION_SETTINGS } from '../types/wecom-isolation'
import ProviderSection from './ProviderSection'
import SkillsPage from './SkillsPage'
import { PermissionsSubTab } from './PermissionsSubTab'
import { IsolationSubTab } from './IsolationSubTab'
import WeComQueuePanel from './WeComQueuePanel'
import DeleteWorkspaceDialog from './DeleteWorkspaceDialog'

/** Returns true if every category is denied and no override allows Reply. Triggers the save-time warning. */
function isAllDeniedIncludingReply(policy: ToolPermissionPolicy): boolean {
  const all = Object.values(policy.categoryDefaults)
  if (!all.every((v) => v === 'deny')) return false
  // No override allows Reply (the sentinel tool name is set on the server side;
  // on the client we check for any 'allow' override that could unlock reply).
  // Since Reply's tool name is server-side only, treat the reply category default
  // itself as the source of truth — if reply default is 'deny' AND no allow
  // override exists anywhere, the bot is effectively silenced.
  if (policy.overrides) {
    const anyAllow = Object.values(policy.overrides).some((v) => v === 'allow')
    if (anyAllow) return false
  }
  return policy.categoryDefaults.reply === 'deny'
}

interface SettingsPanelProps {
  onClose: () => void
}

type SettingsTab = 'general' | 'appearance' | 'workspace' | 'providers'

type WorkspaceSection = 'basic' | 'wecom' | 'feishu' | 'skills' | 'mcp' | 'hooks'

interface WorkspaceFormState {
  name: string
  description: string
  folderPath: string
  skills: { name: string }[]
  mcpServers: { name: string; command: string; args: string }[]
  hooks: { name: string; scriptPath: string }[]
  wecomBotId: string
  wecomBotSecret: string
  wecomBotEnabled: boolean
  wecomBotName: string
  wecomCorpId: string
  wecomCorpSecret: string
  wecomFilePromptTemplate: string
  wecomToolPermissions: ToolPermissionPolicy | undefined
  wecomBotIsolation: WeComBotIsolationSettings
  promptHistoryRetentionDays: string
  feishuAppId: string
  feishuAppSecret: string
  feishuEncryptKey: string
  feishuVerificationToken: string
  feishuBotEnabled: boolean
  feishuBotName: string
  feishuAdminUserIds: string[]
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
    wecomBotId: (workspace.settings?.wecomBotId as string) || '',
    wecomBotSecret: (workspace.settings?.wecomBotSecret as string) || '',
    wecomBotEnabled: (workspace.settings?.wecomBotEnabled as boolean) || false,
    wecomBotName: (workspace.settings?.wecomBotName as string) || '',
    wecomCorpId: (workspace.settings?.wecomCorpId as string) || '',
    wecomCorpSecret: (workspace.settings?.wecomCorpSecret as string) || '',
    wecomFilePromptTemplate: (workspace.settings?.wecomFilePromptTemplate as string) || '',
    wecomToolPermissions: workspace.settings?.wecomToolPermissions as ToolPermissionPolicy | undefined,
    wecomBotIsolation: (workspace.settings?.wecomBotIsolation as WeComBotIsolationSettings | undefined) ?? { ...DEFAULT_ISOLATION_SETTINGS },
    promptHistoryRetentionDays: String(workspace.settings?.promptHistoryRetentionDays ?? 30),
    feishuAppId: (workspace.settings?.feishuAppId as string) || '',
    feishuAppSecret: (workspace.settings?.feishuAppSecret as string) || '',
    feishuEncryptKey: (workspace.settings?.feishuEncryptKey as string) || '',
    feishuVerificationToken: (workspace.settings?.feishuVerificationToken as string) || '',
    feishuBotEnabled: (workspace.settings?.feishuBotEnabled as boolean) || false,
    feishuBotName: (workspace.settings?.feishuBotName as string) || '',
    feishuAdminUserIds: (workspace.settings?.feishuAdminUserIds as string[] | undefined) ?? [],
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
  const [showAllDeniedConfirm, setShowAllDeniedConfirm] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  // App-level form state
  const [appReopen, setAppReopen] = useState(reopenLastWorkspace)
  const [appModifierSubmit, setAppModifierSubmit] = useState(useModifierToSubmit)
  const [appAutoCheckUpdates, setAppAutoCheckUpdates] = useState(autoCheckUpdates)
  const [appNotificationSounds, setAppNotificationSounds] = useState(notificationSoundsEnabled)
  const [appNotificationSoundsVolume, setAppNotificationSoundsVolume] = useState(notificationSoundsVolume)
  const [windowCapInput, setWindowCapInput] = useState(String(windowCap))
  const [archiveThresholdDaysInput, setArchiveThresholdDaysInput] = useState(String(archiveThresholdDays))

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
      activeTab !== 'providers'
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

  const isDirty = useCallback(() => {
    if (appReopen !== snapshotRef.current.appReopen) return true
    if (appModifierSubmit !== snapshotRef.current.appModifierSubmit) return true
    if (appAutoCheckUpdates !== snapshotRef.current.appAutoCheckUpdates) return true
    if (appNotificationSounds !== snapshotRef.current.appNotificationSounds) return true
    if (appNotificationSoundsVolume !== snapshotRef.current.appNotificationSoundsVolume) return true
    if (windowCap !== snapshotRef.current.appWindowCap) return true
    if (archiveThresholdDays !== snapshotRef.current.appArchiveThresholdDays) return true
    return JSON.stringify(workspaceState) !== JSON.stringify(snapshotRef.current.workspaceState)
  }, [appReopen, appModifierSubmit, appAutoCheckUpdates, appNotificationSounds, appNotificationSoundsVolume, windowCap, archiveThresholdDays, workspaceState])

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

  const handleSave = async (opts?: { bypassAllDeniedCheck?: boolean }) => {
    // Save-time warning: if the workspace's policy denies every category
    // including Reply, the bot becomes a silent failure (R11/AE6). Confirm
    // before persisting so the admin can't accidentally lock the bot out.
    if (!opts?.bypassAllDeniedCheck && selectedWorkspaceId && workspaceState[selectedWorkspaceId]) {
      const ws = workspaceState[selectedWorkspaceId]
      if (ws.wecomToolPermissions && isAllDeniedIncludingReply(ws.wecomToolPermissions)) {
        setShowAllDeniedConfirm(true)
        return
      }
    }

    setIsSaving(true)

    // Save app settings
    setReopenLastWorkspace(appReopen)
    setUseModifierToSubmit(appModifierSubmit)
    setAutoCheckUpdates(appAutoCheckUpdates)
    setNotificationSoundsEnabled(appNotificationSounds)
    setNotificationSoundsVolume(appNotificationSoundsVolume)
    const parsedCap = parseInt(windowCapInput, 10)
    if (!isNaN(parsedCap)) {
      setWindowCap(parsedCap)
    }
    const parsedArchiveThreshold = parseInt(archiveThresholdDaysInput, 10)
    const nextArchiveThresholdDays = !isNaN(parsedArchiveThreshold) && parsedArchiveThreshold > 0
      ? parsedArchiveThreshold
      : archiveThresholdDays
    if (nextArchiveThresholdDays !== archiveThresholdDays) {
      setArchiveThresholdDays(nextArchiveThresholdDays)
    }

    // Save workspace settings for selected workspace
    if (selectedWorkspaceId && workspaceState[selectedWorkspaceId]) {
      const ws = workspaceState[selectedWorkspaceId]
      const parsedRetention = parseInt(ws.promptHistoryRetentionDays, 10)
      const promptHistoryRetentionDays = !isNaN(parsedRetention) ? parsedRetention : 30
      await updateWorkspace(selectedWorkspaceId, {
        name: ws.name,
        description: ws.description,
        settings: {
          ...selectedWorkspace?.settings,
          wecomBotId: ws.wecomBotId || undefined,
          wecomBotSecret: ws.wecomBotSecret || undefined,
          wecomBotEnabled: ws.wecomBotEnabled,
          wecomBotName: ws.wecomBotName || undefined,
          wecomCorpId: ws.wecomCorpId || undefined,
          wecomCorpSecret: ws.wecomCorpSecret || undefined,
          wecomFilePromptTemplate: ws.wecomFilePromptTemplate || undefined,
          wecomToolPermissions: ws.wecomToolPermissions,
          wecomBotIsolation: ws.wecomBotIsolation,
          promptHistoryRetentionDays,
          feishuAppId: ws.feishuAppId || undefined,
          feishuAppSecret: ws.feishuAppSecret || undefined,
          feishuEncryptKey: ws.feishuEncryptKey || undefined,
          feishuVerificationToken: ws.feishuVerificationToken || undefined,
          feishuBotEnabled: ws.feishuBotEnabled,
          feishuBotName: ws.feishuBotName || undefined,
          feishuAdminUserIds: ws.feishuAdminUserIds,
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
      appReopen,
      appModifierSubmit,
      appAutoCheckUpdates,
      appNotificationSounds,
      appNotificationSoundsVolume,
      appWindowCap: windowCap,
      appArchiveThresholdDays: nextArchiveThresholdDays,
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
    setAppReopen(snapshotRef.current.appReopen)
    setAppModifierSubmit(snapshotRef.current.appModifierSubmit)
    setAppAutoCheckUpdates(snapshotRef.current.appAutoCheckUpdates)
    setAppNotificationSounds(snapshotRef.current.appNotificationSounds)
    setAppNotificationSoundsVolume(snapshotRef.current.appNotificationSoundsVolume)
    setWindowCapInput(String(snapshotRef.current.appWindowCap))
    setArchiveThresholdDaysInput(String(snapshotRef.current.appArchiveThresholdDays))
    setWorkspaceState(JSON.parse(JSON.stringify(snapshotRef.current.workspaceState)))
    onClose()
  }

  const handleDiscard = () => {
    setAppReopen(snapshotRef.current.appReopen)
    setAppModifierSubmit(snapshotRef.current.appModifierSubmit)
    setAppAutoCheckUpdates(snapshotRef.current.appAutoCheckUpdates)
    setAppNotificationSounds(snapshotRef.current.appNotificationSounds)
    setAppNotificationSoundsVolume(snapshotRef.current.appNotificationSoundsVolume)
    setWindowCapInput(String(snapshotRef.current.appWindowCap))
    setArchiveThresholdDaysInput(String(snapshotRef.current.appArchiveThresholdDays))
    setWorkspaceState(JSON.parse(JSON.stringify(snapshotRef.current.workspaceState)))
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
              />
            )}

            {activeTab === 'appearance' && <AppearanceTab />}

            {activeTab === 'providers' && <ProviderSection />}

            {isWorkspaceTab && (
              <WorkspaceTabShell
                workspaces={workspaces}
                selectedWorkspaceId={selectedWorkspaceId}
                onSelectWorkspace={setSelectedWorkspaceId}
                workspaceState={selectedWorkspaceId ? workspaceState[selectedWorkspaceId] : null}
                onUpdateWorkspace={updateSelectedWorkspace}
                onSave={handleSave}
                onDelete={handleOpenDeleteDialog}
              />
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-border/50 flex-shrink-0">
            <div className="text-[11px] text-text-tertiary">
              {storeError ? (
                <span className="text-destructive">{storeError}</span>
              ) : (
                isDirty() && t('unsavedDialog.message')
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                {t('actions.cancel')}
              </button>
              <button
                onClick={() => handleSave()}
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
        <div className="fixed top-11 inset-x-0 bottom-0 z-[60] flex items-center justify-center">
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
                onClick={() => handleSave()}
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

      {/* All-Denied-Including-Reply Confirmation Dialog (R11/AE6) */}
      {showAllDeniedConfirm && (
        <div
          className="fixed top-11 inset-x-0 bottom-0 z-[61] flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="all-denied-dialog-title"
        >
          <div
            className="absolute inset-0 bg-overlay/60 backdrop-blur-sm"
            onClick={() => setShowAllDeniedConfirm(false)}
          />
          <div className="relative bg-surface border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <h3 id="all-denied-dialog-title" className="text-sm font-medium text-text-primary">
                  {t('wecom.saveWarning.title')}
                </h3>
                <p className="text-xs text-text-secondary mt-1">{t('wecom.saveWarning.body')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                autoFocus
                onClick={() => setShowAllDeniedConfirm(false)}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                {t('wecom.saveWarning.cancel')}
              </button>
              <button
                onClick={() => {
                  setShowAllDeniedConfirm(false)
                  handleSave({ bypassAllDeniedCheck: true })
                }}
                disabled={isSaving}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-destructive hover:bg-destructive/90 disabled:opacity-50 text-destructive-foreground rounded-lg transition-colors"
              >
                {t('wecom.saveWarning.saveAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}

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
    <div className="p-6 max-w-xl">
      <div className="space-y-5">
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
  onSave,
  onDelete,
}: {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
  onSelectWorkspace: (id: string) => void
  workspaceState: WorkspaceFormState | null
  onUpdateWorkspace: (updates: Partial<WorkspaceFormState>) => void
  onSave: () => Promise<void>
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('basic')
  const [showSkillsPage, setShowSkillsPage] = useState(false)

  // Reset to Basic Info when switching workspaces
  useEffect(() => {
    setActiveSection('basic')
  }, [selectedWorkspaceId])

  if (workspaces.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-text-tertiary">{t('workspaceSwitcher.noWorkspaces')}</p>
      </div>
    )
  }

  const sections: { id: WorkspaceSection; label: string }[] = [
    { id: 'basic', label: t('workspaceSections.basic') },
    { id: 'wecom', label: t('workspaceSections.wecom') },
    { id: 'feishu', label: t('workspaceSections.feishu') },
    { id: 'skills', label: t('workspaceSections.skills') },
    { id: 'mcp', label: t('workspaceSections.mcp') },
    { id: 'hooks', label: t('workspaceSections.hooks') },
  ]

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
              {activeSection === 'basic' && (
                <BasicInfoSection state={workspaceState} onUpdate={onUpdateWorkspace} onDelete={onDelete} />
              )}
              {activeSection === 'wecom' && (
                <WeComBotSection state={workspaceState} onUpdate={onUpdateWorkspace} workspaceId={selectedWorkspaceId!} onSave={onSave} />
              )}
              {activeSection === 'feishu' && (
                <FeishuBotSection state={workspaceState} onUpdate={onUpdateWorkspace} workspaceId={selectedWorkspaceId!} />
              )}
              {activeSection === 'skills' && (
                <SkillsRedirectCard onOpen={() => setShowSkillsPage(true)} />
              )}
              {activeSection === 'mcp' && <PluginRedirectPlaceholder type="mcp" />}
              {activeSection === 'hooks' && <PluginRedirectPlaceholder type="hooks" />}
            </>
          )}
        </div>
      </div>

      {showSkillsPage && selectedWorkspaceId && (
        <SkillsPage
          workspaceId={selectedWorkspaceId}
          onClose={() => setShowSkillsPage(false)}
        />
      )}
    </div>
  )
}

function BasicInfoSection({
  state,
  onUpdate,
  onDelete,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="max-w-xl space-y-4">
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

      {/* Danger zone */}
      <div className="pt-4 border-t border-border/50">
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

interface WeComWorkspaceUser {
  encryptedUserId: string
  plaintextUserId?: string
  firstSeenAt: string
  lastSeenAt: string
}

type WeComSubTab = 'connection' | 'users' | 'prompts' | 'permissions' | 'isolation' | 'queue'

type FeishuSubTab = 'connection' | 'users'

interface FeishuWorkspaceUser {
  openId: string
  userId?: string
  name?: string
  firstSeenAt: string
  lastSeenAt: string
  namePending: boolean
}

export function FeishuBotSection({
  state,
  onUpdate,
  workspaceId,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
  workspaceId: string
}) {
  const { t } = useTranslation('settings')
  const [activeSubTab, setActiveSubTab] = useState<FeishuSubTab>('connection')
  const [showAppSecret, setShowAppSecret] = useState(false)
  const [showEncryptKey, setShowEncryptKey] = useState(false)
  const [showVerificationToken, setShowVerificationToken] = useState(false)
  const [status, setStatus] = useState<string>('unknown')
  const [newAdminId, setNewAdminId] = useState('')
  const [users, setUsers] = useState<FeishuWorkspaceUser[]>([])
  const [isLoadingUsers, setIsLoadingUsers] = useState(false)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [usersRetryCount, setUsersRetryCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/feishu/status`)
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

  // Reset sub-tab and users state when the selected workspace changes.
  useEffect(() => {
    setActiveSubTab('connection')
    setUsers([])
    setUsersError(null)
    setUsersRetryCount(0)
  }, [workspaceId])

  // Fetch and poll the Feishu workspace user directory.
  useEffect(() => {
    if (activeSubTab !== 'users') return

    let cancelled = false
    const fetchUsers = async () => {
      setIsLoadingUsers(true)
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/feishu/users`)
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const data = (await res.json()) as { users?: FeishuWorkspaceUser[] }
        if (!cancelled) {
          setUsers(data.users || [])
          setUsersError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setUsersError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setIsLoadingUsers(false)
      }
    }

    fetchUsers()
    const interval = setInterval(fetchUsers, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceId, activeSubTab, usersRetryCount])

  const statusColor =
    status === 'connected'
      ? 'text-success'
      : status === 'error'
        ? 'text-destructive'
        : 'text-text-tertiary'

  const addAdminId = () => {
    const value = newAdminId.trim()
    if (!value || state.feishuAdminUserIds.includes(value)) return
    onUpdate({ feishuAdminUserIds: [...state.feishuAdminUserIds, value] })
    setNewAdminId('')
  }

  const removeAdminId = (value: string) => {
    onUpdate({ feishuAdminUserIds: state.feishuAdminUserIds.filter((id) => id !== value) })
  }

  const subTabs: { id: FeishuSubTab; label: string }[] = [
    { id: 'connection', label: t('feishu.tabs.connection') },
    { id: 'users', label: t('feishu.tabs.users') },
  ]

  return (
    <div className="space-y-0">
      <div className="flex border-b border-border/50 flex-shrink-0 -mx-6 px-6">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id)}
            className={`py-2 px-3 text-[11px] font-medium transition-all ${
              activeSubTab === tab.id
                ? 'text-text-primary border-b-2 border-accent'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'connection' && (
        <div className="max-w-xl space-y-4 pt-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <label className="block text-xs font-medium text-text-secondary">
                {t('feishu.enableBot')}
              </label>
              <p className="text-[10px] text-text-tertiary mt-0.5">{t('feishu.enableBotHint')}</p>
            </div>
            <button
              onClick={() => onUpdate({ feishuBotEnabled: !state.feishuBotEnabled })}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                state.feishuBotEnabled ? 'bg-accent' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  state.feishuBotEnabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('feishu.botName')}</label>
            <input
              value={state.feishuBotName}
              onChange={(e) => onUpdate({ feishuBotName: e.target.value })}
              placeholder={t('feishu.botNamePlaceholder')}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <p className="text-[10px] text-text-tertiary mt-1">{t('feishu.botNameHint')}</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('feishu.appId')}</label>
            <input
              value={state.feishuAppId}
              onChange={(e) => onUpdate({ feishuAppId: e.target.value })}
              placeholder={t('feishu.appIdPlaceholder')}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('feishu.appSecret')}</label>
            <div className="flex gap-2">
              <input
                type={showAppSecret ? 'text' : 'password'}
                value={state.feishuAppSecret}
                onChange={(e) => onUpdate({ feishuAppSecret: e.target.value })}
                placeholder={t('feishu.appSecretPlaceholder')}
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                onClick={() => setShowAppSecret(!showAppSecret)}
                className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
              >
                {showAppSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('feishu.encryptKey')}</label>
            <div className="flex gap-2">
              <input
                type={showEncryptKey ? 'text' : 'password'}
                value={state.feishuEncryptKey}
                onChange={(e) => onUpdate({ feishuEncryptKey: e.target.value })}
                placeholder={t('feishu.encryptKeyPlaceholder')}
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                onClick={() => setShowEncryptKey(!showEncryptKey)}
                className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
              >
                {showEncryptKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('feishu.verificationToken')}</label>
            <div className="flex gap-2">
              <input
                type={showVerificationToken ? 'text' : 'password'}
                value={state.feishuVerificationToken}
                onChange={(e) => onUpdate({ feishuVerificationToken: e.target.value })}
                placeholder={t('feishu.verificationTokenPlaceholder')}
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                onClick={() => setShowVerificationToken(!showVerificationToken)}
                className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
              >
                {showVerificationToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('feishu.adminUsers.label')}</label>
            <p className="text-[10px] text-text-tertiary mb-2">{t('feishu.adminUsers.hint')}</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {state.feishuAdminUserIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-bg border border-border rounded"
                >
                  <code className="font-mono text-text-secondary">{id}</code>
                  <button
                    type="button"
                    onClick={() => removeAdminId(id)}
                    className="text-text-tertiary hover:text-destructive"
                    aria-label={t('feishu.adminUsers.remove')}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newAdminId}
                onChange={(e) => setNewAdminId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addAdminId()
                  }
                }}
                placeholder={t('feishu.adminUsers.placeholder')}
                className="flex-1 px-3 py-1.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                type="button"
                onClick={addAdminId}
                className="px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
              >
                {t('feishu.adminUsers.add')}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <span className="text-[11px] font-medium text-text-secondary">{t('feishu.status')}</span>
            <span className={`text-[11px] font-medium capitalize ${statusColor}`}>{status}</span>
          </div>

          <div className="text-[10px] text-text-tertiary pt-2">
            <p>{t('feishu.botSessionNote')}</p>
          </div>
        </div>
      )}

      {activeSubTab === 'users' && (
        <div className="max-w-xl pt-4">
          <h3 className="text-xs font-medium text-text-secondary mb-3">{t('feishu.usersTitle')}</h3>

          {isLoadingUsers && users.length === 0 && (
            <p className="text-[11px] text-text-tertiary">{t('feishu.usersLoading')}</p>
          )}

          {usersError && (
            <div className="space-y-2">
              <p className="text-[11px] text-destructive">
                {t('feishu.usersError')}: {usersError}
              </p>
              <button
                type="button"
                onClick={() => setUsersRetryCount((c) => c + 1)}
                className="px-3 py-1.5 text-[11px] font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
              >
                {t('feishu.usersRetry')}
              </button>
            </div>
          )}

          {!isLoadingUsers && !usersError && users.length === 0 && (
            <p className="text-[11px] text-text-tertiary">{t('feishu.usersEmpty')}</p>
          )}

          {users.length > 0 && (
            <div className="space-y-2">
              {users.map((user) => (
                <div
                  key={user.openId}
                  className="px-3 py-2.5 bg-bg rounded-lg border border-border/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {user.name || user.openId}
                    </span>
                    {user.namePending && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                        {t('feishu.userPending')}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-text-tertiary mt-1 break-all">
                    {user.openId}
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="text-[10px] text-text-tertiary">
                      {t('feishu.firstSeen')}: {new Date(user.firstSeenAt).toLocaleString()}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {t('feishu.lastSeen')}: {new Date(user.lastSeenAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function WeComBotSection({
  state,
  onUpdate,
  workspaceId,
  onSave,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
  workspaceId: string
  onSave: () => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const [activeSubTab, setActiveSubTab] = useState<WeComSubTab>('connection')
  const [showSecret, setShowSecret] = useState(false)
  const [showCorpSecret, setShowCorpSecret] = useState(false)
  const [status, setStatus] = useState<string>('unknown')
  const [users, setUsers] = useState<WeComWorkspaceUser[]>([])
  const [usersIsLoading, setUsersIsLoading] = useState(false)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [usersRetryCount, setUsersRetryCount] = useState(0)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [draftPlaintext, setDraftPlaintext] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveResult, setResolveResult] = useState<{ resolved: number; failed: number } | null>(null)

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

  // Reset users state when the selected workspace changes.
  useEffect(() => {
    setUsers([])
    setUsersError(null)
    setUsersRetryCount(0)
    setEditingUserId(null)
    setDraftPlaintext('')
    setEditError(null)
    setResolveResult(null)
  }, [workspaceId])

  // Fetch and poll WeCom workspace users.
  useEffect(() => {
    if (activeSubTab !== 'users') return

    let cancelled = false
    const fetchUsers = async () => {
      setUsersIsLoading(true)
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/wecom/users`)
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const data = (await res.json()) as { users?: WeComWorkspaceUser[] }
        if (!cancelled) {
          setUsers(data.users || [])
          setUsersError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setUsersError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setUsersIsLoading(false)
      }
    }

    fetchUsers()
    const interval = setInterval(fetchUsers, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspaceId, activeSubTab, usersRetryCount])

  const handleReloadUsers = () => {
    setUsersRetryCount((c) => c + 1)
  }

  const handleResolvePending = async () => {
    setResolveBusy(true)
    setResolveResult(null)
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/wecom/resolve-pending`, {
        method: 'POST',
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const result = (await res.json()) as { resolved: number; failed: number }
      setResolveResult(result)
      // Refresh the user list so any newly resolved IDs appear.
      setUsersRetryCount((c) => c + 1)
    } catch (err) {
      setResolveResult({ resolved: 0, failed: 0 })
    } finally {
      setResolveBusy(false)
    }
  }

  const startEdit = (user: WeComWorkspaceUser) => {
    setEditingUserId(user.encryptedUserId)
    setDraftPlaintext(user.plaintextUserId || '')
    setEditError(null)
  }

  const cancelEdit = () => {
    setEditingUserId(null)
    setDraftPlaintext('')
    setEditError(null)
  }

  const submitEdit = async (user: WeComWorkspaceUser) => {
    const trimmed = draftPlaintext.trim()
    if (!trimmed) {
      setEditError(t('wecom.userPlaintextRequired'))
      return
    }
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/wecom/users/${encodeURIComponent(user.encryptedUserId)}/plaintext`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plaintextUserId: trimmed }),
      })
      if (res.status === 409) {
        setEditError(t('wecom.userDuplicate'))
        return
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setUsers((prev) =>
        prev.map((u) =>
          u.encryptedUserId === user.encryptedUserId ? { ...u, plaintextUserId: trimmed } : u,
        ),
      )
      cancelEdit()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    }
  }

  const statusColor =
    status === 'connected'
      ? 'text-success'
      : status === 'error'
        ? 'text-destructive'
        : 'text-text-tertiary'

  const subTabs: { id: WeComSubTab; label: string }[] = [
    { id: 'connection', label: t('wecom.tabs.connection') },
    { id: 'users', label: t('wecom.tabs.users') },
    { id: 'prompts', label: t('wecom.tabs.prompts') },
    { id: 'permissions', label: t('wecom.tabs.permissions') },
    { id: 'isolation', label: t('wecom.tabs.isolation') },
    { id: 'queue', label: t('wecom.tabs.queue') },
  ]

  return (
    <div className="space-y-0">
      {/* Secondary tab bar */}
      <div className="flex border-b border-border/50 flex-shrink-0 -mx-6 px-6">
        {subTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id)}
            className={`py-2 px-3 text-[11px] font-medium transition-all ${
              activeSubTab === tab.id
                ? 'text-text-primary border-b-2 border-accent'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Connection tab */}
      {activeSubTab === 'connection' && (
        <div className="max-w-xl space-y-4 pt-4">
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
        </div>
      )}

      {/* Users tab */}
      {activeSubTab === 'users' && (
        <div className="max-w-xl pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-text-secondary">{t('wecom.usersTitle')}</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleReloadUsers}
                disabled={usersIsLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${usersIsLoading ? 'animate-spin' : ''}`} />
                {t('wecom.usersReload')}
              </button>
              <button
                type="button"
                onClick={handleResolvePending}
                disabled={resolveBusy || !state.wecomCorpId || !state.wecomCorpSecret}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
              >
                {resolveBusy ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {t('wecom.usersResolvePending')}
              </button>
            </div>
          </div>

          {(!state.wecomCorpId || !state.wecomCorpSecret) && (
            <p className="text-[11px] text-text-tertiary mb-3">{t('wecom.usersResolvePendingDisabled')}</p>
          )}

          {resolveResult && (
            <p className="text-[11px] text-text-secondary mb-3">
              {t('wecom.usersResolvePendingResult', {
                resolved: resolveResult.resolved,
                failed: resolveResult.failed,
              })}
            </p>
          )}

          {usersIsLoading && users.length === 0 && (
            <p className="text-[11px] text-text-tertiary">{t('wecom.usersLoading')}</p>
          )}

          {usersError && (
            <div className="space-y-2">
              <p className="text-[11px] text-destructive">
                {t('wecom.usersError')}: {usersError}
              </p>
              <button
                type="button"
                onClick={handleReloadUsers}
                className="px-3 py-1.5 text-[11px] font-medium bg-accent text-accent-foreground rounded hover:bg-accent-hover"
              >
                {t('wecom.usersRetry')}
              </button>
            </div>
          )}

          {!usersIsLoading && !usersError && users.length === 0 && (
            <p className="text-[11px] text-text-tertiary">{t('wecom.usersEmpty')}</p>
          )}

          {users.length > 0 && (
            <div className="space-y-2">
              {users.map((user) => {
                const isEditing = editingUserId === user.encryptedUserId
                return (
                  <div
                    key={user.encryptedUserId}
                    className="px-3 py-2.5 bg-bg rounded-lg border border-border/50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-text-primary">
                        {user.plaintextUserId || user.encryptedUserId}
                      </span>
                      {!user.plaintextUserId && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                          {t('wecom.userPending')}
                      </span>
                      )}
                    </div>
                    <div className="text-[10px] text-text-tertiary mt-1 break-all">
                      {t('wecom.userEncryptedId')}: {user.encryptedUserId}
                    </div>
                    <div className="flex items-center gap-4 mt-1">
                      <span className="text-[10px] text-text-tertiary">
                        {t('wecom.firstSeen')}: {new Date(user.firstSeenAt).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-text-tertiary">
                        {t('wecom.lastSeen')}: {new Date(user.lastSeenAt).toLocaleString()}
                      </span>
                    </div>
                    {isEditing ? (
                      <div className="mt-2 space-y-2">
                        <input
                          value={draftPlaintext}
                          onChange={(e) => {
                            setDraftPlaintext(e.target.value)
                            setEditError(null)
                          }}
                          placeholder={t('wecom.userPlaintextPlaceholder')}
                          className="w-full px-3 py-1.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                        />
                        {editError && <p className="text-[11px] text-destructive">{editError}</p>}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => submitEdit(user)}
                            className="px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded transition-colors"
                          >
                            {t('wecom.userSave')}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="px-3 py-1.5 text-[11px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded transition-colors"
                          >
                            {t('wecom.userCancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(user)}
                        className="mt-2 text-[11px] text-accent hover:text-accent-hover underline underline-offset-2"
                      >
                        {user.plaintextUserId ? t('wecom.userEdit') : t('wecom.userAddPlaintext')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Prompts tab */}
      {activeSubTab === 'prompts' && (
        <div className="max-w-xl space-y-4 pt-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('wecom.filePromptTemplate')}
            </label>
            <textarea
              value={state.wecomFilePromptTemplate}
              onChange={(e) => onUpdate({ wecomFilePromptTemplate: e.target.value })}
              placeholder={t('wecom.filePromptTemplatePlaceholder')}
              rows={4}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('wecom.filePromptTemplateHint')}
            </p>
          </div>
        </div>
      )}

      {/* Permissions tab */}
      {activeSubTab === 'permissions' && (
        <div className="max-w-xl">
          <PermissionsSubTab
            policy={state.wecomToolPermissions}
            onUpdate={(next) => onUpdate({ wecomToolPermissions: next })}
            workspaceId={workspaceId}
            needsUpgradePrompt={!state.wecomToolPermissions && state.wecomBotEnabled}
            onApplySafePreset={async () => {
              onUpdate({ wecomToolPermissions: SAFE_PRESET })
              await onSave()
            }}
          />
        </div>
      )}

      {/* Isolation tab */}
      {activeSubTab === 'isolation' && (
        <IsolationSubTab
          isolation={state.wecomBotIsolation}
          onUpdate={(next) => onUpdate({ wecomBotIsolation: next })}
        />
      )}

      {/* Queue tab */}
      {activeSubTab === 'queue' && (
        <WeComQueuePanel workspaceId={workspaceId} botEnabled={state.wecomBotEnabled} />
      )}
    </div>
  )
}

function PluginRedirectPlaceholder({ type }: { type: 'skills' | 'mcp' | 'hooks' }) {
  const { t } = useTranslation('settings')
  return (
    <div className="max-w-xl flex flex-col items-center justify-center h-full min-h-[200px] text-center space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-text-primary">{t(`placeholder.${type}Title`)}</h3>
        <p className="text-xs text-text-secondary max-w-sm">{t('placeholder.pluginRedirect')}</p>
      </div>
    </div>
  )
}

/**
 * Card shown in the workspace-settings Skills tab. The new Skills page is a
 * top-level surface, so this card is a launcher — clicking Open mounts the
 * SkillsPage overlay (with the active workspace context).
 */
function SkillsRedirectCard({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="max-w-xl flex flex-col items-center justify-center h-full min-h-[200px] text-center space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-text-primary">{t('placeholder.skillsTitle')}</h3>
        <p className="text-xs text-text-secondary max-w-sm">
          {t('placeholder.skillsRedirect', 'The Skills page is now available as a top-level surface in the session list. Click below to open it for this workspace.')}
        </p>
      </div>
      <button
        onClick={onOpen}
        className="px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
      >
        {t('skills.openFromSettings', 'Open Skills page')}
      </button>
    </div>
  )
}

