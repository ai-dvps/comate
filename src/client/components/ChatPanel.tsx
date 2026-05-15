import { useState, useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chat-store'
import SessionSelector from './SessionSelector'
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
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50 flex-shrink-0">
        <SessionSelector workspaceId={workspaceId} />
        <div className="text-xs text-text-tertiary">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
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
      <div className="px-4 py-3 border-t border-border/50 flex-shrink-0">
        <div className="flex items-end gap-2 bg-surface rounded-xl border border-border/50 focus-within:border-accent/50 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Claude anything..."
            rows={1}
            disabled={isStreaming || !activeSessionId}
            className="flex-1 bg-transparent px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none max-h-32"
            style={{ minHeight: '44px' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming || !activeSessionId}
            className="mb-2 mr-2 p-2 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[10px] text-text-tertiary mt-1.5 px-1">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
