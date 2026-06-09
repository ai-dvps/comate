import type { TFunction } from 'i18next'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { shouldSubmitOnEnter } from '../lib/keyboard'
import { MessageSquare, Plus, Pencil, Shield, ShieldAlert, Puzzle } from 'lucide-react'
import PluginSettingsPage from './PluginSettingsPage'
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
  const { t: ts } = useTranslation('settings')
  const { useModifierToSubmit } = useAppSettings()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  const [showPluginSettings, setShowPluginSettings] = useState(false)

  const sessions = useChatStore((s) => s.sessions[workspaceId] || [])
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const messages = useChatStore((s) => s.messages)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const unreadCompletions = useChatStore((s) => s.unreadCompletions)
  const isLoading = useChatStore((s) => s.isLoadingSessions[workspaceId])
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const toggleSessionWip = useChatStore((s) => s.toggleSessionWip)

  const handleCreate = async () => {
    const name = newName.trim() || t('newSessionDefaultName', { count: sessions.length + 1 })
    await createSession(workspaceId, name)
    setNewName('')
    setShowCreate(false)
  }

  const startEdit = (session: import('../stores/chat-store').ChatSession) => {
    setEditingSessionId(session.id)
    setEditingName(getSessionDisplayName(session))
  }

  const commitEdit = async (sessionId: string) => {
    const trimmed = editingName.trim()
    if (trimmed) {
      await renameSession(workspaceId, sessionId, trimmed)
    }
    setEditingSessionId(null)
    setEditingName('')
  }

  const cancelEdit = () => {
    setEditingSessionId(null)
    setEditingName('')
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

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

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
                if (shouldSubmitOnEnter(e, useModifierToSubmit)) {
                  handleCreate()
                }
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
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id })
              }}
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
                    {editingSessionId === session.id ? (
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (shouldSubmitOnEnter(e, useModifierToSubmit)) {
                            e.preventDefault()
                            commitEdit(session.id)
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelEdit()
                          }
                        }}
                        onBlur={() => cancelEdit()}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 px-2 py-0.5 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary"
                      />
                    ) : (
                      <>
                        <p
                          className={`text-xs truncate ${
                            session.id === activeSessionId
                              ? 'text-text-primary font-medium'
                              : 'text-text-secondary'
                          }`}
                        >
                          {getSessionDisplayName(session)}
                        </p>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            startEdit(session)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-surface-hover text-text-tertiary hover:text-text-secondary transition-opacity"
                          title={t('renameSession')}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </>
                    )}
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
                  <div className="flex items-center gap-1.5 mt-1">
                    {session.isWip && (
                      <span className="px-1 py-0.5 text-[9px] bg-purple-500/20 text-purple-400 rounded">
                        {t('wip')}
                      </span>
                    )}
                    {session.approvalMode && session.approvalMode !== 'manual' && (
                      <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] rounded ${
                        session.approvalMode === 'auto'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-amber-500/20 text-amber-400'
                      }`}>
                        {session.approvalMode === 'auto' ? (
                          <ShieldAlert className="w-2.5 h-2.5" />
                        ) : (
                          <Shield className="w-2.5 h-2.5" />
                        )}
                        {t(`approvalMode.${session.approvalMode}`)}
                      </span>
                    )}
                    <span className="text-[10px] text-text-tertiary/60">
                      {getSessionTimestamp(session, t)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )})
        )}
      </div>

      {/* Plugin Settings Toolbar */}
      <div className="p-2 border-t border-border/50 flex-shrink-0">
        <button
          onClick={() => setShowPluginSettings(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-bg border border-border hover:border-border-hover rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <Puzzle className="w-3.5 h-3.5" />
          {ts('plugins.title')}
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        (() => {
          const session = sessions.find((s) => s.id === contextMenu.sessionId)
          if (!session) return null
          return (
            <div
              className="fixed z-50 min-w-[180px] bg-surface-active border border-border rounded-lg shadow-lg py-1"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  toggleSessionWip(workspaceId, session.id, !session.isWip)
                  setContextMenu(null)
                }}
                className="w-full px-3 py-2 text-left text-xs text-text-secondary hover:bg-surface-hover transition-colors"
              >
                {session.isWip ? t('clearWip') : t('markAsWip')}
              </button>
            </div>
          )
        })()
      )}

      {/* Plugin Settings Page */}
      {showPluginSettings && (
        <PluginSettingsPage
          workspaceId={workspaceId}
          onClose={() => setShowPluginSettings(false)}
        />
      )}
    </div>
  )
}
