import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, PanelLeft, PanelLeftOpen, PanelRight, PanelRightOpen } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useProviderStore } from '../stores/provider-store'
import { useMessageSearch } from '../hooks/useMessageSearch'
import { useAppSettings } from '../hooks/use-app-settings'
import ChatEmptyState from './ChatEmptyState'
import MessageList from './MessageList'
import PromptInput from './PromptInput'
import ApprovalSurface, { CHAT_ABOUT_THIS_MESSAGE } from './ApprovalSurface'
import DetailDrawer from './DetailDrawer'
import type { DrawerView } from './detail-drawer-view'
import TaskPanel from './TaskPanel'
import StatusBar from './StatusBar'
import MessageSearchBar from './MessageSearchBar'
import WorkflowFloatingPanel from './WorkflowFloatingPanel'
import BrowserPane from './browser/BrowserPane'
import BrowserPaneButton from './browser/BrowserPaneButton'

import { isBotSession } from '../lib/session-filter'

const EMPTY_ARRAY: [] = []

interface ChatPanelProps {
  workspaceId: string
  isSidebarCollapsed?: boolean
  onToggleSidebarCollapse?: () => void
  isRightPanelCollapsed?: boolean
  onToggleRightPanelCollapse?: () => void
}

export default function ChatPanel({
  workspaceId,
  isSidebarCollapsed = false,
  onToggleSidebarCollapse,
  isRightPanelCollapsed = false,
  onToggleRightPanelCollapse,
}: ChatPanelProps) {
  const { t } = useTranslation(['chat', 'common'])
  const sessions = useChatStore((s) => s.sessions[workspaceId] ?? EMPTY_ARRAY)
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isStreaming = useChatStore((s) => s.isStreaming[activeSessionId || ''])
  const isLoadingMessages = useChatStore((s) => s.isLoadingMessages[activeSessionId || ''])
  const historyLoadState = useChatStore((s) => s.historyLoadState[activeSessionId || ''])
  const approvalQueue = useChatStore((s) => s.approvalQueue[activeSessionId || ''] ?? EMPTY_ARRAY)
  const cachedMessages = useChatStore((s) => s.messages[activeSessionId || ''] ?? EMPTY_ARRAY)
  const domCache = useChatStore((s) => s.domCache[workspaceId] ?? EMPTY_ARRAY)
  const fetchSessions = useChatStore((s) => s.fetchSessions)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const loadMessages = useChatStore((s) => s.loadMessages)
  const refreshBotMessages = useChatStore((s) => s.refreshBotMessages)
  const resolveApproval = useChatStore((s) => s.resolveApproval)
  const interruptSession = useChatStore((s) => s.interruptSession)
  const cleanupWorkspace = useChatStore((s) => s.cleanupWorkspace)
  const createSession = useChatStore((s) => s.createSession)

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)
  )
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeSessionIsBot = activeSession ? isBotSession(activeSession.source) : false
  const activeSessionIsFeishu = activeSession?.source === 'feishu'
  const botName = activeSessionIsFeishu
    ? (workspace?.settings?.feishuBotName as string) || ''
    : (workspace?.settings?.wecomBotName as string) || ''
  const botIcon = activeSessionIsFeishu ? '/feishu-icon.svg' : '/wecom-icon.svg'

  const providers = useProviderStore((s) => s.providers)
  const activeProvider = providers.find((p) => p.id === activeSession?.providerId)
  const modelName = activeProvider?.model || activeProvider?.name || 'claude-sonnet-4-6'

  const [isInterrupting, setIsInterrupting] = useState(false)
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(
    null,
  )
  const [drawerStack, setDrawerStack] = useState<DrawerView[]>([])
  const [drawerWidth, setDrawerWidth] = useState(400)
  const { displayMode } = useAppSettings()

  // Close the drawer if the user leaves result-focused mode (R4).
  useEffect(() => {
    if (displayMode !== 'result') setDrawerStack([])
  }, [displayMode])
  const [refreshMeta, setRefreshMeta] = useState<{
    lastRefreshedAt: Date | null
    lastNewCount: number
    lastError: boolean
  }>({ lastRefreshedAt: null, lastNewCount: 0, lastError: false })
  const [botUser, setBotUser] = useState<{ userId: string; lastSeenAt: string | null } | null>(null)
  const [isSearchBarOpen, setIsSearchBarOpen] = useState(false)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const historyLoadAttemptRef = useRef<string | null>(null)

  // Responsive chat header: measure the space available to the title (the region
  // between the left/right button clusters) and drop the model name when it gets
  // tight, so the session title can take the full width and ellipsize via truncate.
  // Observing the title region (not the whole header) automatically accounts for
  // the widths of the button clusters on both sides. Mirrors the ResizeObserver +
  // width-threshold pattern used in PromptInput.
  const titleAreaRef = useRef<HTMLDivElement>(null)
  const [showModelName, setShowModelName] = useState(true)
  useEffect(() => {
    const el = titleAreaRef.current
    if (!el) return
    // Keep the model name only while the title region can comfortably fit it
    // alongside a readable session title; below this the title gets the full width.
    const MODEL_NAME_MIN_WIDTH = 320
    const measure = () => {
      setShowModelName((prev) => {
        const next = el.offsetWidth >= MODEL_NAME_MIN_WIDTH
        return next === prev ? prev : next
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    matches: searchMatches,
    currentMatch,
    currentMatchIndex,
    totalMatches,
    nextMatch,
    prevMatch,
    isSearching,
  } = useMessageSearch({ messages: cachedMessages })

  const openSearch = useCallback(() => {
    previousFocusRef.current = document.activeElement as HTMLElement
    setIsSearchBarOpen(true)
  }, [])

  const closeSearch = useCallback(() => {
    setIsSearchBarOpen(false)
    setSearchQuery('')
    previousFocusRef.current?.focus()
    previousFocusRef.current = null
  }, [setSearchQuery])

  useEffect(() => {
    fetchSessions(workspaceId)
  }, [workspaceId, fetchSessions])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut =
        (event.key === 'f' || event.key === 'F') &&
        (event.metaKey || event.ctrlKey)

      if (isFindShortcut) {
        const active = document.activeElement
        const isEditableInput =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active?.getAttribute('contenteditable') === 'true'

        if (isEditableInput) return

        event.preventDefault()
        openSearch()
        return
      }

      if (event.key === 'Escape' && isSearchBarOpen) {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeSearch()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isSearchBarOpen, openSearch, closeSearch])

  useEffect(() => {
    // Close search and clear query when switching sessions
    closeSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  useEffect(() => {
    // Close drawer when switching sessions
    setDrawerStack([])
  }, [activeSessionId])

  useEffect(() => {
    if (!activeSessionId || !activeSession || activeSession.isDraft) {
      historyLoadAttemptRef.current = activeSessionId ?? null
      return
    }
    if (historyLoadState) {
      historyLoadAttemptRef.current = activeSessionId
      return
    }
    if (historyLoadAttemptRef.current !== activeSessionId) {
      historyLoadAttemptRef.current = activeSessionId
      loadMessages(workspaceId, activeSessionId)
    }
  }, [workspaceId, activeSessionId, activeSession, historyLoadState, loadMessages])

  useEffect(() => {
    return () => {
      cleanupWorkspace(workspaceId)
    }
  }, [workspaceId, cleanupWorkspace])

  useEffect(() => {
    setRefreshMeta({ lastRefreshedAt: null, lastNewCount: 0, lastError: false })
    setBotUser(null)
  }, [activeSessionId])

  useEffect(() => {
    if (!activeSessionId || !activeSessionIsBot) return
    const fetchBotUser = async () => {
      try {
        const endpoint = activeSessionIsFeishu ? 'feishu-user' : 'wecom-user'
        const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${activeSessionId}/${endpoint}`)
        if (!res.ok) return
        const data = (await res.json()) as { userId?: string; lastSeenAt?: string | null }
        if (data.userId) {
          setBotUser({ userId: data.userId, lastSeenAt: data.lastSeenAt ?? null })
        }
      } catch {
        // silently ignore
      }
    }
    fetchBotUser()
  }, [workspaceId, activeSessionId, activeSessionIsBot, activeSessionIsFeishu])

  const currentApproval = approvalQueue[0] || null
  const approvalQueueLength = approvalQueue.length

  const handleSend = (content: string) => {
    if (!activeSessionId) return
    sendMessage(workspaceId, activeSessionId, content)
  }

  const handleCreateSession = useCallback(async (name: string) => {
    const sessionName =
      name.trim() || t('newSessionDefaultName', { count: sessions.length + 1 })
    await createSession(workspaceId, sessionName)
  }, [createSession, workspaceId, sessions.length, t])

  const handleRefresh = async () => {
    if (!activeSessionId) return
    setRefreshMeta((prev) => ({ ...prev, lastError: false }))
    const messagesBefore = useChatStore.getState().messages[activeSessionId]?.length || 0
    try {
      await refreshBotMessages(workspaceId, activeSessionId)
      const messagesAfter = useChatStore.getState().messages[activeSessionId]?.length || 0
      setRefreshMeta({
        lastRefreshedAt: new Date(),
        lastNewCount: messagesAfter - messagesBefore,
        lastError: false,
      })
    } catch {
      setRefreshMeta({
        lastRefreshedAt: new Date(),
        lastNewCount: 0,
        lastError: true,
      })
    }
  }

  const handleStop = async () => {
    if (!activeSessionId) return
    setIsInterrupting(true)
    try {
      await interruptSession(workspaceId, activeSessionId)
    } finally {
      setIsInterrupting(false)
    }
  }

  const handleAllow = async () => {
    if (!activeSessionId || !currentApproval) return
    setResolvingRequestId(currentApproval.requestId)
    try {
      await resolveApproval(
        workspaceId,
        activeSessionId,
        currentApproval.requestId,
        { behavior: 'allow' },
      )
    } finally {
      setResolvingRequestId(null)
    }
  }

  const handleAllowAlways = async () => {
    if (!activeSessionId || !currentApproval) return
    setResolvingRequestId(currentApproval.requestId)
    const suggestions =
      'suggestions' in currentApproval ? currentApproval.suggestions : undefined
    try {
      await resolveApproval(
        workspaceId,
        activeSessionId,
        currentApproval.requestId,
        {
          behavior: 'allow',
          updatedPermissions: suggestions,
        },
      )
    } finally {
      setResolvingRequestId(null)
    }
  }

  const handleDeny = async (message: string) => {
    if (!activeSessionId || !currentApproval) return
    setResolvingRequestId(currentApproval.requestId)
    try {
      await resolveApproval(
        workspaceId,
        activeSessionId,
        currentApproval.requestId,
        {
          behavior: 'deny',
          message,
        },
      )
    } finally {
      setResolvingRequestId(null)
    }
  }

  const handleAnswerQuestion = async (answers: Record<string, string>) => {
    if (!activeSessionId || !currentApproval) return
    setResolvingRequestId(currentApproval.requestId)
    const questions =
      'questions' in currentApproval ? currentApproval.questions : undefined
    try {
      await resolveApproval(
        workspaceId,
        activeSessionId,
        currentApproval.requestId,
        {
          behavior: 'allow',
          answers,
          questions,
        },
      )
    } finally {
      setResolvingRequestId(null)
    }
  }

  const handleChatAbout = async () => {
    if (!activeSessionId || !currentApproval) return
    setResolvingRequestId(currentApproval.requestId)
    const questions =
      'questions' in currentApproval ? currentApproval.questions : []
    const answers: Record<string, string> = {}
    for (const q of questions) {
      answers[q.question] = CHAT_ABOUT_THIS_MESSAGE
    }
    try {
      await resolveApproval(
        workspaceId,
        activeSessionId,
        currentApproval.requestId,
        {
          behavior: 'allow',
          answers,
          questions,
        },
      )
    } finally {
      setResolvingRequestId(null)
    }
  }

  const handleOpenDrawerView = useCallback(
    (view: DrawerView) => setDrawerStack([view]),
    [],
  )
  const handlePushDrawer = useCallback(
    (view: DrawerView) => setDrawerStack((s) => [...s, view]),
    [],
  )
  const handlePopDrawer = useCallback(
    () => setDrawerStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    [],
  )
  const handleCloseDrawerPanel = useCallback(() => setDrawerStack([]), [])

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Chat Header — 3-part flex so the left/right button clusters stay in flow
          and the title can never slide under them. The center region's width is
          observed (titleAreaRef) to drop the model name when space gets tight. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 flex-shrink-0">
        {/* Left cluster */}
        {onToggleSidebarCollapse && (
          <button
            className="flex-shrink-0 p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            aria-label={
              isSidebarCollapsed
                ? t('common:sidebar.expand')
                : t('common:sidebar.collapse')
            }
            onClick={() => onToggleSidebarCollapse()}
          >
            {isSidebarCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeft className="w-4 h-4" />
            )}
          </button>
        )}
        {/* Center title — flex-1 takes the space between the clusters */}
        <div
          ref={titleAreaRef}
          className="flex-1 flex items-center justify-center gap-2 min-w-0 text-sm"
        >
          <span className="min-w-0 font-medium text-text-primary truncate max-w-md">
            {activeSession?.name || t('noSession')}
          </span>
          {/* When the title area is tight the model name drops first so the title
              can use the full width; it then ellipsizes via min-w-0 + truncate. */}
          {showModelName && (
            <>
              <span className="text-text-tertiary" aria-hidden="true">/</span>
              <span className="text-text-tertiary">{modelName}</span>
            </>
          )}
        </div>
        {/* Right cluster */}
        <div className="flex-shrink-0 flex items-center gap-1">
          <BrowserPaneButton workspaceId={workspaceId} />
          {onToggleRightPanelCollapse && (
            <button
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
              aria-label={
                isRightPanelCollapsed
                  ? t('common:rightPanel.expand')
                  : t('common:rightPanel.collapse')
              }
              onClick={() => onToggleRightPanelCollapse()}
            >
              {isRightPanelCollapsed ? (
                <PanelRightOpen className="w-4 h-4" />
              ) : (
                <PanelRight className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Main content row: chat area + optional subagent panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-hidden flex flex-col relative">
          {isSearchBarOpen && activeSessionId && (
            <MessageSearchBar
              query={searchQuery}
              onQueryChange={setSearchQuery}
              currentMatchIndex={currentMatchIndex}
              totalMatches={totalMatches}
              onNext={nextMatch}
              onPrev={prevMatch}
              onClose={closeSearch}
              isSearching={isSearching}
            />
          )}

          {activeSession && !activeSession.isDraft && historyLoadState !== 'loaded' ? (
            <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <LoaderCircle className="size-4 animate-spin" />
                <span>{t('chat:loadingConversationHistory')}</span>
              </div>
            </div>
          ) : activeSessionId ? (
            domCache.map((sessionId) => (
              <div
                key={sessionId}
                className={sessionId === activeSessionId ? 'flex flex-col h-full min-h-0' : 'hidden'}
                aria-hidden={sessionId !== activeSessionId}
                {...(sessionId !== activeSessionId ? { inert: 'true' } : {})}
              >
                <MessageList
                  sessionId={sessionId}
                  workspaceId={workspaceId}
                  onOpenDrawer={(toolUseId: string) => handleOpenDrawerView({ kind: 'subagent', parentToolUseId: toolUseId })}
                  onOpenWorkflow={(runId: string) => handleOpenDrawerView({ kind: 'workflow', runId })}
                  onOpenProcessRegion={(messageId: string, regionIndex: number) => handleOpenDrawerView({ kind: 'process', messageId, regionIndex })}
                  isVisible={sessionId === activeSessionId}
                  searchMatches={searchMatches}
                  currentMatch={currentMatch}
                />
              </div>
            ))
          ) : (
            <ChatEmptyState onCreateSession={handleCreateSession} />
          )}

          {activeSessionId && (
            <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-2 pointer-events-none">
              <WorkflowFloatingPanel
                sessionId={activeSessionId}
                onOpenWorkflow={(runId: string) => handleOpenDrawerView({ kind: 'workflow', runId })}
              />
              <TaskPanel sessionId={activeSessionId} />
            </div>
          )}

          {/* Approval Surface or Prompt Input */}
          {activeSessionId && (
            <div className="flex-shrink-0">
              {currentApproval ? (
                activeSessionIsBot ? (
                  <BotPendingBanner label={t('approval.botPending')} />
                ) : (
                  <ApprovalSurface
                    workspaceId={workspaceId}
                    pendingItem={currentApproval}
                    queueDepth={approvalQueueLength - 1}
                    isResolving={resolvingRequestId === currentApproval?.requestId}
                    onAllow={handleAllow}
                    onAllowAlways={handleAllowAlways}
                    onDeny={handleDeny}
                    onAnswerQuestion={handleAnswerQuestion}
                    onChatAbout={handleChatAbout}
                    onStop={handleStop}
                  />
                )
              ) : (
                <PromptInput
                  workspaceId={workspaceId}
                  sessionId={activeSessionId}
                  onSend={handleSend}
                  onStop={handleStop}
                  onRefresh={handleRefresh}
                  disabled={activeSessionIsBot}
                  isStreaming={isStreaming}
                  isInterrupting={isInterrupting}
                  hasSession
                  isBotSession={activeSessionIsBot}
                  botName={botName}
                  botIcon={botIcon}
                  botUser={botUser}
                  refreshMeta={{
                    lastRefreshedAt: refreshMeta.lastRefreshedAt,
                    lastNewCount: refreshMeta.lastNewCount,
                    lastError: refreshMeta.lastError,
                    isRefreshing: isLoadingMessages,
                  }}
                />
              )}
            </div>
          )}

          {/* Status Bar */}
          {activeSessionId && (
            <StatusBar sessionId={activeSessionId} workspaceId={workspaceId} />
          )}
        </div>

        {/* Unified Detail Drawer */}
        {activeSessionId && drawerStack.length > 0 && (
          <DetailDrawer
            stack={drawerStack}
            sessionId={activeSessionId}
            width={drawerWidth}
            onWidthChange={setDrawerWidth}
            onPop={handlePopDrawer}
            onClose={handleCloseDrawerPanel}
            onPush={handlePushDrawer}
          />
        )}

        {/* Embedded browser pane (U6) — independent of the RightPanel; stays
            mounted (CSS-hidden while collapsed) so the viewer iframe keeps
            its cast stream alive across collapse/expand. */}
        <BrowserPane workspaceId={workspaceId} />
      </div>
    </div>
  )
}

function BotPendingBanner({ label }: { label: string }) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-3">
      <div className="bg-surface border border-border/50 rounded-lg px-4 py-3 flex items-center gap-3">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-accent" />
        </span>
        <span className="text-sm text-text-secondary">{label}</span>
      </div>
    </div>
  )
}
