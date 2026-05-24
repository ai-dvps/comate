import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import MessageList from './MessageList'
import PromptInput from './PromptInput'
import ApprovalSurface, { CHAT_ABOUT_THIS_MESSAGE } from './ApprovalSurface'
import SubagentDrawer from './SubagentDrawer'
import TaskPanel from './TaskPanel'
import TokenUsageBar from './TokenUsageBar'

interface ChatPanelProps {
  workspaceId: string
}

export default function ChatPanel({ workspaceId }: ChatPanelProps) {
  const { t } = useTranslation('chat')
  const sessions = useChatStore((s) => s.sessions[workspaceId] || [])
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isStreaming = useChatStore((s) => s.isStreaming[activeSessionId || ''])
  const isLoadingMessages = useChatStore((s) => s.isLoadingMessages)
  const approvalQueue = useChatStore((s) => s.approvalQueue[activeSessionId || ''] || [])
  const fetchSessions = useChatStore((s) => s.fetchSessions)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const loadMessages = useChatStore((s) => s.loadMessages)
  const resolveApproval = useChatStore((s) => s.resolveApproval)
  const interruptSession = useChatStore((s) => s.interruptSession)

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)
  )
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const modelName = (workspace?.settings?.model as string) || 'claude-sonnet-4-6'

  const [isInterrupting, setIsInterrupting] = useState(false)
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(
    null,
  )
  const [openDrawerToolUseId, setOpenDrawerToolUseId] = useState<
    string | null
  >(null)

  useEffect(() => {
    fetchSessions(workspaceId)
  }, [workspaceId, fetchSessions])

  useEffect(() => {
    // Close drawer when switching sessions
    setOpenDrawerToolUseId(null)
  }, [activeSessionId])

  useEffect(() => {
    if (activeSessionId && activeSession && !activeSession.isDraft) {
      loadMessages(workspaceId, activeSessionId)
    }
  }, [workspaceId, activeSessionId, activeSession, loadMessages])

  const currentApproval = approvalQueue[0] || null
  const approvalQueueLength = approvalQueue.length

  // DIAGNOSTIC: log render and approval state
  console.log('[ChatPanel] render', { activeSessionId, approvalQueueLength, currentRequestId: currentApproval?.requestId ?? null })

  useEffect(() => {
    console.log('[ChatPanel] currentApproval changed:', currentApproval?.requestId ?? null)
  }, [currentApproval])

  const handleSend = (content: string) => {
    if (!activeSessionId) return
    sendMessage(workspaceId, activeSessionId, content)
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

      {/* Messages */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {isLoadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        ) : activeSessionId ? (
          <MessageList
            key={activeSessionId}
            sessionId={activeSessionId}
            workspaceId={workspaceId}
            onOpenDrawer={setOpenDrawerToolUseId}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-text-secondary">{t('selectSessionPrompt')}</p>
          </div>
        )}
      </div>

      {/* Approval Surface or Prompt Input */}
      <div className="flex-shrink-0 border-t border-border/30 bg-bg">
        {activeSessionId && currentApproval ? (
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
            sessionId={activeSessionId || ''}
            onSend={handleSend}
            onStop={handleStop}
            disabled={!activeSessionId}
            isStreaming={isStreaming}
            isInterrupting={isInterrupting}
            hasSession={!!activeSessionId}
          />
        )}
      </div>

      {/* Token Usage Bar */}
      {activeSessionId && (
        <TokenUsageBar sessionId={activeSessionId} workspaceId={workspaceId} />
      )}

      {/* Subagent Drawer */}
      {activeSessionId && openDrawerToolUseId && (
        <SubagentDrawer
          parentToolUseId={openDrawerToolUseId}
          sessionId={activeSessionId}
          onClose={handleCloseDrawer}
        />
      )}
    </div>
  )
}
