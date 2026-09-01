import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import comateIconUrl from '../../build/icon.png'
import { isWindowMaximized, onWindowMaximizedChange, showWindow } from './lib/desktop-api'
import { AlertCircle, File, GitBranch, GitCompare, Globe2, X } from 'lucide-react'
import { useSidebarWidth } from './hooks/use-sidebar-width'
import { useRightPanelWidth } from './hooks/use-right-panel-width'
import { deriveResponsiveShell, useViewportWidth } from './hooks/use-responsive-shell'
import { useSidebarKeyboardShortcut } from './hooks/use-sidebar-keyboard-shortcut'
import ChatPanel from './components/ChatPanel'
import ManagementWorkspace, { type ManagementDestination } from './components/ManagementWorkspace'
import { initNotificationClickHandler } from './lib/notifications'
import { openSessionDirect } from './lib/session-jump'
import { openFileWithNotice } from './lib/open-file-with-notice'
import ContextWorkspace from './components/ContextWorkspace'
import UsageLoginModal from './components/UsageLoginModal'
import CustomTitlebar from './components/CustomTitlebar'
import AgentCommandCenter from './components/AgentCommandCenter'
import NewChatPage from './components/NewChatPage'
import CreateWorkspaceModal from './components/CreateWorkspaceModal'
import ToastContainer from './components/ToastContainer'
import { useWorkspaceStore } from './stores/workspace-store'
import { useProviderStore } from './stores/provider-store'
import {
  newChatDraftSessionId,
  useChatStore,
  type ApprovalMode,
  type PromptTurnDraft,
} from './stores/chat-store'
import type { BackendId } from './stores/backend-store'
import { useContextTabStore } from './stores/context-tab-store'
import { selectSessionOpen, useBrowserPaneStore } from './stores/browser-pane-store'
import { useTheme } from './hooks/use-theme'
import { useAppSettings } from './hooks/use-app-settings'
import { isMacOS, isWindows } from './lib/platform'
import { useBadgeSync } from './lib/use-badge-sync'
import { useNotificationSounds } from './lib/use-notification-sounds'
import { cn } from './components/ui/utils'
import { startPeriodicUpdateChecks, stopPeriodicUpdateChecks } from './lib/updater-api'
import UpdateNotification from './components/UpdateNotification'
import UpdateRestartDialog from './components/UpdateRestartDialog'
import SandboxDegradedBanner from './components/SandboxDegradedBanner'
import { ToolRendererProvider } from './components/tool-renderers/ToolRendererContext'
import { useMigrationNotice } from './hooks/use-migration-notice'
import {
  watchDetachedBrowserPlacement,
} from './lib/detached-browser-api'

type AppDestination = ManagementDestination | 'new-chat' | null

interface GitCapability {
  isGitWorktree: boolean
  state: 'non-git' | 'unborn' | 'attached' | 'detached'
  branch: string | null
  ref: string | null
  headHash: string | null
}

