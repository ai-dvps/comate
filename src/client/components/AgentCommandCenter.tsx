import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  CheckSquare,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Copy,
  Folder,
  FolderOpen,
  FlaskConical,
  GitBranch,
  Moon,
  MessageSquarePlus,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { getSessionDisplayName } from '../lib/session-filter'
import { openFolder } from '../lib/desktop-api'
import { useToastStore } from '../stores/toast-store'
import { useChatStore, type ChatSession } from '../stores/chat-store'
import {
  CHANNEL_STATUS_CLASS,
  CHANNEL_STATUS_DOT,
  useChannelStatuses,
  type ChannelStatus,
} from '../hooks/use-channel-statuses'
import { useTheme } from '../hooks/use-theme'
import { useTranslation } from 'react-i18next'
import { cn } from './ui/utils'
import ConfirmDialog from './ConfirmDialog'

interface AgentCommandCenterProps {
  width: number
  onWidthChange: (width: number) => void
  onCreateWorkspace: () => void
  onNewChat?: () => void
  onOpenTodos: () => void
  onOpenAnalytics: () => void
  onOpenSettings: () => void
  onOpenSettingsForWorkspace?: (workspaceId: string) => void
  onOpenCapabilities: () => void
  onActivateWork?: () => boolean
  activeDestination?: 'work' | 'new-chat' | 'todos' | 'analytics' | 'settings' | 'capabilities'
}

function relativeTime(session: ChatSession): string {
  const timestamp = session.lastModified ?? new Date(session.updatedAt).getTime()
  const elapsed = Math.max(0, Date.now() - Number(timestamp))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function startSessionNameScroll(row: HTMLElement) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const viewport = row.querySelector<HTMLElement>('[data-session-name-viewport]')
  const content = row.querySelector<HTMLElement>('[data-session-name-content]')
  if (!viewport || !content) return
  const distance = Math.max(0, content.scrollWidth - viewport.clientWidth)
  if (distance === 0) return
  content.style.transitionDuration = `${Math.max(900, (distance / 40) * 1000)}ms`
  content.style.transitionTimingFunction = 'linear'
  content.style.transform = `translateX(-${distance}px)`
}

function resetSessionNameScroll(row: HTMLElement) {
  const content = row.querySelector<HTMLElement>('[data-session-name-content]')
  if (!content) return
  content.style.transitionDuration = '180ms'
  content.style.transitionTimingFunction = 'ease-out'
  content.style.transform = 'translateX(0px)'
}

function BotConnectionStatus({
  channel,
  status,
}: {
  channel: 'WeCom' | 'Feishu'
  status: ChannelStatus
}) {
  const label = `${channel} bot ${status.replace('_', ' ')}`
  const iconSrc = channel === 'WeCom' ? '/wecom-icon.svg' : '/feishu-icon.svg'
  return (
    <span
      className={cn('relative flex h-5 w-5 items-center justify-center', CHANNEL_STATUS_CLASS[status])}
      aria-label={label}
      title={label}
    >
      <img src={iconSrc} alt="" className="h-3.5 w-3.5 object-contain" aria-hidden="true" />
      <span
        className={cn(
          'absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full ring-1 ring-chrome',
          CHANNEL_STATUS_DOT[status],
        )}
        aria-hidden="true"
      />
    </span>
  )
}

