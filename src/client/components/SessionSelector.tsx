import { useState } from 'react'
import { useChatStore } from '../stores/chat-store'
import { ChevronDown, Plus, Trash2, MessageSquare } from 'lucide-react'

interface SessionSelectorProps {
  workspaceId: string
}

export default function SessionSelector({ workspaceId }: SessionSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const sessions = useChatStore((s) => s.sessions[workspaceId] || [])
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isLoading = useChatStore((s) => s.isLoadingSessions)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)

  const activeSession = sessions.find((s) => s.id === activeSessionId)

  const handleCreate = async () => {
    const name = newName.trim() || `Session ${sessions.length + 1}`
    await createSession(workspaceId, name)
    setNewName('')
    setShowCreate(false)
    setIsOpen(false)
  }

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    await deleteSession(sessionId, workspaceId)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-surface-active text-text-primary text-xs transition-colors"
      >
        <MessageSquare className="w-3.5 h-3.5 text-accent" />
        <span className="max-w-[160px] truncate">
          {activeSession?.name || 'Select session'}
        </span>
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-56 bg-surface border border-border rounded-lg shadow-lg z-50 py-1">
            {isLoading && (
              <div className="px-3 py-2 text-xs text-text-tertiary">Loading...</div>
            )}

            {sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => {
                  setActiveSession(workspaceId, session.id)
                  setIsOpen(false)
                }}
                className={`flex items-center justify-between px-3 py-2 cursor-pointer text-xs ${
                  session.id === activeSessionId
                    ? 'bg-surface-active text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="truncate flex-1">{session.name}</span>
                <button
                  onClick={(e) => handleDelete(e, session.id)}
                  className="p-1 rounded hover:bg-red-500/20 text-text-tertiary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete session"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}

            {sessions.length === 0 && !isLoading && (
              <div className="px-3 py-2 text-xs text-text-tertiary">No sessions</div>
            )}

            <div className="border-t border-border/50 mt-1 pt-1">
              {showCreate ? (
                <div className="px-3 py-2">
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
                    className="w-full px-2 py-1 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={handleCreate}
                      className="flex-1 py-1 text-xs bg-accent hover:bg-accent-hover text-white rounded transition-colors"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => {
                        setShowCreate(false)
                        setNewName('')
                      }}
                      className="flex-1 py-1 text-xs bg-surface-hover hover:bg-surface-active text-text-secondary rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  New session
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
