import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from 'react-i18next'
import { Folder, X } from 'lucide-react'
import StatusIndicator from './StatusIndicator'

type BotStatus = 'connected' | 'disconnected' | 'error' | 'not_configured'

function getBotStatusLabel(status: BotStatus, t: (key: string) => string): string {
  const labels: Record<BotStatus, string> = {
    connected: t('workspaceTabs.botConnected'),
    disconnected: t('workspaceTabs.botDisconnected'),
    error: t('workspaceTabs.botError'),
    not_configured: t('workspaceTabs.botNotConfigured'),
  }
  return labels[status]
}

const BOT_STATUS_CLASS: Record<BotStatus, string> = {
  connected: 'opacity-100',
  disconnected: 'opacity-40 grayscale',
  error: 'opacity-100',
  not_configured: 'opacity-40 grayscale',
}

const BOT_STATUS_DOT: Record<BotStatus, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-text-tertiary',
  error: 'bg-warning',
  not_configured: 'bg-text-tertiary',
}

const OVERFLOW_BUTTON_WIDTH = 48
const GAP_WIDTH = 4

interface WorkspaceItem {
  id: string
  name: string
  settings: { wecomBotEnabled?: boolean }
}

interface TabPillProps {
  ws: WorkspaceItem
  isActive: boolean
  counts: { needsMe: number; finishedUnread: number; streaming: number }
  botStatus?: BotStatus
  botStatusTitle?: string
  onClick: () => void
  onClose?: (e: React.MouseEvent) => void
  closeLabel?: string
}

