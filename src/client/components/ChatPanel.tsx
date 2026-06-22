import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useProviderStore } from '../stores/provider-store'
import { useMessageSearch } from '../hooks/useMessageSearch'
import ChatEmptyState from './ChatEmptyState'
import MessageList from './MessageList'
import PromptInput from './PromptInput'
import ApprovalSurface, { CHAT_ABOUT_THIS_MESSAGE } from './ApprovalSurface'
import SubagentDrawer from './SubagentDrawer'
import TaskPanel from './TaskPanel'
import StatusBar from './StatusBar'
import MessageSearchBar from './MessageSearchBar'
import { isBotSession } from '../lib/session-filter'

const EMPTY_ARRAY: [] = []

interface ChatPanelProps {
  workspaceId: string
}

export default function ChatPanel({ workspaceId }: ChatPanelProps) {
  const { t } = useTranslation('chat')
  const sessions = useChatStore((s) => s.sessions[workspaceId] ?? EMPTY_ARRAY)
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isStreaming = useChatStore((s) => s.isStreaming[activeSessionId || ''])
  const isLoadingMessages = useChatStore((s) => s.isLoadingMessages[activeSessionId || ''])
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
  const botName = (workspace?.settings?.wecomBotName as string) || ''

  const providers = useProviderStore((s) => s.providers)
  const activeProvider = providers.find((p) => p.id === activeSession?.providerId)
  const modelName = activeProvider?.model || activeProvider?.name || 'claude-sonnet-4-6'

  const [isInterrupting, setIsInterrupting] = useState(false)
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(
    null,
  )
  const [openDrawerToolUseId, setOpenDrawerToolUseId] = useState<
    string | null
  >(null)
  const [subagentPanelWidth, setSubagentPanelWidth] = useState(400)
  const [refreshMeta, setRefreshMeta] = useState<{
    lastRefreshedAt: Date | null
    lastNewCount: number
    lastError: boolean
  }>({ lastRefreshedAt: null, lastNewCount: 0, lastError: false })
  const [wecomUser, setWecomUser] = useState<{ userId: string; lastSeenAt: string | null } | null>(null)
  const [isSearchBarOpen, setIsSearchBarOpen] = useState(false)
  const previousFocusRef = useRef<HTMLElement | null>(null)

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
    setOpenDrawerToolUseId(null)
  }, [activeSessionId])

  useEffect(() => {
    if (activeSessionId && activeSession && !activeSession.isDraft && cachedMessages.length === 0) {
      loadMessages(workspaceId, activeSessionId)
    }
  }, [workspaceId, activeSessionId, activeSession, loadMessages, cachedMessages.length])

  useEffect(() => {
    return () => {
      cleanupWorkspace(workspaceId)
    }
  }, [workspaceId, cleanupWorkspace])

  useEffect(() => {
    setRefreshMeta({ lastRefreshedAt: null, lastNewCount: 0, lastError: false })
    setWecomUser(null)
  }, [activeSessionId])

  useEffect(() => {
    if (!activeSessionId || !activeSessionIsBot) return
    const fetchWecomUser = async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${activeSessionId}/wecom-user`)
        if (!res.ok) return
        const data = (await res.json()) as { userId?: string; lastSeenAt?: string | null }
        if (data.userId) {
          setWecomUser({ userId: data.userId, lastSeenAt: data.lastSeenAt ?? null })
        }
      } catch {
        // silently ignore
      }
    }
    fetchWecomUser()
  }, [workspaceId, activeSessionId, activeSessionIsBot])

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

  const handleCloseDrawer = useCallback(() => {
    setOpenDrawerToolUseId(null)
  }, [])

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Chat Header */}
      <div className="flex items-center justify-center py-3 border-b border-border/30 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 max-w-full px-4">
          <span className="font-medium text-text-primary truncate max-w-md">
            {activeSession?.name || t('noSession')}
          </span>
          <span className="text-text-tertiary">/</span>
          <span className="text-text-tertiary">{modelName}</span>
        </div>
      </div>

      {/* Task Panel */}
      {activeSessionId && <TaskPanel sessionId={activeSessionId} />}

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

          {isLoadingMessages && cachedMessages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
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
                  onOpenDrawer={setOpenDrawerToolUseId}
                  isVisible={sessionId === activeSessionId}
                  searchMatches={searchMatches}
                  currentMatch={currentMatch}
                />
              </div>
            ))
          ) : (
            <ChatEmptyState onCreateSession={handleCreateSession} />
          )}

          {/* Approval Surface or Prompt Input */}
          {activeSessionId && (
            <div className="flex-shrink-0 border-t border-border/30 bg-bg">
              {currentApproval ? (
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
                  wecomUser={wecomUser}
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

        {/* Subagent Drawer */}
        {activeSessionId && openDrawerToolUseId && (
          <SubagentDrawer
            parentToolUseId={openDrawerToolUseId}
            sessionId={activeSessionId}
            width={subagentPanelWidth}
            onClose={handleCloseDrawer}
            onWidthChange={setSubagentPanelWidth}
          />
        )}
      </div>
    </div>
  )
}
