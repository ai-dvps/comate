import { useState, useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import MessageList from './MessageList'
import { Send } from 'lucide-react'

interface ChatPanelProps {
  workspaceId: string
}

export default function ChatPanel({ workspaceId }: ChatPanelProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const sessions = useChatStore((s) => s.sessions[workspaceId] || [])
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isStreaming = useChatStore((s) => s.isStreaming[activeSessionId || ''])
  const fetchSessions = useChatStore((s) => s.fetchSessions)
  const createSession = useChatStore((s) => s.createSession)
  const sendMessage = useChatStore((s) => s.sendMessage)

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)
  )
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const modelName = (workspace?.settings?.model as string) || 'claude-sonnet-4-6'

  // Auto-fetch sessions when workspace changes
  useEffect(() => {
    fetchSessions(workspaceId)
  }, [workspaceId, fetchSessions])

  // Auto-create first session if none exist
  useEffect(() => {
    if (sessions.length === 0) {
      createSession(workspaceId, 'Default Session')
    }
  }, [workspaceId, sessions.length, createSession])

  const handleSend = () => {
    if (!input.trim() || !activeSessionId || isStreaming) return
    sendMessage(workspaceId, activeSessionId, input.trim())
    setInput('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
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
      <div className="flex-1 overflow-hidden">
        {activeSessionId ? (
          <MessageList sessionId={activeSessionId} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-secondary">Create a session to start chatting</p>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 border-t border-border/30 bg-bg">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <div className="relative bg-surface border border-border rounded-xl focus-within:border-border-hover transition-colors">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Claude anything about your code..."
              rows={1}
              disabled={isStreaming || !activeSessionId}
              className="w-full bg-transparent border-0 rounded-xl px-4 py-3.5 pr-12 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:ring-0 max-h-32"
              style={{ minHeight: '44px' }}
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              <button
                onClick={handleSend}
                disabled={!input.trim() || isStreaming || !activeSessionId}
                className="p-1.5 rounded-md text-text-tertiary hover:text-accent transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1">
            <span className="text-[11px] text-text-tertiary">
              Enter to send, Shift+Enter for new line
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