export default function AgentCommandCenter({
  width,
  onWidthChange,
  onCreateWorkspace,
  onNewChat = () => {},
  onOpenTodos,
  onOpenAnalytics,
  onOpenSettings,
  onOpenSettingsForWorkspace,
  onOpenCapabilities,
  onActivateWork,
  activeDestination = 'work',
}: AgentCommandCenterProps) {
  const { t } = useTranslation('common')
  const { t: tc } = useTranslation('chat')
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const openWorkspaceIds = useWorkspaceStore((state) => state.openWorkspaceIds)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace)
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace)
  const sessions = useChatStore((state) => state.sessions)
  const activeSessionIds = useChatStore((state) => state.activeSessionIds)
  const sessionStatus = useChatStore((state) => state.sessionStatus)
  const sessionActivity = useChatStore((state) => state.sessionActivity)
  const isStreaming = useChatStore((state) => state.isStreaming)
  const unreadCompletions = useChatStore((state) => state.unreadCompletions)
  const lastActivityAt = useChatStore((state) => state.lastActivityAt)
  const setActiveSession = useChatStore((state) => state.setActiveSession)
  const createSession = useChatStore((state) => state.createSession)
  const renameSession = useChatStore((state) => state.renameSession)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const forkSession = useChatStore((state) => state.forkSession)
  const toggleSessionWip = useChatStore((state) => state.toggleSessionWip)
  const toggleSessionArchive = useChatStore((state) => state.toggleSessionArchive)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const workspaceIds = useMemo(
    () => workspaces.map((workspace) => workspace.id),
    [workspaces],
  )
  const wecomStatuses = useChannelStatuses(workspaceIds, '/bot/status')
  const feishuStatuses = useChannelStatuses(workspaceIds, '/feishu/status')
  const { theme, toggleTheme } = useTheme()
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(workspaces.map((workspace) => workspace.id)),
  )
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<Record<string, number>>({})
  const [creatingWorkspaceId, setCreatingWorkspaceId] = useState<string | null>(null)
  const [newSessionName, setNewSessionName] = useState('')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingSessionName, setEditingSessionName] = useState('')
  const [contextMenu, setContextMenu] = useState<
    | { type: 'session'; x: number; y: number; workspaceId: string; sessionId: string }
    | { type: 'workspace'; x: number; y: number; workspaceId: string }
    | null
  >(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    workspaceId: string
    session: ChatSession
  } | null>(null)
  const dragRef = useRef<{ move: (event: MouseEvent) => void; up: () => void } | null>(null)
  const requestedSessionsRef = useRef(new Set<string>())
  const refreshingWorkspacesRef = useRef(new Set<string>())
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const userButtonRef = useRef<HTMLButtonElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const newSessionInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const newSessionTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current)
      workspaces.forEach((workspace) => next.add(workspace.id))
      return next
    })
  }, [workspaces])

  useEffect(() => {
    for (const workspace of workspaces) {
      if (
        Object.prototype.hasOwnProperty.call(sessions, workspace.id)
        || requestedSessionsRef.current.has(workspace.id)
      ) continue
      requestedSessionsRef.current.add(workspace.id)
      void fetchSessions(workspace.id)
    }
  }, [fetchSessions, sessions, workspaces])

  // Single refetch path for the workspace menu's Reload Sessions and U4's
  // focus refresh: guards against duplicate concurrent fetches per workspace.
  const refreshWorkspaceSessions = useCallback(async (workspaceId: string) => {
    if (refreshingWorkspacesRef.current.has(workspaceId)) return
    refreshingWorkspacesRef.current.add(workspaceId)
    try {
      await fetchSessions(workspaceId)
    } finally {
      refreshingWorkspacesRef.current.delete(workspaceId)
    }
  }, [fetchSessions])

  const openWorkspaceFolder = useCallback(async (folderPath: string) => {
    try {
      await openFolder(folderPath)
    } catch (error) {
      useToastStore.getState().addToast({
        severity: 'error',
        message: tc('workspaceMenu.openFolderFailed'),
      })
      console.error('Failed to open workspace folder:', error)
    }
  }, [tc])

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    document.removeEventListener('mousemove', dragRef.current.move)
    document.removeEventListener('mouseup', dragRef.current.up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    dragRef.current = null
  }, [])

  useEffect(() => endDrag, [endDrag])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (creatingWorkspaceId) newSessionInputRefs.current[creatingWorkspaceId]?.focus()
  }, [creatingWorkspaceId])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!userMenuOpen) return
    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (userButtonRef.current?.contains(target) || userMenuRef.current?.contains(target)) return
      setUserMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setUserMenuOpen(false)
      userButtonRef.current?.focus()
    }
    document.addEventListener('mousedown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [userMenuOpen])

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (moveEvent: MouseEvent) => onWidthChange(startWidth + moveEvent.clientX - startX)
    const up = () => endDrag()
    dragRef.current = { move, up }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [endDrag, onWidthChange, width])

  const normalizedQuery = query.trim().toLowerCase()

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    searchButtonRef.current?.focus()
  }

  const toggleWorkspace = useCallback((workspaceId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  const activateSession = async (workspaceId: string, sessionId: string) => {
    if (onActivateWork && !onActivateWork()) return
    if (!openWorkspaceIds.includes(workspaceId)) await openWorkspace(workspaceId)
    else if (activeWorkspaceId !== workspaceId) setActiveWorkspace(workspaceId)
    setActiveSession(workspaceId, sessionId)
  }

  const closeNewSessionForm = (workspaceId: string) => {
    newSessionTriggerRefs.current[workspaceId]?.focus()
    setCreatingWorkspaceId(null)
    setNewSessionName('')
  }

  const createWorkspaceSession = async (workspaceId: string, fallbackCount: number) => {
    if (!openWorkspaceIds.includes(workspaceId)) await openWorkspace(workspaceId)
    const name = newSessionName.trim() || tc('newSessionDefaultName', { count: fallbackCount })
    await createSession(workspaceId, { name })
    closeNewSessionForm(workspaceId)
  }

  const startRename = (session: ChatSession) => {
    setEditingSessionId(session.id)
    setEditingSessionName(getSessionDisplayName(session))
    setContextMenu(null)
  }

  const cancelRename = () => {
    setEditingSessionId(null)
    setEditingSessionName('')
  }

  const commitRename = async (workspaceId: string, sessionId: string) => {
    const name = editingSessionName.trim()
    if (name) await renameSession(workspaceId, sessionId, name)
    cancelRename()
  }

  const copySessionId = async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId)
    } catch (error) {
      console.error('Failed to copy session ID', error)
    }
    setContextMenu(null)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const { workspaceId, session } = deleteTarget
    setDeleteTarget(null)
    await deleteSession(workspaceId, session.id)
  }

  const navigation = [
    { id: 'new-chat' as const, label: t('newChat.title'), icon: MessageSquarePlus, action: onNewChat },
    { id: 'todos' as const, label: t('header.todos'), icon: CheckSquare, action: onOpenTodos },
    { id: 'capabilities' as const, label: t('shell.capabilities'), icon: Puzzle, action: onOpenCapabilities },
  ]
  const userDestinationActive = activeDestination === 'analytics' || activeDestination === 'settings'

  return (
    <aside
      aria-label={t('shell.commandCenter')}
      className={cn(
        'relative flex h-full flex-shrink-0 flex-col overflow-hidden bg-chrome transition-[width] duration-200 ease-out motion-reduce:transition-none',
        width > 0 && 'border-r border-border',
      )}
      style={{ width }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <nav className="flex flex-col gap-0.5 px-2 pb-0 pt-2" aria-label={t('shell.managementDestinations')}>
          {navigation.map(({ id, label, icon: Icon, action }) => (
            <button
              key={id}
              type="button"
              onClick={action}
              aria-label={label}
              aria-current={activeDestination === id ? 'page' : undefined}
              className={cn(
                'flex h-8 w-full items-center justify-start gap-2 rounded-md px-2 text-text-tertiary transition-colors',
                'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                activeDestination === id && 'bg-surface-active text-text-primary',
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="truncate text-xs font-medium">{label}</span>
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{t('shell.workspaces')}</span>
          <button
            ref={searchButtonRef}
            type="button"
            onClick={() => {
              if (searchOpen) closeSearch()
              else setSearchOpen(true)
            }}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors',
              'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              searchOpen && 'bg-surface-active text-text-primary',
            )}
            aria-label={t('shell.search')}
            aria-expanded={searchOpen}
            aria-controls="command-center-search"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onCreateWorkspace}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={t('shell.newWorkspace')}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div
          id="command-center-search"
          aria-hidden={!searchOpen}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            searchOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="px-2 pb-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') closeSearch()
                  }}
                  aria-label={t('shell.search')}
                  placeholder={t('shell.search')}
                  disabled={!searchOpen}
                  className="h-8 w-full rounded-md border border-border bg-bg pl-8 pr-8 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-1 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={closeSearch}
                  disabled={!searchOpen}
                  aria-label={t('shell.closeSearch')}
                  className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {workspaces.map((workspace) => {
            const workspaceSessions = sessions[workspace.id] ?? []
            const matchingSessions = workspaceSessions
              .filter((session) => !normalizedQuery
                || getSessionDisplayName(session).toLowerCase().includes(normalizedQuery)
                || workspace.name.toLowerCase().includes(normalizedQuery))
              .sort((left, right) => {
                const leftActivity = lastActivityAt[left.id]
                  ?? left.lastModified
                  ?? Date.parse(left.updatedAt)
                const rightActivity = lastActivityAt[right.id]
                  ?? right.lastModified
                  ?? Date.parse(right.updatedAt)
                return rightActivity - leftActivity
              })
            const visibleCount = visibleSessionCounts[workspace.id] ?? 5
            const visibleSessions = matchingSessions.slice(0, visibleCount)
            const hasMoreSessions = visibleSessions.length < matchingSessions.length
            const isExpanded = expanded.has(workspace.id)
            const isCreatingSession = creatingWorkspaceId === workspace.id
            const isWorkspaceActive = activeWorkspaceId === workspace.id
              && !activeSessionIds[workspace.id]
            const WorkspaceFolderIcon = isExpanded ? FolderOpen : Folder
            const needsUser = workspaceSessions.filter(
              (session) => (sessionStatus[session.id]?.pendingCount ?? 0) > 0,
            ).length
            const running = workspaceSessions.filter(
              (session) => isStreaming[session.id] || sessionActivity[session.id]?.active,
            ).length
            const unread = workspaceSessions.filter((session) => unreadCompletions[session.id]).length
            const wecomStatus = wecomStatuses[workspace.id]
            const feishuStatus = feishuStatuses[workspace.id]
            return (
              <section key={workspace.id} className="mb-1" aria-label={workspace.name}>
                <div
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setContextMenu({
                      type: 'workspace',
                      x: event.clientX,
                      y: event.clientY,
                      workspaceId: workspace.id,
                    })
                  }}
                  className={cn(
                    'group flex h-9 items-center gap-1 rounded-md px-1.5',
                    isWorkspaceActive ? 'bg-surface-active' : 'hover:bg-surface-hover',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleWorkspace(workspace.id)}
                    className="flex h-7 w-6 items-center justify-center rounded text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${workspace.name}`}
                    aria-expanded={isExpanded}
                  >
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none',
                        isExpanded && 'rotate-90',
                      )}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleWorkspace(workspace.id)}
                    aria-expanded={isExpanded}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <WorkspaceFolderIcon
                      className="h-3.5 w-3.5 flex-shrink-0 text-accent"
                      aria-hidden="true"
                    />
                    <span className="truncate">{workspace.name}</span>
                  </button>
                  {wecomStatus ? <BotConnectionStatus channel="WeCom" status={wecomStatus} /> : null}
                  {feishuStatus ? <BotConnectionStatus channel="Feishu" status={feishuStatus} /> : null}
                  {needsUser > 0 ? <span className="rounded bg-warning/15 px-1 text-[9px] font-medium text-warning" title="Needs user">{needsUser}</span> : null}
                  {running > 0 ? <span className="text-[9px] tabular-nums text-accent" title="Running">{running}</span> : null}
                  {unread > 0 ? <span className="text-[9px] tabular-nums text-text-secondary" title="Completed unread">{unread}</span> : null}
                  <button
                    ref={(button) => {
                      newSessionTriggerRefs.current[workspace.id] = button
                    }}
                    type="button"
                    onClick={() => {
                      setExpanded((current) => new Set(current).add(workspace.id))
                      setCreatingWorkspaceId(workspace.id)
                      setNewSessionName('')
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary opacity-0 hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={`New session in ${workspace.name}`}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>

                <div
                  data-testid={`workspace-sessions-${workspace.id}`}
                  className={cn(
                    'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                    isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                  )}
                  aria-hidden={!isExpanded}
                  {...(!isExpanded ? { inert: '' } : {})}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="ml-3 pl-1.5">
                      <div
                        data-testid={`new-session-form-${workspace.id}`}
                        className={cn(
                          'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none',
                          isCreatingSession
                            ? 'mb-1 grid-rows-[1fr] opacity-100'
                            : 'mb-0 grid-rows-[0fr] opacity-0',
                        )}
                        aria-hidden={!isCreatingSession}
                        {...(!isCreatingSession ? { inert: '' } : {})}
                      >
                        <div className="min-h-0 overflow-hidden">
                          <div className="rounded-md border border-border bg-bg p-2">
                            <input
                              ref={(input) => {
                                newSessionInputRefs.current[workspace.id] = input
                              }}
                              value={isCreatingSession ? newSessionName : ''}
                              onChange={(event) => setNewSessionName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  void createWorkspaceSession(workspace.id, workspaceSessions.length + 1)
                                } else if (event.key === 'Escape') {
                                  closeNewSessionForm(workspace.id)
                                }
                              }}
                              aria-label={tc('sessionNamePlaceholder')}
                              placeholder={tc('sessionNamePlaceholder')}
                              className="h-7 w-full rounded border border-border bg-surface px-2 text-[11px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent"
                            />
                            <div className="mt-1.5 flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => closeNewSessionForm(workspace.id)}
                                className="rounded px-2 py-1 text-[10px] text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                              >
                                {tc('cancel')}
                              </button>
                              <button
                                type="button"
                                onClick={() => void createWorkspaceSession(workspace.id, workspaceSessions.length + 1)}
                                className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent/90"
                              >
                                {tc('create')}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    {visibleSessions.map((session) => {
                      const status = sessionStatus[session.id]
                      const activityCount = sessionActivity[session.id]?.backgroundTasks.length ?? 0
                      const isActive = activeWorkspaceId === workspace.id
                        && activeSessionIds[workspace.id] === session.id
                      return (
                        <div
                          key={session.id}
                          onMouseEnter={(event) => startSessionNameScroll(event.currentTarget)}
                          onMouseLeave={(event) => resetSessionNameScroll(event.currentTarget)}
                          onFocus={(event) => startSessionNameScroll(event.currentTarget)}
                          onBlur={(event) => resetSessionNameScroll(event.currentTarget)}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            setContextMenu({
                              type: 'session',
                              x: event.clientX,
                              y: event.clientY,
                              workspaceId: workspace.id,
                              sessionId: session.id,
                            })
                          }}
                          className={cn(
                            'group/session relative flex min-h-9 w-full items-center rounded-md transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                            isActive ? 'bg-surface-active' : 'hover:bg-surface-hover',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => void activateSession(workspace.id, session.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            aria-current={isActive ? 'true' : undefined}
                          >
                            <span className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
                            {session.source === 'scheduled'
                              ? <Clock3 className="h-3.5 w-3.5 text-text-tertiary" aria-label={t('shell.scheduled')} />
                              : session.source === 'wecom' || session.source === 'feishu'
                                ? (
                                    <img
                                      src={session.source === 'wecom' ? '/wecom-icon.svg' : '/feishu-icon.svg'}
                                      alt={session.source === 'wecom' ? 'WeCom' : 'Feishu'}
                                      className="h-3.5 w-3.5 object-contain"
                                    />
                                  )
                                : <Sparkles className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
                            {(isStreaming[session.id] || sessionActivity[session.id]?.active) ? (
                              <span className="absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-accent ring-1 ring-chrome" title="Running" />
                            ) : null}
                            </span>
                            <span
                              data-testid={`session-line-${session.id}`}
                              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[9px] text-text-tertiary"
                            >
                              <span
                                data-testid={`session-name-${session.id}`}
                                data-session-name-viewport=""
                                title={getSessionDisplayName(session)}
                                className="min-w-0 flex-1 overflow-hidden"
                              >
                                <span
                                  data-session-name-content=""
                                  className={cn(
                                    'block w-max max-w-none whitespace-nowrap text-[11px] transition-transform motion-reduce:transition-none',
                                    isActive ? 'font-medium text-text-primary' : 'text-text-secondary',
                                  )}
                                >
                                  {getSessionDisplayName(session)}
                                </span>
                              </span>
                              {status?.pendingKind ? (
                                <span className="flex-shrink-0 whitespace-nowrap rounded bg-warning/15 px-1 font-medium text-warning">
                                  {status.pendingKind === 'approval' ? t('shell.approval') : t('shell.question')}
                                </span>
                              ) : null}
                              {session.isDraft ? <span className="flex-shrink-0 whitespace-nowrap rounded bg-surface-active px-1">{tc('draft')}</span> : null}
                              {session.isWip ? <span className="flex-shrink-0 whitespace-nowrap rounded bg-purple-500/15 px-1 text-purple-400">WIP</span> : null}
                              {activityCount > 0 ? <span className="flex-shrink-0 whitespace-nowrap">{activityCount} active</span> : null}
                              <span className="flex-shrink-0 whitespace-nowrap tabular-nums">{relativeTime(session)}</span>
                            </span>
                          </button>
                          {editingSessionId === session.id ? (
                            <input
                              autoFocus
                              value={editingSessionName}
                              onChange={(event) => setEditingSessionName(event.target.value)}
                              onBlur={cancelRename}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  void commitRename(workspace.id, session.id)
                                } else if (event.key === 'Escape') {
                                  cancelRename()
                                }
                              }}
                              aria-label={tc('renameSession')}
                              className="absolute inset-y-1 left-8 right-1 z-10 rounded border border-accent bg-bg px-1.5 text-[11px] text-text-primary outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => startRename(session)}
                              aria-label={tc('renameSession')}
                              title={`${tc('renameSession')}: ${getSessionDisplayName(session)}`}
                              className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary opacity-0 hover:bg-surface-hover hover:text-text-primary group-hover/session:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      )
                    })}
                    {hasMoreSessions ? (
                      <button
                        type="button"
                        onClick={() => setVisibleSessionCounts((current) => ({
                          ...current,
                          [workspace.id]: visibleCount + 5,
                        }))}
                        className="flex h-8 w-full items-center justify-start rounded-md px-2 text-[10px] font-medium text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        aria-label={t('shell.showMoreSessionsInWorkspace', { workspace: workspace.name })}
                      >
                        {t('shell.showMore')}
                      </button>
                    ) : null}
                    {visibleSessions.length === 0 ? (
                      <div className="px-2 py-2 text-[10px] text-text-tertiary">{t('shell.noMatchingSessions')}</div>
                    ) : null}
                    </div>
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      </div>

      <footer className="flex items-center gap-1 border-t border-border/70 p-2">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={t('shell.toggleTheme')}
        >
          {theme === 'dark'
            ? <Sun className="h-4 w-4" aria-hidden="true" />
            : <Moon className="h-4 w-4" aria-hidden="true" />}
        </button>
        <button
          ref={userButtonRef}
          type="button"
          onClick={() => setUserMenuOpen((open) => !open)}
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-text-secondary',
            'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            userDestinationActive && 'bg-surface-active text-text-primary',
          )}
          aria-label={t('shell.userAccount')}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-[9px] font-semibold text-accent">D</span>
          <span className="truncate">{t('shell.developer')}</span>
          <CircleUserRound className="ml-auto h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
        </button>
      </footer>

      {userMenuOpen ? (
        <div
          ref={userMenuRef}
          role="menu"
          aria-label={t('shell.userAccount')}
          className="absolute bottom-12 left-2 right-2 z-30 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            aria-current={activeDestination === 'analytics' ? 'page' : undefined}
            onClick={() => {
              setUserMenuOpen(false)
              onOpenAnalytics()
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-secondary',
              'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:bg-surface-hover',
              activeDestination === 'analytics' && 'bg-surface-active text-text-primary',
            )}
          >
            <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('header.analytics')}
          </button>
          <button
            type="button"
            role="menuitem"
            aria-current={activeDestination === 'settings' ? 'page' : undefined}
            onClick={() => {
              setUserMenuOpen(false)
              onOpenSettings()
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-secondary',
              'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:bg-surface-hover',
              activeDestination === 'settings' && 'bg-surface-active text-text-primary',
            )}
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            {t('header.settings')}
          </button>
        </div>
      ) : null}

      {contextMenu ? (() => {
        if (contextMenu.type === 'workspace') {
          const workspace = workspaces.find((candidate) => candidate.id === contextMenu.workspaceId)
          if (!workspace) return null
          const menuItemClass = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:bg-surface-hover disabled:opacity-50 disabled:pointer-events-none'
          return (
            <div
              role="menu"
              className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-xl"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  onOpenSettingsForWorkspace?.(workspace.id)
                  setContextMenu(null)
                }}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />{tc('workspaceMenu.editWorkspace')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                disabled={!workspace.folderPath}
                onClick={() => {
                  setContextMenu(null)
                  if (workspace.folderPath) void openWorkspaceFolder(workspace.folderPath)
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />{tc('workspaceMenu.openFolder')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  setContextMenu(null)
                  void refreshWorkspaceSessions(workspace.id)
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{tc('workspaceMenu.reloadSessions')}
              </button>
            </div>
          )
        }
        const session = sessions[contextMenu.workspaceId]?.find(
          (candidate) => candidate.id === contextMenu.sessionId,
        )
        if (!session) return null
        const menuItemClass = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:bg-surface-hover'
        return (
          <div
            role="menu"
            className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => startRename(session)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />{tc('renameSession')}
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => {
              void toggleSessionWip(contextMenu.workspaceId, session.id, !session.isWip)
              setContextMenu(null)
            }}>
              <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
              {session.isWip ? tc('clearWip') : tc('markAsWip')}
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => {
              void toggleSessionArchive(contextMenu.workspaceId, session.id, !session.isArchived)
              setContextMenu(null)
            }}>
              {session.isArchived
                ? <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                : <Archive className="h-3.5 w-3.5" aria-hidden="true" />}
              {session.isArchived ? tc('unarchive') : tc('archive')}
            </button>
            {session.isDraft ? (
              <button type="button" role="menuitem" className={cn(menuItemClass, 'text-destructive hover:text-destructive')} onClick={() => {
                setDeleteTarget({ workspaceId: contextMenu.workspaceId, session })
                setContextMenu(null)
              }}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{tc('deleteSession')}
              </button>
            ) : null}
            <div className="my-1 border-t border-border" />
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => void copySessionId(session.id)}>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />{tc('copySessionId')}
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => {
              setContextMenu(null)
              void forkSession(contextMenu.workspaceId, session.id)
            }}>
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />{tc('forkSession')}
            </button>
          </div>
        )
      })() : null}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={tc('deleteSessionConfirmTitle')}
        message={tc('deleteSessionConfirmMessage', {
          name: deleteTarget ? getSessionDisplayName(deleteTarget.session) : '',
        })}
        confirmLabel={tc('deleteSessionConfirm')}
        cancelLabel={tc('deleteSessionCancel')}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <div
        data-testid="command-center-resize-handle"
        className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize hover:bg-accent/50"
        onMouseDown={handleResizeStart}
      />
    </aside>
  )
}
