import { useState, useEffect } from 'react'
import { useChatStore } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import MessageList from './MessageList'
import PromptInput from './PromptInput'
import ApprovalBanner from './ApprovalBanner'
import SubagentDrawer from './SubagentDrawer'

interface ChatPanelProps {
  workspaceId: string
}

export default function ChatPanel({ workspaceId }: ChatPanelProps) {
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

  const handleAllow = () => {
    if (!activeSessionId || !currentApproval) return
    resolveApproval(workspaceId, activeSessionId, currentApproval.requestId, {
      behavior: 'allow',
    })
  }

  const handleAllowAlways = () => {
    if (!activeSessionId || !currentApproval) return
    const suggestions =
      'suggestions' in currentApproval ? currentApproval.suggestions : undefined
    resolveApproval(workspaceId, activeSessionId, currentApproval.requestId, {
      behavior: 'allow',
      updatedPermissions: suggestions,
    })
  }

  const handleDeny = (message: string) => {
    if (!activeSessionId || !currentApproval) return
    resolveApproval(workspaceId, activeSessionId, currentApproval.requestId, {
      behavior: 'deny',
      message,
    })
  }

  const handleAnswerQuestion = (answers: Record<string, string>) => {
    if (!activeSessionId || !currentApproval) return
    const questions =
      'questions' in currentApproval ? currentApproval.questions : undefined
    resolveApproval(workspaceId, activeSessionId, currentApproval.requestId, {
      behavior: 'allow',
      answers,
      questions,
    })
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Chat Header */}
      <div className="flex items-center justify-center py-3 border-b border-border/30 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">
            {activeSession?.name || 'No session'}
          </span>
          <span className="text-text-tertiary">/</span>
          <span className="text-xs text-text-tertiary">{modelName}</span>
        </div>
      </div>

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
            sessionId={activeSessionId}
            onOpenDrawer={setOpenDrawerToolUseId}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-secondary">Select or create a session to start chatting</p>
          </div>
        )}
      </div>

      {/* Approval Banner */}
      {activeSessionId && currentApproval && (
        <ApprovalBanner
          pendingItem={currentApproval}
          queueDepth={approvalQueueLength - 1}
          onAllow={handleAllow}
          onAllowAlways={handleAllowAlways}
          onDeny={handleDeny}
          onAnswerQuestion={handleAnswerQuestion}
        />
      )}

      {/* Prompt Input */}
      <div className="flex-shrink-0 border-t border-border/30 bg-bg">
        <PromptInput
          workspaceId={workspaceId}
          onSend={handleSend}
          onStop={handleStop}
          disabled={!activeSessionId}
          isStreaming={isStreaming}
          isInterrupting={isInterrupting}
          hasSession={!!activeSessionId}
        />
      </div>

      {/* Subagent Drawer */}
      {activeSessionId && openDrawerToolUseId && (
        <SubagentDrawer
          parentToolUseId={openDrawerToolUseId}
          sessionId={activeSessionId}
          onClose={() => setOpenDrawerToolUseId(null)}
        />
      )}
    </div>
  )
}