function TabPill({ ws, isActive, counts, botStatus, botStatusTitle, onClick, onClose, closeLabel }: TabPillProps) {
  return (
    <div
      data-tab-id={ws.id}
      className={`tab-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer text-xs transition-all group whitespace-nowrap ${
        isActive
          ? 'bg-surface-hover text-text-primary'
          : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
      }`}
      onClick={onClick}
      role="tab"
      aria-selected={isActive}
    >
      <Folder className={`w-3 h-3 flex-shrink-0 ${isActive ? 'text-accent' : 'text-text-tertiary'}`} />
      <span className="truncate max-w-[100px]">{ws.name}</span>
      {botStatus && (
        <span className="relative inline-flex flex-shrink-0" title={botStatusTitle}>
          <img
            src="/wecom-icon.svg"
            alt="WeCom"
            className={`w-3 h-3 flex-shrink-0 ${BOT_STATUS_CLASS[botStatus]}`}
          />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${BOT_STATUS_DOT[botStatus]} ring-1 ring-bg`}
          />
        </span>
      )}
      {counts.needsMe > 0 && <StatusIndicator state="needs-me" count={counts.needsMe} />}
      {counts.finishedUnread > 0 && <StatusIndicator state="finished-unread" count={counts.finishedUnread} />}
      {counts.streaming > 0 && <StatusIndicator state="streaming" count={counts.streaming} />}
      {onClose && (
        <button
          className={`ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-destructive transition-all ${
            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          onClick={onClose}
          aria-label={closeLabel}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

export default function WorkspaceTabs() {
  const { t } = useTranslation('settings')
  const { workspaces, openWorkspaceIds, activeWorkspaceId, setActiveWorkspace, closeWorkspace } =
    useWorkspaceStore()

  const sessions = useChatStore((s) => s.sessions)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const unreadCompletions = useChatStore((s) => s.unreadCompletions)
  const activeSessionIds = useChatStore((s) => s.activeSessionIds)

  const [botStatuses, setBotStatuses] = useState<Record<string, BotStatus>>({})
  const [overflowIds, setOverflowIds] = useState<Set<string>>(new Set())
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [resizeTick, setResizeTick] = useState(0)

  const visibleRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const openWorkspaces = openWorkspaceIds
    .map((id) => workspaces.find((w) => w.id === id))
    .filter(Boolean) as WorkspaceItem[]

  useEffect(() => {
    const enabledIds = openWorkspaceIds.filter((id) => {
      const ws = workspaces.find((w) => w.id === id)
      return ws?.settings.wecomBotEnabled
    })
    if (enabledIds.length === 0) {
      setBotStatuses({})
      return
    }

    const fetchStatuses = async () => {
      const results = await Promise.all(
        enabledIds.map(async (id) => {
          try {
            const res = await fetch(`/api/workspaces/${id}/bot/status`)
            if (!res.ok) return { id, status: 'error' as BotStatus }
            const data = await res.json()
            return { id, status: (data.status as BotStatus) ?? 'error' }
          } catch {
            return { id, status: 'error' as BotStatus }
          }
        })
      )
      const next: Record<string, BotStatus> = {}
      for (const { id, status } of results) {
        next[id] = status
      }
      setBotStatuses(next)
    }

    fetchStatuses()
    const interval = setInterval(fetchStatuses, 5000)
    return () => clearInterval(interval)
  }, [openWorkspaceIds, workspaces])

  useEffect(() => {
    if (!visibleRef.current || !measureRef.current) return
    const observer = new ResizeObserver(() => {
      setResizeTick((t) => t + 1)
    })
    observer.observe(visibleRef.current)
    observer.observe(measureRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isDropdownOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsDropdownOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isDropdownOpen])

  const getWorkspaceCounts = (workspaceId: string) => {
    const list = sessions[workspaceId] ?? []
    const activeId = activeSessionIds[workspaceId]
    let needsMe = 0
    let finishedUnread = 0
    let streaming = 0
    for (const s of list) {
      if ((sessionStatus[s.id]?.pendingCount ?? 0) > 0) needsMe++
      if (unreadCompletions[s.id] && s.id !== activeId) finishedUnread++
      if (isStreaming[s.id]) streaming++
    }
    return { needsMe, finishedUnread, streaming }
  }

  useLayoutEffect(() => {
    if (!visibleRef.current || !measureRef.current || openWorkspaces.length === 0) {
      setOverflowIds(new Set())
      return
    }

    const widths = new Map<string, number>()
    measureRef.current.querySelectorAll('[data-tab-id]').forEach((tab) => {
      const id = tab.getAttribute('data-tab-id')
      if (id) widths.set(id, (tab as HTMLElement).offsetWidth)
    })

    const containerWidth = visibleRef.current.clientWidth
    const availableWidth = containerWidth - OVERFLOW_BUTTON_WIDTH

    const tabsWithPriority = openWorkspaces.map((ws, index) => {
      const counts = getWorkspaceCounts(ws.id)
      const botStatus = botStatuses[ws.id]
      let priority = 1
      if (activeWorkspaceId === ws.id) {
        priority = 3
      } else if (
        counts.needsMe > 0 ||
        counts.finishedUnread > 0 ||
        counts.streaming > 0 ||
        botStatus === 'error'
      ) {
        priority = 2
      }
      return {
        id: ws.id,
        priority,
        index,
        width: widths.get(ws.id) ?? 0,
      }
    })

    const sorted = [...tabsWithPriority].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.index - b.index
    })

    let usedWidth = 0
    let visibleCount = 0
    for (const tab of sorted) {
      const tabTotalWidth = tab.width + (visibleCount > 0 ? GAP_WIDTH : 0)
      if (usedWidth + tabTotalWidth <= availableWidth) {
        usedWidth += tabTotalWidth
        visibleCount++
      } else {
        break
      }
    }

    // Always show at least one tab to avoid empty tab bar
    if (visibleCount === 0 && sorted.length > 0) {
      visibleCount = 1
    }

    const visibleIds = new Set(sorted.slice(0, visibleCount).map((t) => t.id))
    const newOverflowIds = new Set(
      openWorkspaces.filter((ws) => !visibleIds.has(ws.id)).map((ws) => ws.id)
    )

    setOverflowIds((prev) => {
      if (
        prev.size !== newOverflowIds.size ||
        Array.from(prev).some((id) => !newOverflowIds.has(id)) ||
        Array.from(newOverflowIds).some((id) => !prev.has(id))
      ) {
        return newOverflowIds
      }
      return prev
    })
  }, [
    openWorkspaces,
    activeWorkspaceId,
    botStatuses,
    sessions,
    sessionStatus,
    unreadCompletions,
    isStreaming,
    activeSessionIds,
    resizeTick,
  ])

  const visibleWorkspaces = openWorkspaces.filter((ws) => !overflowIds.has(ws.id))
  const hiddenWorkspaces = openWorkspaces.filter((ws) => overflowIds.has(ws.id))

  const hasHiddenStatus = hiddenWorkspaces.some((ws) => {
    const counts = getWorkspaceCounts(ws.id)
    const botStatus = botStatuses[ws.id]
    return (
      counts.needsMe > 0 ||
      counts.finishedUnread > 0 ||
      counts.streaming > 0 ||
      botStatus === 'error'
    )
  })

  const handleSelectHidden = (id: string) => {
    setActiveWorkspace(id)
    setIsDropdownOpen(false)
  }

  const handleCloseHidden = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    closeWorkspace(id)
    if (hiddenWorkspaces.length <= 1) {
      setIsDropdownOpen(false)
    }
  }

  return (
    <div className="flex items-center gap-1 min-w-0 relative">
      {/* Visible tabs */}
      <div ref={visibleRef} className="flex items-center gap-1 min-w-0 overflow-hidden">
        {visibleWorkspaces.map((ws) => {
          const isActive = activeWorkspaceId === ws.id
          const counts = getWorkspaceCounts(ws.id)
          const botStatus = botStatuses[ws.id]
          return (
            <TabPill
              key={ws.id}
              ws={ws}
              isActive={isActive}
              counts={counts}
              botStatus={botStatus}
              botStatusTitle={botStatus ? getBotStatusLabel(botStatus, t) : undefined}
              onClick={() => setActiveWorkspace(ws.id)}
              onClose={
                openWorkspaces.length > 1
                  ? (e) => {
                      e.stopPropagation()
                      closeWorkspace(ws.id)
                    }
                  : undefined
              }
              closeLabel={t('workspaceTabs.closeTab', { name: ws.name })}
            />
          )
        })}
      </div>

      {/* Overflow button */}
      {overflowIds.size > 0 && (
        <div className="relative flex-shrink-0">
          <button
            ref={buttonRef}
            onClick={() => setIsDropdownOpen((prev) => !prev)}
            className={`flex items-center justify-center h-[29px] px-2 rounded-lg text-xs font-medium transition-colors ${
              isDropdownOpen
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
            }`}
            aria-expanded={isDropdownOpen}
          >
            <span>+{overflowIds.size}</span>
            {hasHiddenStatus && (
              <span className="ml-1 w-1.5 h-1.5 rounded-full bg-warning" />
            )}
          </button>

          {/* Dropdown */}
          {isDropdownOpen && (
            <div
              ref={dropdownRef}
              className="absolute top-full right-0 mt-1 z-40 w-64 bg-surface border border-border rounded-xl shadow-lg overflow-hidden"
            >
              <div className="px-3 py-2 border-b border-border/50">
                <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide">
                  {t('workspaceTabs.hiddenTabs')}
                </span>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {hiddenWorkspaces.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-text-tertiary text-center">
                    {t('workspaceTabs.noHiddenTabs')}
                  </div>
                ) : (
                  hiddenWorkspaces.map((ws) => {
                    const isActive = activeWorkspaceId === ws.id
                    const counts = getWorkspaceCounts(ws.id)
                    const botStatus = botStatuses[ws.id]
                    return (
                      <div
                        key={ws.id}
                        onClick={() => handleSelectHidden(ws.id)}
                        className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-surface-active text-text-primary'
                            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                        }`}
                      >
                        <Folder
                          className={`w-3 h-3 flex-shrink-0 ${
                            isActive ? 'text-accent' : 'text-text-tertiary'
                          }`}
                        />
                        <span className="truncate flex-1">{ws.name}</span>
                        {botStatus && (
                          <span
                            className="relative inline-flex flex-shrink-0"
                            title={getBotStatusLabel(botStatus, t)}
                          >
                            <img
                              src="/wecom-icon.svg"
                              alt="WeCom"
                              className={`w-3 h-3 flex-shrink-0 ${BOT_STATUS_CLASS[botStatus]}`}
                            />
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${BOT_STATUS_DOT[botStatus]} ring-1 ring-bg`}
                            />
                          </span>
                        )}
                        {counts.needsMe > 0 && (
                          <StatusIndicator state="needs-me" count={counts.needsMe} />
                        )}
                        {counts.finishedUnread > 0 && (
                          <StatusIndicator state="finished-unread" count={counts.finishedUnread} />
                        )}
                        {counts.streaming > 0 && (
                          <StatusIndicator state="streaming" count={counts.streaming} />
                        )}
                        {openWorkspaces.length > 1 && (
                          <button
                            className="ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-destructive transition-all"
                            onClick={(e) => handleCloseHidden(e, ws.id)}
                            aria-label={t('workspaceTabs.closeTab', { name: ws.name })}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Hidden measurement container */}
      <div
        ref={measureRef}
        className="absolute top-0 left-0 opacity-0 pointer-events-none -z-10"
        aria-hidden="true"
      >
        <div className="flex items-center gap-1">
          {openWorkspaces.map((ws) => {
            const isActive = activeWorkspaceId === ws.id
            const counts = getWorkspaceCounts(ws.id)
            const botStatus = botStatuses[ws.id]
            return (
              <TabPill
                key={`measure-${ws.id}`}
                ws={ws}
                isActive={isActive}
                counts={counts}
                botStatus={botStatus}
                botStatusTitle={botStatus ? getBotStatusLabel(botStatus, t) : undefined}
                onClick={() => {}}
                onClose={
                  openWorkspaces.length > 1
                    ? (e) => {
                        e.stopPropagation()
                      }
                    : undefined
                }
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
