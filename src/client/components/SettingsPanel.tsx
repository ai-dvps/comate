import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTheme } from '../hooks/use-theme'
import { useAppSettings } from '../hooks/use-app-settings'
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

type SettingsTab = 'general' | 'appearance' | 'workspace' | 'skills' | 'mcp' | 'hooks' | 'wecom'

interface WorkspaceFormState {
  name: string
  description: string
  model: string
  apiKey: string
  skills: { name: string }[]
  mcpServers: { name: string; command: string; args: string }[]
  hooks: { name: string; scriptPath: string }[]
  wecomBotId: string
  wecomBotSecret: string
  wecomBotEnabled: boolean
}

function buildWorkspaceFormState(workspace: Workspace): WorkspaceFormState {
  return {
    name: workspace.name,
    description: workspace.description,
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
  }
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
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
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'workspace', label: 'Workspace' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP' },
    { id: 'hooks', label: 'Hooks' },
    { id: 'wecom', label: 'WeCom Bot' },
  ]

  const isWorkspaceTab = activeTab === 'workspace' || activeTab === 'skills' || activeTab === 'mcp' || activeTab === 'hooks' || activeTab === 'wecom'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 flex-shrink-0 border-b border-border/50">
        <h2 className="text-sm font-medium text-text-primary">Settings</h2>
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
      <div className="flex-1 overflow-hidden">
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
          {isDirty() && 'You have unsaved changes'}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !isDirty()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
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
                <h3 className="text-sm font-medium text-text-primary">Unsaved changes</h3>
                <p className="text-xs text-text-secondary mt-1">
                  You have unsaved changes. Save them before closing?
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
                Keep editing
              </button>
              <button
                onClick={handleDiscard}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? 'Saving...' : 'Save changes'}
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
  return (
    <div className="p-6 max-w-xl">
      <div className="space-y-5">
        <WeComCliSection />
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Default Model
          </label>
          <input
            value={defaultModel}
            onChange={(e) => onDefaultModelChange(e.target.value)}
            placeholder="e.g. claude-sonnet-4-5-20250929"
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <p className="text-[10px] text-text-tertiary mt-1">
            Leave empty to use the system default model.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">
            Message Window Cap
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
            Max messages kept in memory per session (50–1000). Older messages are pruned but can be re-fetched by scrolling up.
          </p>
        </div>

        <div className="flex items-center justify-between py-3 border-t border-border/50">
          <div>
            <label className="block text-xs font-medium text-text-secondary">
              Reopen last workspace on launch
            </label>
            <p className="text-[10px] text-text-tertiary mt-0.5">
              Automatically restore the last active workspace when the app starts.
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

  return (
    <div className="p-6 max-w-xl">
      <div className="space-y-5">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">Theme</label>
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
              Light
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
              Dark
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Monitor className="w-3 h-3 text-text-tertiary" />
            <span className="text-[11px] text-text-tertiary">
              {isFollowingSystem ? 'Following system preference' : 'Manual selection'}
            </span>
            {!isFollowingSystem && (
              <button
                onClick={resetToSystem}
                className="text-[11px] text-accent hover:text-accent-hover underline underline-offset-2"
              >
                Reset to system
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function WeComCliSection() {
  const [status, setStatus] = useState<{ installed: boolean; path?: string; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/cli/status')
      if (!res.ok) return
      const data = await res.json()
      setStatus(data)
    } catch {
      setStatus({ installed: false, error: 'Failed to check status' })
    }
  }, [])

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
      setStatus({ installed: false, error: 'Install request failed' })
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
      setStatus({ installed: false, error: 'Uninstall request failed' })
    }
    setLoading(false)
  }

  const isInstalled = status?.installed

  return (
    <div className="py-3 border-b border-border/50">
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-xs font-medium text-text-secondary">WeCom CLI</label>
          <p className="text-[10px] text-text-tertiary mt-0.5">
            Make the <code className="text-[10px] font-mono bg-surface-hover px-1 rounded">wecom</code> command available in your terminal.
          </p>
        </div>
        {isInstalled ? (
          <button
            onClick={handleUninstall}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {loading ? 'Working...' : 'Uninstall'}
          </button>
        ) : (
          <button
            onClick={handleInstall}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground transition-colors disabled:opacity-50"
          >
            {loading ? 'Installing...' : 'Install'}
          </button>
        )}
      </div>

      {status?.error && (
        <p className="text-[11px] text-destructive mt-2">{status.error}</p>
      )}

      {isInstalled && status?.path && (
        <p className="text-[11px] text-success mt-2">
          Installed at <code className="font-mono bg-surface-hover px-1 rounded">{status.path}</code>
        </p>
      )}

      {isInstalled && (
        <p className="text-[10px] text-text-tertiary mt-1.5">
          Make sure <code className="font-mono bg-surface-hover px-1 rounded">~/.local/bin</code> is on your PATH. You may need to restart your terminal or run <code className="font-mono bg-surface-hover px-1 rounded">hash -r</code> for the shell to discover the command.
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
  activeTab: 'workspace' | 'skills' | 'mcp' | 'hooks' | 'wecom'
  workspaceState: WorkspaceFormState | null
  onUpdateWorkspace: (updates: Partial<WorkspaceFormState>) => void
}) {
  if (workspaces.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-text-tertiary">No workspaces yet</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Left column: workspace list */}
      <div className="w-64 border-r border-border/50 flex-shrink-0 overflow-y-auto">
        <div className="p-3">
          <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-2 px-2">
            Workspaces
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
            <p className="text-sm text-text-tertiary">Select a workspace</p>
          </div>
        ) : (
          <>
            {activeTab === 'workspace' && (
              <WorkspaceDetailsTab state={workspaceState} onUpdate={onUpdateWorkspace} />
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
            {activeTab === 'wecom' && selectedWorkspaceId && (
              <WeComBotTab state={workspaceState} onUpdate={onUpdateWorkspace} workspaceId={selectedWorkspaceId} />
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
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  const [showApiKey, setShowApiKey] = useState(false)

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Name</label>
        <input
          value={state.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Description</label>
        <textarea
          value={state.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          rows={3}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary resize-none"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Model Override</label>
        <input
          value={state.model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          placeholder="e.g. claude-sonnet-4-5-20250929"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <p className="text-[10px] text-text-tertiary mt-1">Leave empty to use the default model.</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">API Key</label>
        <div className="flex gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={state.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder="sk-ant-..."
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
          Stored locally. Falls back to environment variable if empty.
        </p>
      </div>
    </div>
  )
}

function SkillsTab({
  state,
  onUpdate,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  const [newSkill, setNewSkill] = useState('')

  const addSkill = () => {
    const trimmed = newSkill.trim()
    if (!trimmed) return
    onUpdate({ skills: [...state.skills, { name: trimmed }] })
    setNewSkill('')
  }

  return (
    <div className="space-y-3 max-w-xl">
      <div className="flex gap-2">
        <input
          value={newSkill}
          onChange={(e) => setNewSkill(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSkill()
          }}
          placeholder="Skill name"
          className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <button
          onClick={addSkill}
          className="p-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <div className="space-y-1">
        {state.skills.map((skill, i) => (
          <div
            key={i}
            className="flex items-center justify-between px-3 py-2 bg-bg rounded-lg border border-border/50"
          >
            <span className="text-sm text-text-primary">{skill.name}</span>
            <button
              onClick={() =>
                onUpdate({ skills: state.skills.filter((_, idx) => idx !== i) })
              }
              className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {state.skills.length === 0 && (
          <p className="text-xs text-text-tertiary text-center py-4">No skills added</p>
        )}
      </div>
    </div>
  )
}

function McpTab({
  state,
  onUpdate,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  const [newMcpName, setNewMcpName] = useState('')
  const [newMcpCommand, setNewMcpCommand] = useState('')
  const [newMcpArgs, setNewMcpArgs] = useState('')

  const addMcp = () => {
    const name = newMcpName.trim()
    const command = newMcpCommand.trim()
    if (!name || !command) return
    onUpdate({
      mcpServers: [
        ...state.mcpServers,
        { name, command, args: newMcpArgs },
      ],
    })
    setNewMcpName('')
    setNewMcpCommand('')
    setNewMcpArgs('')
  }

  return (
    <div className="space-y-3 max-w-xl">
      <div className="space-y-2">
        <input
          value={newMcpName}
          onChange={(e) => setNewMcpName(e.target.value)}
          placeholder="Server name"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <input
          value={newMcpCommand}
          onChange={(e) => setNewMcpCommand(e.target.value)}
          placeholder="Command (e.g. node)"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <input
          value={newMcpArgs}
          onChange={(e) => setNewMcpArgs(e.target.value)}
          placeholder="Arguments (space-separated)"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <button
          onClick={addMcp}
          className="w-full py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Add MCP Server
        </button>
      </div>
      <div className="space-y-2">
        {state.mcpServers.map((mcp, i) => (
          <div
            key={i}
            className="px-3 py-2.5 bg-bg rounded-lg border border-border/50 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">{mcp.name}</span>
              <button
                onClick={() =>
                  onUpdate({
                    mcpServers: state.mcpServers.filter((_, idx) => idx !== i),
                  })
                }
                className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-[11px] text-text-tertiary font-mono">
              {mcp.command} {mcp.args}
            </div>
          </div>
        ))}
        {state.mcpServers.length === 0 && (
          <p className="text-xs text-text-tertiary text-center py-4">No MCP servers added</p>
        )}
      </div>
    </div>
  )
}

function HooksTab({
  state,
  onUpdate,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
}) {
  const [newHookName, setNewHookName] = useState('')
  const [newHookPath, setNewHookPath] = useState('')

  const addHook = () => {
    const name = newHookName.trim()
    const path = newHookPath.trim()
    if (!name || !path) return
    onUpdate({
      hooks: [...state.hooks, { name, scriptPath: path }],
    })
    setNewHookName('')
    setNewHookPath('')
  }

  return (
    <div className="space-y-3 max-w-xl">
      <div className="space-y-2">
        <input
          value={newHookName}
          onChange={(e) => setNewHookName(e.target.value)}
          placeholder="Hook name"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <input
          value={newHookPath}
          onChange={(e) => setNewHookPath(e.target.value)}
          placeholder="Script path"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
        <button
          onClick={addHook}
          className="w-full py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-foreground text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Hook
        </button>
      </div>
      <div className="space-y-2">
        {state.hooks.map((hook, i) => (
          <div
            key={i}
            className="px-3 py-2.5 bg-bg rounded-lg border border-border/50 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">{hook.name}</span>
              <button
                onClick={() =>
                  onUpdate({
                    hooks: state.hooks.filter((_, idx) => idx !== i),
                  })
                }
                className="p-1 rounded hover:bg-destructive/10 text-text-tertiary hover:text-destructive transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-[11px] text-text-tertiary font-mono truncate">
              {hook.scriptPath}
            </div>
          </div>
        ))}
        {state.hooks.length === 0 && (
          <p className="text-xs text-text-tertiary text-center py-4">No hooks added</p>
        )}
      </div>
    </div>
  )
}

function WeComBotTab({
  state,
  onUpdate,
  workspaceId,
}: {
  state: WorkspaceFormState
  onUpdate: (updates: Partial<WorkspaceFormState>) => void
  workspaceId: string
}) {
  const [showSecret, setShowSecret] = useState(false)
  const [status, setStatus] = useState<string>('unknown')

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

  const statusColor =
    status === 'connected'
      ? 'text-success'
      : status === 'error'
        ? 'text-destructive'
        : 'text-text-tertiary'

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-center justify-between py-2 border-b border-border/50">
        <div>
          <label className="block text-xs font-medium text-text-secondary">
            Enable WeCom Bot
          </label>
          <p className="text-[10px] text-text-tertiary mt-0.5">
            When enabled, this workspace acts as a WeCom bot endpoint.
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
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Bot ID</label>
        <input
          value={state.wecomBotId}
          onChange={(e) => onUpdate({ wecomBotId: e.target.value })}
          placeholder="your-bot-id"
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Bot Secret</label>
        <div className="flex gap-2">
          <input
            type={showSecret ? 'text' : 'password'}
            value={state.wecomBotSecret}
            onChange={(e) => onUpdate({ wecomBotSecret: e.target.value })}
            placeholder="your-bot-secret"
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

      <div className="flex items-center gap-2 pt-2">
        <span className="text-[11px] font-medium text-text-secondary">Status:</span>
        <span className={`text-[11px] font-medium capitalize ${statusColor}`}>{status}</span>
      </div>

      <div className="text-[10px] text-text-tertiary pt-2">
        <p>Bot sessions have full tool auto-approval. Save changes to connect or disconnect.</p>
      </div>
    </div>
  )
}
