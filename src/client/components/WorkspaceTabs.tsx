import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from 'react-i18next'
import { Folder, X, ChevronDown, Search } from 'lucide-react'
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
      className={`tab-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer text-xs transition-all group whitespace-nowrap flex-shrink-0 ${
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
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const openWorkspaces = useMemo(
    () =>
      openWorkspaceIds
        .map((id) => workspaces.find((w) => w.id === id))
        .filter(Boolean) as WorkspaceItem[],
    [openWorkspaceIds, workspaces]
  )

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

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (!scrollRef.current || !activeWorkspaceId) return
    const activeTab = scrollRef.current.querySelector(`[data-tab-id="${activeWorkspaceId}"]`)
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }
  }, [activeWorkspaceId])

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

  const filteredWorkspaces = useMemo(() => {
    if (!searchQuery.trim()) return openWorkspaces
    const query = searchQuery.toLowerCase()
    return openWorkspaces.filter((ws) => ws.name.toLowerCase().includes(query))
  }, [openWorkspaces, searchQuery])

  const handleSelectFromDropdown = (id: string) => {
    setActiveWorkspace(id)
    setIsDropdownOpen(false)
    setSearchQuery('')
  }

  const handleCloseFromDropdown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    closeWorkspace(id)
  }

  return (
    <div className="flex items-center gap-1 min-w-0 relative">
      {/* Scrollable tabs — wrapped in overflow-hidden to prevent window-level scroll */}
      <div className="overflow-hidden flex-1 min-w-0">
        <div
          ref={scrollRef}
          className="flex items-center gap-1 overflow-x-auto scrollbar-hide"
        >
        {openWorkspaces.map((ws) => {
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
      </div>

      {/* Persistent dropdown button */}
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
          aria-label={t('workspaceTabs.openTabList')}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>

        {/* Dropdown */}
        {isDropdownOpen && (
          <div
            ref={dropdownRef}
            className="absolute top-full right-0 mt-1 z-40 w-64 bg-surface border border-border rounded-xl shadow-lg overflow-hidden"
          >
            {/* Search input */}
            <div className="px-3 py-2 border-b border-border/50">
              <div className="flex items-center gap-2 px-2 py-1.5 bg-surface-hover rounded-lg">
                <Search className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('workspaceTabs.searchTabs')}
                  className="bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none w-full"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {filteredWorkspaces.length === 0 ? (
                <div className="px-3 py-4 text-xs text-text-tertiary text-center">
                  {searchQuery.trim()
                    ? t('workspaceTabs.noSearchResults')
                    : t('workspaceTabs.noOpenTabs')}
                </div>
              ) : (
                filteredWorkspaces.map((ws) => {
                  const isActive = activeWorkspaceId === ws.id
                  const counts = getWorkspaceCounts(ws.id)
                  const botStatus = botStatuses[ws.id]
                  return (
                    <div
                      key={ws.id}
                      onClick={() => handleSelectFromDropdown(ws.id)}
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
                          onClick={(e) => handleCloseFromDropdown(e, ws.id)}
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
    </div>
  )
}
