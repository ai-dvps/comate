import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { shouldSubmitOnEnter } from '../lib/keyboard'
import { getSessionDisplayName, matchesSessionQuery } from '../lib/session-filter'
import { Plus, Puzzle, BookOpen, Search, X } from 'lucide-react'
import PluginSettingsPage from './PluginSettingsPage'
import SkillsPage from './SkillsPage'
import SessionListItem from './SessionListItem'

const EMPTY_ARRAY: [] = []

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
  const [showSkillsPage, setShowSkillsPage] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const sessions = useChatStore((s) => s.sessions[workspaceId] ?? EMPTY_ARRAY)
  const activeSessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const messages = useChatStore((s) => s.messages)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const unreadCompletions = useChatStore((s) => s.unreadCompletions)
  const isLoading = useChatStore((s) => s.isLoadingSessions[workspaceId])
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const createSession = useChatStore((s) => s.createSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const toggleSessionWip = useChatStore((s) => s.toggleSessionWip)

  const trimmedQuery = searchQuery.trim()
  const activeMatches = activeSession ? matchesSessionQuery(activeSession, trimmedQuery) : false
  const filteredSessions = useMemo(
    () => sessions.filter((session) => session.id !== activeSessionId && matchesSessionQuery(session, trimmedQuery)),
    [sessions, activeSessionId, trimmedQuery],
  )
  const matchCount = (activeMatches ? 1 : 0) + filteredSessions.length

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

  // Cancel any in-flight rename when the active session changes so the input
  // does not follow a stale session into the pinned header.
  useEffect(() => {
    setEditingSessionId(null)
    setEditingName('')
  }, [activeSessionId])

  // Reset search when switching workspaces.
  useEffect(() => {
    setSearchQuery('')
  }, [workspaceId])

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId })
  }

  const handleActivate = (sessionId: string) => {
    setActiveSession(workspaceId, sessionId)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (searchQuery) {
        setSearchQuery('')
      } else {
        searchInputRef.current?.blur()
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
    }
  }

  const handleSearchFocus = () => {
    // Cancel any in-flight rename so two text inputs don't compete for attention.
    setEditingSessionId(null)
    setEditingName('')
  }

  const clearSearch = () => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  const searchDisabled = isLoading && sessions.length === 0

  return (
    <div className="flex flex-col h-full">
      {/* New Session Button + Search */}
      <div className="p-3 space-y-2">
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

        {/* Search */}
        <div className="relative" role="search">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <Search className="w-3.5 h-3.5 text-text-tertiary" />
          </div>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onFocus={handleSearchFocus}
            placeholder={t('searchSessions')}
            aria-label={t('searchSessions')}
            disabled={searchDisabled}
            className="w-full pl-8 pr-7 py-2 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {trimmedQuery && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label={t('clearSearch')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Pinned Active Session Header */}
      {activeSession && activeMatches && (
        <SessionListItem
          session={activeSession}
          variant="pinned"
          displayName={getSessionDisplayName(activeSession)}
          isActive
          isStreaming={!!isStreaming[activeSession.id]}
          pendingCount={sessionStatus[activeSession.id]?.pendingCount ?? 0}
          unread={!!unreadCompletions[activeSession.id]}
          preview={getPreview(activeSession.id)}
          editingSessionId={editingSessionId}
          editingName={editingName}
          useModifierToSubmit={useModifierToSubmit}
          onStartEdit={startEdit}
          onCommitEdit={commitEdit}
          onCancelEdit={cancelEdit}
          onSetEditingName={setEditingName}
          onContextMenu={handleContextMenu}
          onActivate={handleActivate}
          t={t}
        />
      )}

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
        ) : trimmedQuery && matchCount === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary text-center">{t('noMatchingSessions')}</div>
        ) : (
          filteredSessions.map((session) => (
            <SessionListItem
              key={session.id}
              session={session}
              variant="list"
              displayName={getSessionDisplayName(session)}
              isActive={false}
              isStreaming={!!isStreaming[session.id]}
              pendingCount={sessionStatus[session.id]?.pendingCount ?? 0}
              unread={!!unreadCompletions[session.id]}
              preview={getPreview(session.id)}
              editingSessionId={editingSessionId}
              editingName={editingName}
              useModifierToSubmit={useModifierToSubmit}
              onStartEdit={startEdit}
              onCommitEdit={commitEdit}
              onCancelEdit={cancelEdit}
              onSetEditingName={setEditingName}
              onContextMenu={handleContextMenu}
              onActivate={handleActivate}
              t={t}
            />
          ))
        )}
      </div>

      {/* Live region for filtered result count */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {trimmedQuery ? t('matchingSessionCount', { count: matchCount }) : ''}
      </div>

      {/* Plugin + Skills Settings Toolbar */}
      <div className="p-2 border-t border-border/50 flex-shrink-0 flex gap-2">
        <button
          onClick={() => setShowPluginSettings(true)}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-bg border border-border hover:border-border-hover rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <Puzzle className="w-3.5 h-3.5" />
          {ts('plugins.title')}
        </button>
        <button
          onClick={() => setShowSkillsPage(true)}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-bg border border-border hover:border-border-hover rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors"
          title={ts('skills.toolbarButton')}
        >
          <BookOpen className="w-3.5 h-3.5" />
          {ts('skills.toolbarButton')}
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

      {/* Skills Page */}
      {showSkillsPage && (
        <SkillsPage
          workspaceId={workspaceId}
          onClose={() => setShowSkillsPage(false)}
        />
      )}
    </div>
  )
}
