import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { MessageSquare, Plus } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import { deriveSessionState } from '../lib/session-status'

function formatRelativeDate(dateStr: string, t: TFunction): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t('time.justNow')
  if (diffMins < 60) return t('time.minAgo', { count: diffMins })
  if (diffHours < 24) return t('time.hourAgo', { count: diffHours })
  if (diffDays < 7) return t('time.dayAgo', { count: diffDays })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getSessionDisplayName(session: import('../stores/chat-store').ChatSession): string {
  const name = session.customTitle || session.summary || session.name
  if (session.source === 'wecom' && name.startsWith('WeCom: ')) {
    return name.slice(7)
  }
  return name
}

function getSessionTimestamp(session: import('../stores/chat-store').ChatSession, t: TFunction): string {
  if (session.lastModified) {
    return formatRelativeDate(new Date(session.lastModified).toISOString(), t)
  }
  return formatRelativeDate(session.updatedAt, t)
}

interface SessionListProps {
  workspaceId: string
}

export default function SessionList({ workspaceId }: SessionListProps) {
  const { t } = useTranslation('chat')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')

  const sessions = useChatStore((s) => s.sessions[workspaceId] || [])
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const messages = useChatStore((s) => s.messages)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const unreadCompletions = useChatStore((s) => s.unreadCompletions)
  const isLoading = useChatStore((s) => s.isLoadingSessions)
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)

  const handleCreate = async () => {
    const name = newName.trim() || t('newSessionDefaultName', { count: sessions.length + 1 })
    await createSession(workspaceId, name)
    setNewName('')
    setShowCreate(false)
  }

  const getPreview = (sessionId: string): string => {
    const sessionMessages = messages[sessionId] || []
    if (sessionMessages.length === 0) return t('startConversation')
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
              placeholder={t('sessionNamePlaceholder')}
              className="w-full px-3 py-2 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                className="flex-1 py-1.5 text-xs bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
              >
                {t('create')}
              </button>
              <button
                onClick={() => {
                  setShowCreate(false)
                  setNewName('')
                }}
                className="flex-1 py-1.5 text-xs bg-surface-hover hover:bg-surface-active text-text-secondary rounded-lg transition-colors"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-bg border border-border hover:border-border-hover rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('newSession')}
          </button>
        )}
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && sessions.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">{t('loadingSessions')}</div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary text-center">
            {t('noSessions')}
            <br />
            {t('createSessionPrompt')}
          </div>
        ) : (
          sessions.map((session) => {
            const rowState = deriveSessionState({
              isStreaming: !!isStreaming[session.id],
              pendingCount: sessionStatus[session.id]?.pendingCount ?? 0,
              unread: !!unreadCompletions[session.id],
              isActive: session.id === activeSessionId,
            })
            return (
            <div
              key={session.id}
              onClick={() => setActiveSession(workspaceId, session.id)}
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
                      <span className="px-1 py-0.5 text-[9px] bg-warning/20 text-warning rounded">
                        {t('draft')}
                      </span>
                    )}
                    {session.source === 'wecom' && (
                      <img
                        src="/wecom-icon.svg"
                        alt="WeCom"
                        className="w-3 h-3 flex-shrink-0"
                        title={t('wecomBotSession')}
                      />
                    )}
                    {rowState !== 'idle' && <StatusIndicator state={rowState} />}
                  </div>
                  <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                    {getPreview(session.id)}
                  </p>
                  <p className="text-[10px] text-text-tertiary/60 mt-1">
                    {getSessionTimestamp(session, t)}
                  </p>
                </div>
              </div>
            </div>
          )})
        )}
      </div>
    </div>
  )
}
