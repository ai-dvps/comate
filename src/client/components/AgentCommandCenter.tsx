import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bot,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Folder,
  Moon,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { getSessionDisplayName } from '../lib/session-filter'
import { useChatStore, type ChatSession } from '../stores/chat-store'
import { useChannelStatuses } from '../hooks/use-channel-statuses'
import { useTheme } from '../hooks/use-theme'
import { cn } from './ui/utils'

type CommandFilter = 'all' | 'needs-user' | 'running' | 'wip'

interface AgentCommandCenterProps {
  width: number
  onWidthChange: (width: number) => void
  onCreateWorkspace: () => void
  onOpenTodos: () => void
  onOpenAnalytics: () => void
  onOpenSettings: () => void
  onOpenCapabilities: () => void
  activeDestination?: 'work' | 'todos' | 'analytics' | 'settings' | 'capabilities'
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

export default function AgentCommandCenter({
  width,
  onWidthChange,
  onCreateWorkspace,
  onOpenTodos,
  onOpenAnalytics,
  onOpenSettings,
  onOpenCapabilities,
  activeDestination = 'work',
}: AgentCommandCenterProps) {
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
  const setActiveSession = useChatStore((state) => state.setActiveSession)
  const createSession = useChatStore((state) => state.createSession)
  const wecomStatuses = useChannelStatuses(openWorkspaceIds, '/bot/status')
  const feishuStatuses = useChannelStatuses(openWorkspaceIds, '/feishu/status')
  const { theme, toggleTheme } = useTheme()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CommandFilter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(openWorkspaceIds))
  const dragRef = useRef<{ move: (event: MouseEvent) => void; up: () => void } | null>(null)

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current)
      openWorkspaceIds.forEach((id) => next.add(id))
      return next
    })
  }, [openWorkspaceIds])

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    document.removeEventListener('mousemove', dragRef.current.move)
    document.removeEventListener('mouseup', dragRef.current.up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    dragRef.current = null
  }, [])

  useEffect(() => endDrag, [endDrag])

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
  const openWorkspaces = useMemo(
    () => openWorkspaceIds.flatMap((id) => {
      const workspace = workspaces.find((item) => item.id === id)
      return workspace ? [workspace] : []
    }),
    [openWorkspaceIds, workspaces],
  )
  const unopenedMatches = useMemo(
    () => normalizedQuery
      ? workspaces.filter((workspace) => !openWorkspaceIds.includes(workspace.id)
        && workspace.name.toLowerCase().includes(normalizedQuery))
      : [],
    [normalizedQuery, openWorkspaceIds, workspaces],
  )

  const matchesFilter = (session: ChatSession): boolean => {
    if (filter === 'needs-user') return (sessionStatus[session.id]?.pendingCount ?? 0) > 0
    if (filter === 'running') return Boolean(isStreaming[session.id] || sessionActivity[session.id]?.active)
    if (filter === 'wip') return session.isWip === true
    return true
  }

  const activateSession = (workspaceId: string, sessionId: string) => {
    if (activeWorkspaceId !== workspaceId) setActiveWorkspace(workspaceId)
    setActiveSession(workspaceId, sessionId)
  }

  const navigation = [
    { id: 'todos' as const, label: 'Todos', icon: CheckSquare, action: onOpenTodos },
    { id: 'analytics' as const, label: 'Analytics', icon: BarChart3, action: onOpenAnalytics },
    { id: 'capabilities' as const, label: 'Plugins / Skills', icon: Puzzle, action: onOpenCapabilities },
    { id: 'settings' as const, label: 'Settings', icon: Settings, action: onOpenSettings },
  ]

  return (
    <aside
      aria-label="Agent Command Center"
      className="relative flex h-full flex-shrink-0 flex-col overflow-hidden border-r border-border bg-chrome transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={{ width }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="space-y-2 border-b border-border/70 p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspaces and sessions"
              placeholder="Search workspaces and sessions"
              className="h-8 w-full rounded-md border border-border bg-bg pl-8 pr-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="grid grid-cols-4 gap-1" aria-label="Management destinations">
            {navigation.map(({ id, label, icon: Icon, action }) => (
              <button
                key={id}
                type="button"
                onClick={action}
                aria-label={label}
                aria-current={activeDestination === id ? 'page' : undefined}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md text-text-tertiary transition-colors',
                  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  activeDestination === id && 'bg-surface-active text-text-primary',
                )}
                title={label}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Workspaces</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as CommandFilter)}
            aria-label="Filter sessions"
            className="h-6 rounded border border-border bg-bg px-1 text-[10px] text-text-secondary outline-none focus:border-accent"
          >
            <option value="all">All</option>
            <option value="needs-user">Needs user</option>
            <option value="running">Running</option>
            <option value="wip">WIP</option>
          </select>
          <button
            type="button"
            onClick={onCreateWorkspace}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="New workspace"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {unopenedMatches.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              onClick={() => void openWorkspace(workspace.id)}
              aria-label={`Open ${workspace.name}`}
              className="mb-1 flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-left text-xs text-text-secondary hover:border-accent/50 hover:bg-surface-hover"
            >
              <Folder className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <span className="text-[9px] uppercase text-text-tertiary">Open</span>
            </button>
          ))}

          {openWorkspaces.map((workspace) => {
            const workspaceSessions = sessions[workspace.id] ?? []
            const visibleSessions = workspaceSessions.filter((session) => {
              const queryMatch = !normalizedQuery
                || getSessionDisplayName(session).toLowerCase().includes(normalizedQuery)
                || workspace.name.toLowerCase().includes(normalizedQuery)
              return queryMatch && matchesFilter(session)
            })
            const isExpanded = expanded.has(workspace.id)
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
                  className={cn(
                    'group flex h-9 items-center gap-1 rounded-md px-1.5',
                    activeWorkspaceId === workspace.id ? 'bg-surface-active' : 'hover:bg-surface-hover',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(workspace.id)) next.delete(workspace.id)
                      else next.add(workspace.id)
                      return next
                    })}
                    className="flex h-7 w-6 items-center justify-center rounded text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${workspace.name}`}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveWorkspace(workspace.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Folder className="h-3.5 w-3.5 flex-shrink-0 text-accent" aria-hidden="true" />
                    <span className="truncate">{workspace.name}</span>
                  </button>
                  {wecomStatus ? <span className={cn('h-1.5 w-1.5 rounded-full', wecomStatus === 'connected' ? 'bg-success' : 'bg-text-tertiary')} title={`WeCom ${wecomStatus}`} /> : null}
                  {feishuStatus ? <span className={cn('h-1.5 w-1.5 rounded-full', feishuStatus === 'connected' ? 'bg-success' : 'bg-text-tertiary')} title={`Feishu ${feishuStatus}`} /> : null}
                  {needsUser > 0 ? <span className="rounded bg-warning/15 px-1 text-[9px] font-medium text-warning" title="Needs user">{needsUser}</span> : null}
                  {running > 0 ? <span className="text-[9px] tabular-nums text-accent" title="Running">{running}</span> : null}
                  {unread > 0 ? <span className="text-[9px] tabular-nums text-text-secondary" title="Completed unread">{unread}</span> : null}
                  <button
                    type="button"
                    onClick={() => void createSession(workspace.id, `New session ${workspaceSessions.length + 1}`)}
                    className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary opacity-0 hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent"
                    aria-label={`New session in ${workspace.name}`}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>

                {isExpanded ? (
                  <div className="ml-3 border-l border-border/70 pl-1.5">
                    {visibleSessions.map((session) => {
                      const status = sessionStatus[session.id]
                      const activityCount = sessionActivity[session.id]?.backgroundTasks.length ?? 0
                      const isActive = activeWorkspaceId === workspace.id
                        && activeSessionIds[workspace.id] === session.id
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => activateSession(workspace.id, session.id)}
                          className={cn(
                            'group/session flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                            isActive ? 'bg-surface-active' : 'hover:bg-surface-hover',
                          )}
                          aria-current={isActive ? 'true' : undefined}
                        >
                          <span className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
                            {session.source === 'scheduled'
                              ? <Clock3 className="h-3.5 w-3.5 text-text-tertiary" aria-label="Scheduled" />
                              : session.source === 'wecom' || session.source === 'feishu'
                                ? <Bot className="h-3.5 w-3.5 text-text-tertiary" aria-label="Bot session" />
                                : <Sparkles className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
                            {(isStreaming[session.id] || sessionActivity[session.id]?.active) ? (
                              <span className="absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-accent ring-1 ring-chrome" title="Running" />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cn('block truncate text-[11px]', isActive ? 'font-medium text-text-primary' : 'text-text-secondary')}>
                              {getSessionDisplayName(session)}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1 text-[9px] text-text-tertiary">
                              {status?.pendingKind ? (
                                <span className="rounded bg-warning/15 px-1 font-medium text-warning">
                                  {status.pendingKind === 'approval' ? 'Approval' : 'Question'}
                                </span>
                              ) : null}
                              {session.isWip ? <span className="rounded bg-purple-500/15 px-1 text-purple-400">WIP</span> : null}
                              {activityCount > 0 ? <span>{activityCount} active</span> : null}
                              <span className="ml-auto tabular-nums">{relativeTime(session)}</span>
                            </span>
                          </span>
                        </button>
                      )
                    })}
                    {visibleSessions.length === 0 ? (
                      <div className="px-2 py-2 text-[10px] text-text-tertiary">No matching sessions</div>
                    ) : null}
                  </div>
                ) : null}
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
          aria-label="Toggle theme"
        >
          {theme === 'dark'
            ? <Sun className="h-4 w-4" aria-hidden="true" />
            : <Moon className="h-4 w-4" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="User account"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-[9px] font-semibold text-accent">D</span>
          <span className="truncate">Developer</span>
          <CircleUserRound className="ml-auto h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
        </button>
      </footer>

      <div
        data-testid="command-center-resize-handle"
        className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize hover:bg-accent/50"
        onMouseDown={handleResizeStart}
      />
    </aside>
  )
}
