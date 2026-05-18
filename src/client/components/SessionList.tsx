import { useState } from 'react'
import { useChatStore } from '../stores/chat-store'
import { MessageSquare, Plus, Trash2 } from 'lucide-react'

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} min ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getSessionDisplayName(session: import('../stores/chat-store').ChatSession): string {
  return session.customTitle || session.summary || session.name
}

function getSessionTimestamp(session: import('../stores/chat-store').ChatSession): string {
  if (session.lastModified) {
    return formatRelativeDate(new Date(session.lastModified).toISOString())
  }
  return formatRelativeDate(session.updatedAt)
}

interface SessionListProps {
  workspaceId: string
}

export default function SessionList({ workspaceId }: SessionListProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [hoveredSession, setHoveredSession] = useState<string | null>(null)

  const sessions = useChatStore((s) => s.sessions[workspaceId] || [])
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const messages = useChatStore((s) => s.messages)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const isLoading = useChatStore((s) => s.isLoadingSessions)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)

  const handleCreate = async () => {
    const name = newName.trim() || `Session ${sessions.length + 1}`
    await createSession(workspaceId, name)
    setNewName('')
    setShowCreate(false)
  }

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    await deleteSession(sessionId, workspaceId)
  }

  const getPreview = (sessionId: string): string => {
    const sessionMessages = messages[sessionId] || []
    if (sessionMessages.length === 0) return 'Start a new conversation...'
    const lastMsg = sessionMessages[sessionMessages.length - 1]
    const firstPart = lastMsg.parts[0]
    const text = firstPart?.type === 'text' ? firstPart.text : ''
    const preview = text.slice(0, 80)
    return preview.length < text.length ? preview + '...' : preview
  }

  return (
    <div className="flex flex-col h-full">
      {/* New Session Button */}
      <div className="p-3">
        {showCreate ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') {
                  setShowCreate(false)
                  setNewName('')
                }
              }}
              placeholder="Session name"
              className="w-full px-3 py-2 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                className="flex-1 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowCreate(false)
                  setNewName('')
                }}
                className="flex-1 py-1.5 text-xs bg-surface-hover hover:bg-surface-active text-text-secondary rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-bg border border-border hover:border-border-hover rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Session
          </button>
        )}
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && sessions.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary text-center">
            No sessions yet.
            <br />
            Create one to start chatting.
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => setActiveSession(workspaceId, session.id)}
              onMouseEnter={() => setHoveredSession(session.id)}
              onMouseLeave={() => setHoveredSession(null)}
              className={`session-item mx-2 px-3 py-2.5 rounded-lg cursor-pointer group transition-all ${
                session.id === activeSessionId
                  ? 'bg-surface-active'
                  : 'hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-start gap-2">
                <MessageSquare
                  className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
                    session.id === activeSessionId ? 'text-accent' : 'text-text-tertiary'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p
                      className={`text-xs truncate ${
                        session.id === activeSessionId
                          ? 'text-text-primary font-medium'
                          : 'text-text-secondary'
                      }`}
                    >
                      {getSessionDisplayName(session)}
                    </p>
                    {session.isDraft && (
                      <span className="px-1 py-0.5 text-[9px] bg-yellow-500/20 text-yellow-500 rounded">
                        Draft
                      </span>
                    )}
                    {sessionStatus[session.id]?.pendingCount > 0 && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-orange-500 flex-shrink-0"
                        title="Needs approval"
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                    {getPreview(session.id)}
                  </p>
                  <p className="text-[10px] text-text-tertiary/60 mt-1">
                    {getSessionTimestamp(session)}
                  </p>
                </div>
                {session.id === activeSessionId ? (
                  <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 mt-2" />
                ) : (
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    className={`p-1 rounded hover:bg-red-500/20 text-text-tertiary hover:text-red-400 flex-shrink-0 transition-opacity ${
                      hoveredSession === session.id ? 'opacity-100' : 'opacity-0'
                    }`}
                    title="Delete session"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