function App() {
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  useTheme()
  useBadgeSync()
  useNotificationSounds()
  const { uiFontSize, autoCheckUpdates, setLastUpdateCheckAt, approvalMode } = useAppSettings()

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const openWorkspaceIds = useWorkspaceStore((s) => s.openWorkspaceIds)
  const fetchWorkspaces = useWorkspaceStore((s) => s.fetchWorkspaces)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const activeWorkspaceSessionId = useChatStore((s) =>
    activeWorkspaceId ? s.activeSessionIds[activeWorkspaceId] : undefined
  )
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const transferDraft = useChatStore((s) => s.transferDraft)
  const [activeDestination, setActiveDestination] = useState<AppDestination>(null)
  const [pendingDestination, setPendingDestination] = useState<AppDestination | undefined>(undefined)
  const [newChatSubmitting, setNewChatSubmitting] = useState(false)
  const [newChatError, setNewChatError] = useState<string | null>(null)
  const [newChatWorkspaceId, setNewChatWorkspaceId] = useState<string | null>(null)
  const newChatRequestGenerationRef = useRef(0)
  const newChatAbortControllerRef = useRef<AbortController | null>(null)
  const activePanel = activeDestination !== null && activeDestination !== 'new-chat'
    ? activeDestination
    : null
  const newChatOpen = activeDestination === 'new-chat'
  const newChatVisible = newChatOpen || (!activeWorkspace && activePanel === null)
  const [settingsCloseRequestToken, setSettingsCloseRequestToken] = useState(0)
  // Deep-link target: opening settings scoped to a specific workspace (sidebar
  // context menu). Cleared on generic opens and on panel close so the next
  // plain settings open falls back to the active workspace.
  const [settingsWorkspaceTargetId, setSettingsWorkspaceTargetId] = useState<string | null>(null)
  const requestDestination = useCallback((destination: AppDestination) => {
    if (activeDestination === 'settings' && destination !== 'settings') {
      setPendingDestination(destination)
      setSettingsCloseRequestToken((token) => token + 1)
      return false
    }
    setActiveDestination(destination)
    return true
  }, [activeDestination])
  const openPanel = useCallback((panel: ManagementDestination) => {
    if (panel === 'settings') setSettingsWorkspaceTargetId(null)
    return requestDestination(panel)
  }, [requestDestination])
  const openSettingsForWorkspace = useCallback((workspaceId: string) => {
    openPanel('settings')
    setSettingsWorkspaceTargetId(workspaceId)
  }, [openPanel])
  const closePanel = useCallback(() => {
    setActiveDestination(pendingDestination ?? null)
    setPendingDestination(undefined)
    setSettingsWorkspaceTargetId(null)
  }, [pendingDestination])
  const openNewChat = useCallback(() => {
    setNewChatError(null)
    setNewChatWorkspaceId(null)
    requestDestination('new-chat')
  }, [requestDestination])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [gitCapability, setGitCapability] = useState<{
    workspaceId: string
    value: GitCapability
  } | null>(null)
  const [isMac, setIsMac] = useState(false)
  const [isWin, setIsWin] = useState(false)
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [claudeCheck, setClaudeCheck] = useState<{ ok: boolean; checking: boolean; error?: string }>({
    ok: true,
    checking: true,
  })
  const [providerCheck, setProviderCheck] = useState<{ ok: boolean; checking: boolean; error?: string }>({
    ok: true,
    checking: true,
  })
  const [providerToastDismissed, setProviderToastDismissed] = useState(false)
  const { visible: migrationNoticeVisible, auditLogsCleared, dismiss: dismissMigrationNotice } = useMigrationNotice()

  const fetchProviders = useProviderStore((s) => s.fetchProviders)
  const detectProviders = useProviderStore((s) => s.detectProviders)

  const checkClaudeCli = async () => {
    try {
      const res = await fetch('/api/health/claude')
      if (!res.ok) {
        const data = await res.json()
        setClaudeCheck({ ok: false, checking: false, error: data.message || 'Claude CLI not available' })
        return
      }
      setClaudeCheck({ ok: true, checking: false })
    } catch {
      setClaudeCheck({ ok: false, checking: false, error: 'Claude CLI not available' })
    }
  }

  const initProviders = useCallback(async () => {
    try {
      await fetchProviders()
      const currentProviders = useProviderStore.getState().providers
      if (currentProviders.length === 0) {
        await detectProviders()
        const afterDetect = useProviderStore.getState().providers
        if (afterDetect.length === 0) {
          setProviderCheck({ ok: false, checking: false, error: t('provider.noProviderConfigured') })
          return
        }
      }
      setProviderCheck({ ok: true, checking: false })
    } catch {
      setProviderCheck({ ok: false, checking: false, error: t('provider.noProviderConfigured') })
    }
  }, [fetchProviders, detectProviders, t])

  // Scheduled-task desktop notification clicks jump to the run session (KTD-4).
  useEffect(() => {
    initNotificationClickHandler(openSessionDirect);
  }, []);

  useEffect(() => {
    fetchWorkspaces()
    checkClaudeCli()
    initProviders()
    isMacOS().then(setIsMac)
    isWindows().then(setIsWin)

    startPeriodicUpdateChecks(
      () => ({ autoCheckUpdates }),
      () => setLastUpdateCheckAt(new Date().toISOString())
    )
    return () => stopPeriodicUpdateChecks()
  }, [fetchWorkspaces, autoCheckUpdates, setLastUpdateCheckAt, initProviders])

  useEffect(() => {
    if (!isWin) {
      setWindowMaximized(false)
      return
    }

    let active = true
    let receivedWindowStateChange = false
    const stopListening = onWindowMaximizedChange((maximized) => {
      receivedWindowStateChange = true
      if (active) setWindowMaximized(maximized)
    })
    void isWindowMaximized().then((maximized) => {
      if (active && !receivedWindowStateChange) setWindowMaximized(maximized)
    })

    return () => {
      active = false
      stopListening()
    }
  }, [isWin])

  const handleForceShowWindow = useCallback(async () => {
    try {
      await showWindow()
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (providerCheck.ok) {
      setProviderToastDismissed(false)
    }
  }, [providerCheck.ok])

  const {
    expandedWidth: sidebarExpandedWidth,
    setWidth: setSidebarWidth,
    isCollapsed: isSidebarCollapsed,
    toggleCollapse: toggleSidebarCollapse,
  } = useSidebarWidth()

  const {
    expandedWidth: rightPanelExpandedWidth,
    setWidth: setRightPanelWidth,
    isCollapsed: isRightPanelCollapsed,
    toggleCollapse: toggleRightPanelCollapse,
  } = useRightPanelWidth()

  const viewportWidth = useViewportWidth()
  const [forcedExpandedSide, setForcedExpandedSide] = useState<'left' | 'right' | null>(null)
  const responsiveShell = deriveResponsiveShell({
    viewportWidth,
    leftWidth: sidebarExpandedWidth,
    rightWidth: rightPanelExpandedWidth,
    leftPreferredExpanded: !isSidebarCollapsed,
    rightPreferredExpanded: !isRightPanelCollapsed,
    forcedExpandedSide,
  })
  const isLeftEffectivelyCollapsed = !responsiveShell.leftExpanded
  const isRightEffectivelyCollapsed = !responsiveShell.rightExpanded
  const effectiveSidebarWidth = responsiveShell.leftExpanded ? sidebarExpandedWidth : 0
  const effectiveRightPanelWidth = responsiveShell.rightExpanded ? rightPanelExpandedWidth : 0

  useEffect(() => {
    setForcedExpandedSide(null)
  }, [viewportWidth])

  const handleToggleLeft = useCallback(() => {
    if (forcedExpandedSide === 'left') {
      setForcedExpandedSide(null)
      if (!isSidebarCollapsed) toggleSidebarCollapse()
      return
    }
    if (isLeftEffectivelyCollapsed) {
      setForcedExpandedSide('left')
      if (isSidebarCollapsed) toggleSidebarCollapse()
      return
    }
    toggleSidebarCollapse()
  }, [
    forcedExpandedSide,
    isLeftEffectivelyCollapsed,
    isSidebarCollapsed,
    toggleSidebarCollapse,
  ])

  const ensureRightExpanded = useCallback(() => {
    if (!isRightEffectivelyCollapsed) return
    setForcedExpandedSide('right')
    if (isRightPanelCollapsed) toggleRightPanelCollapse()
  }, [isRightEffectivelyCollapsed, isRightPanelCollapsed, toggleRightPanelCollapse])

  const handleToggleRight = useCallback(() => {
    if (!activeWorkspaceId) return
    if (forcedExpandedSide === 'right') {
      setForcedExpandedSide(null)
      if (!isRightPanelCollapsed) toggleRightPanelCollapse()
      return
    }
    if (isRightEffectivelyCollapsed) {
      ensureRightExpanded()
      return
    }
    toggleRightPanelCollapse()
  }, [
    activeWorkspaceId,
    ensureRightExpanded,
    forcedExpandedSide,
    isRightEffectivelyCollapsed,
    isRightPanelCollapsed,
    toggleRightPanelCollapse,
  ])

  useSidebarKeyboardShortcut(handleToggleLeft)

  const handleFileClick = useCallback(async (path: string, name: string) => {
    if (!activeWorkspaceId) return
    await openFileWithNotice(activeWorkspaceId, path, name, { onOpened: ensureRightExpanded })
  }, [activeWorkspaceId, ensureRightExpanded])

  useEffect(() => {
    useContextTabStore
      .getState()
      .setContext(activeWorkspaceId, activeWorkspaceSessionId ?? null)
  }, [activeWorkspaceId, activeWorkspaceSessionId])

  useEffect(() => {
    setGitCapability(null)
    if (!activeWorkspaceId) return
    let controller: AbortController | null = null
    let generation = 0
    const probe = async () => {
      setGitCapability(null)
      controller?.abort()
      controller = new AbortController()
      const requestGeneration = ++generation
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/git-ref`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const value = await response.json() as GitCapability
        if (requestGeneration !== generation || typeof value.isGitWorktree !== 'boolean') return
        setGitCapability({ workspaceId: activeWorkspaceId, value })
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          setGitCapability(null)
        }
      }
    }
    void probe()
    window.addEventListener('focus', probe)
    return () => {
      generation += 1
      controller?.abort()
      window.removeEventListener('focus', probe)
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!activeWorkspaceId || !activeWorkspaceSessionId) return
    setActiveSession(activeWorkspaceId, activeWorkspaceSessionId)
  }, [activeWorkspaceId, activeWorkspaceSessionId, setActiveSession])

  // The browser pane (U6) follows the active chat session: its browser_state
  // subscription tracks this pointer; background sessions' browsers keep
  // running server-side untouched (AE3).
  useEffect(() => {
    useBrowserPaneStore
      .getState()
      .setActiveSession(activeWorkspaceId ?? null, activeWorkspaceSessionId ?? null)
  }, [activeWorkspaceId, activeWorkspaceSessionId])

  useEffect(() => {
    const setPlacement = useBrowserPaneStore.getState().setDetachedPlacement
    return watchDetachedBrowserPlacement(setPlacement)
  }, [])

  const contextTabs = useContextTabStore((state) => state.openTabs)
  const activeContextTabId = useContextTabStore((state) => state.activeTabId)
  const activeSession = useChatStore((state) => {
    if (!activeWorkspaceId || !activeWorkspaceSessionId) return undefined
    return state.sessions[activeWorkspaceId]?.find((session) => session.id === activeWorkspaceSessionId)
  })
  const lastSessionWorkspaceIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeWorkspaceId && activeWorkspaceSessionId) {
      lastSessionWorkspaceIdRef.current = activeWorkspaceId
    }
  }, [activeWorkspaceId, activeWorkspaceSessionId])

  const handleStartNewChat = useCallback(async (
    workspaceId: string,
    turn: PromptTurnDraft,
    options: {
      backend?: BackendId
      providerId?: string
      codexModel?: string
      codexEffort?: string
      codexSpeed?: string
      fastMode: boolean
      approvalMode: ApprovalMode
    },
  ) => {
    if (newChatSubmitting) return
    const generation = newChatRequestGenerationRef.current + 1
    newChatRequestGenerationRef.current = generation
    newChatAbortControllerRef.current?.abort()
    const abortController = new AbortController()
    newChatAbortControllerRef.current = abortController
    setNewChatError(null)
    setNewChatSubmitting(true)
    try {
      // Keep the implicit default New Chat surface mounted while activating the
      // selected workspace. Otherwise activation makes newChatVisible false and
      // the cleanup effect aborts this request before the session is created.
      setActiveDestination('new-chat')
      void openWorkspace(workspaceId)
      const initialPrompt = turn.text.trim() || tChat('imageOnlySessionTitle')
      const result = await createSession(workspaceId, {
        initialPrompt,
        backend: options.backend,
        providerId: options.providerId,
        codexModel: options.codexModel,
        codexEffort: options.codexEffort,
        codexSpeed: options.codexSpeed,
        fastMode: options.fastMode,
        approvalMode: options.approvalMode,
        signal: abortController.signal,
      })
      if (
        generation !== newChatRequestGenerationRef.current
        || abortController.signal.aborted
      ) return
      if (!result.ok) {
        if (result.reason !== 'cancelled') setNewChatError(result.error)
        return
      }
      setActiveDestination(null)
      transferDraft(
        workspaceId,
        newChatDraftSessionId(workspaceId),
        result.session.id,
        turn,
      )
      sendMessage(workspaceId, result.session.id, turn)
    } finally {
      if (generation === newChatRequestGenerationRef.current) {
        newChatAbortControllerRef.current = null
        setNewChatSubmitting(false)
      }
    }
  }, [createSession, newChatSubmitting, openWorkspace, sendMessage, tChat, transferDraft])

  useEffect(() => {
    if (newChatVisible) return
    newChatRequestGenerationRef.current += 1
    newChatAbortControllerRef.current?.abort()
    newChatAbortControllerRef.current = null
    setNewChatSubmitting(false)
    setNewChatError(null)
  }, [newChatVisible])

  const destinationTitles: Record<Exclude<AppDestination, null>, string> = {
    'new-chat': t('newChat.title'),
    settings: t('header.settings'),
    analytics: t('header.analytics'),
    todos: t('header.todos'),
    capabilities: t('shell.capabilities'),
  }
  const managementTitle = activeDestination
    ? destinationTitles[activeDestination]
    : newChatVisible
      ? destinationTitles['new-chat']
      : undefined
  const activeBrowserOpen = useBrowserPaneStore((state) =>
    selectSessionOpen(state, activeWorkspaceSessionId),
  )
  const previousBrowserOpen = useRef(activeBrowserOpen)
  const previousBrowserSession = useRef(activeWorkspaceSessionId)

  useEffect(() => {
    if (previousBrowserSession.current !== activeWorkspaceSessionId) {
      previousBrowserSession.current = activeWorkspaceSessionId
      previousBrowserOpen.current = activeBrowserOpen
      return
    }
    if (
      activeBrowserOpen
      && !previousBrowserOpen.current
      && activeWorkspaceId
      && activeWorkspaceSessionId
    ) {
      useContextTabStore
        .getState()
        .openBrowser(activeWorkspaceSessionId, activeWorkspaceId)
      ensureRightExpanded()
    }
    previousBrowserOpen.current = activeBrowserOpen
  }, [
    activeBrowserOpen,
    activeWorkspaceId,
    activeWorkspaceSessionId,
    ensureRightExpanded,
  ])

  if (claudeCheck.checking) {
    return (
      <div className="h-screen flex items-center justify-center bg-work text-text-primary">
        <div className="flex flex-col items-center gap-4">
          <img src={comateIconUrl} alt="" className="h-8 w-8 rounded-lg" />
          <p className="text-text-secondary">Checking Claude CLI...</p>
        </div>
      </div>
    )
  }

  if (!claudeCheck.ok) {
    return (
      <div className="h-screen flex items-center justify-center bg-work text-text-primary p-8">
        <div className="max-w-md w-full bg-chrome rounded-xl border border-border p-8 flex flex-col items-center gap-6 text-center">
          <img src={comateIconUrl} alt="" className="h-12 w-12 rounded-xl" />
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-semibold">Claude CLI Required</h1>
            <p className="text-text-secondary text-sm">
              {claudeCheck.error || 'Claude CLI must be installed and authenticated.'}
            </p>
          </div>
          <button
            onClick={checkClaudeCli}
            className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <ToolRendererProvider
      value={{
        workspacePath: activeWorkspace?.folderPath,
        onOpenFile: handleFileClick,
      }}
    >
      <div
        className="h-screen flex flex-col bg-work text-text-primary overflow-hidden"
        style={{ fontSize: uiFontSize }}
        {...(isWin && !windowMaximized ? { 'data-windows-restored-frame': '' } : {})}
      >
        <CustomTitlebar
          leftWidth={effectiveSidebarWidth}
          rightWidth={effectiveRightPanelWidth}
          leftCollapsed={isLeftEffectivelyCollapsed}
          rightCollapsed={isRightEffectivelyCollapsed}
          contextAvailable={activeWorkspaceId !== null && !newChatVisible}
          viewportWidth={viewportWidth}
          workspaceName={activeWorkspace?.name}
          sessionName={activeSession?.name}
          managementTitle={managementTitle}
          tabs={contextTabs}
          activeTabId={activeContextTabId}
          onSelectTab={(id) => useContextTabStore.getState().selectTab(id)}
          onCloseTab={(id) => useContextTabStore.getState().closeTab(id)}
          onAddTab={() => {
            if (!activeWorkspaceId) return
            setShowContextMenu((open) => !open)
          }}
          onNewChat={openNewChat}
          onToggleLeft={handleToggleLeft}
          onToggleRight={handleToggleRight}
          isMac={isMac}
          isWindows={isWin}
        />

        {showContextMenu && activeWorkspaceId && !managementTitle ? (
          <div
            className={cn(
              'fixed top-11 z-50 w-48 rounded-lg border border-border bg-surface p-1 shadow-lg',
              isWin ? 'right-[146px]' : 'right-2',
            )}
            role="menu"
            aria-label="Add context tab"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                useContextTabStore.getState().openFileWorkspace(activeWorkspaceId)
                ensureRightExpanded()
                setShowContextMenu(false)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              <File className="h-4 w-4" aria-hidden="true" /> {t('shell.files')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!activeWorkspaceSessionId}
              onClick={() => {
                if (!activeWorkspaceSessionId) return
                useContextTabStore.getState().openBrowser(activeWorkspaceSessionId, activeWorkspaceId)
                useBrowserPaneStore.getState().setPaneOpen(activeWorkspaceSessionId, true)
                ensureRightExpanded()
                setShowContextMenu(false)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Globe2 className="h-4 w-4" aria-hidden="true" /> {t('shell.browser')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                useContextTabStore.getState().openChangesWorkspace(activeWorkspaceId)
                ensureRightExpanded()
                setShowContextMenu(false)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              <GitCompare className="h-4 w-4" aria-hidden="true" /> {t('shell.changes')}
            </button>
            {gitCapability?.workspaceId === activeWorkspaceId
              && gitCapability.value.isGitWorktree ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  useContextTabStore.getState().openGitGraph(activeWorkspaceId)
                  ensureRightExpanded()
                  setShowContextMenu(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              >
                <GitBranch className="h-4 w-4" aria-hidden="true" /> {t('shell.gitGraph')}
              </button>
            ) : null}
          </div>
        ) : null}

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Provider Error Toast */}
        {!providerCheck.ok && !providerCheck.checking && !providerToastDismissed && (
          <div className="absolute top-2 right-2 z-20 bg-surface border border-border rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 max-w-xs">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
            <span className="text-xs text-text-primary flex-1">{providerCheck.error}</span>
            <button
              onClick={() => openPanel('settings')}
              className="px-2 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-md transition-colors flex-shrink-0"
            >
              {t('provider.configure')}
            </button>
            <button
              onClick={() => setProviderToastDismissed(true)}
              className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
              aria-label={t('close')}
              title={t('close')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <UpdateNotification />

        {/* U3/KTD-24: persistent banner while the host sandbox probe fails —
            no manual dismissal; clears only when a probe passes. */}
        <SandboxDegradedBanner />

        {migrationNoticeVisible && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-surface border border-border rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 max-w-md">
            <AlertCircle className="w-4 h-4 text-warning flex-shrink-0" />
            <div className="flex flex-col text-xs">
              <span className="font-medium text-text-primary">{t('migrationNotice.title')}</span>
              <span className="text-text-secondary">{t('migrationNotice.message', { count: auditLogsCleared })}</span>
            </div>
            <button
              onClick={dismissMigrationNotice}
              className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
              aria-label={t('close')}
              title={t('close')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div
          id="agent-command-center-region"
          className="flex h-full flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: effectiveSidebarWidth }}
          aria-hidden={isLeftEffectivelyCollapsed}
          {...(isLeftEffectivelyCollapsed ? { inert: '' } : {})}
        >
          <AgentCommandCenter
            width={sidebarExpandedWidth}
            onWidthChange={setSidebarWidth}
            onCreateWorkspace={() => setShowCreateModal(true)}
            onNewChat={openNewChat}
            onOpenTodos={() => openPanel('todos')}
            onOpenAnalytics={() => openPanel('analytics')}
            onOpenSettings={() => openPanel('settings')}
            onOpenSettingsForWorkspace={openSettingsForWorkspace}
            onOpenCapabilities={() => openPanel('capabilities')}
            onActivateWork={() => requestDestination(null)}
            activeDestination={newChatVisible ? 'new-chat' : activeDestination ?? 'work'}
          />
        </div>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            className={cn(
              'absolute inset-0 flex',
              (activePanel || newChatVisible) && 'invisible pointer-events-none',
            )}
            aria-hidden={activePanel || newChatVisible ? true : undefined}
            {...(activePanel || newChatVisible ? { inert: '' } : {})}
          >
            {/* Keep all open workspace panels mounted across management navigation. */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
              {activeWorkspace ? (
                openWorkspaceIds.map((wsId) => (
                  <div
                    key={wsId}
                    className={cn(
                      'absolute inset-0 flex flex-col',
                      wsId === activeWorkspaceId && activePanel === null && !newChatVisible
                        ? 'visible'
                        : 'invisible pointer-events-none'
                    )}
                    aria-hidden={wsId !== activeWorkspaceId || activePanel !== null || newChatVisible}
                    {...(wsId !== activeWorkspaceId || activePanel !== null || newChatVisible ? { inert: '' } : {})}
                  >
                    <ChatPanel
                      workspaceId={wsId}
                    />
                  </div>
                ))
              ) : null}
            </main>

            {activeWorkspaceId && (
              <ContextWorkspace
                width={rightPanelExpandedWidth}
                isCollapsed={isRightEffectivelyCollapsed || activePanel !== null || newChatVisible}
                onWidthChange={setRightPanelWidth}
                workspaceId={activeWorkspaceId}
                workspacePath={activeWorkspace?.folderPath}
              />
            )}
          </div>

          {newChatVisible ? (
            <div className="absolute inset-0 flex">
              <NewChatPage
                workspaces={workspaces}
                defaultWorkspaceId={lastSessionWorkspaceIdRef.current}
                defaultApprovalMode={approvalMode}
                selectedWorkspaceId={newChatWorkspaceId}
                onWorkspaceChange={setNewChatWorkspaceId}
                onCreateWorkspace={() => setShowCreateModal(true)}
                onSubmit={handleStartNewChat}
                isSubmitting={newChatSubmitting}
                error={newChatError}
              />
            </div>
          ) : null}

          {activePanel ? (
            <div className="absolute inset-0 flex">
              <ManagementWorkspace
                destination={activePanel}
                workspaceId={activeWorkspaceId ?? undefined}
                settingsWorkspaceId={settingsWorkspaceTargetId ?? undefined}
                onClose={closePanel}
                settingsCloseRequestToken={settingsCloseRequestToken}
                onSettingsCloseCancelled={() => {
                  setPendingDestination(undefined)
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      {showCreateModal && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(workspace) => {
            if (newChatVisible) setNewChatWorkspaceId(workspace.id)
          }}
        />
      )}

      <UpdateRestartDialog onForceShowWindow={handleForceShowWindow} />

      <UsageLoginModal />

      <ToastContainer />
    </div>
    </ToolRendererProvider>
  )
}

export default App
