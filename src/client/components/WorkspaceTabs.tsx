import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from 'react-i18next'
import { Folder, X, ChevronDown, Search } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import StatusIndicator from './StatusIndicator'
import ConfirmDialog from './ConfirmDialog'
import { BotStatusIcon } from './BotStatusIcon'
import { getChannelStatusLabel, useChannelStatuses, type ChannelStatus } from '../hooks/use-channel-statuses'

interface WorkspaceItem {
  id: string
  name: string
  settings: { wecomBotEnabled?: boolean; feishuBotEnabled?: boolean }
}

interface TabPillProps {
  ws: WorkspaceItem
  isActive: boolean
  counts: { needsMe: number; finishedUnread: number; streaming: number }
  wecomStatus?: ChannelStatus
  feishuStatus?: ChannelStatus
  wecomTitle?: string
  feishuTitle?: string
  onClick: () => void
  onClose?: (e: React.MouseEvent) => void
  closeLabel?: string
}

function TabPill({
  ws,
  isActive,
  counts,
  wecomStatus,
  feishuStatus,
  wecomTitle,
  feishuTitle,
  onClick,
  onClose,
  closeLabel,
}: TabPillProps) {
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
      {wecomStatus && wecomTitle && (
        <BotStatusIcon iconSrc="/wecom-icon.svg" alt="WeCom" status={wecomStatus} title={wecomTitle} />
      )}
      {feishuStatus && feishuTitle && (
        <BotStatusIcon iconSrc="/feishu-icon.svg" alt="Feishu" status={feishuStatus} title={feishuTitle} />
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

  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  const openWorkspaces = useMemo(
    () =>
      openWorkspaceIds
        .map((id) => workspaces.find((w) => w.id === id))
        .filter(Boolean) as WorkspaceItem[],
    [openWorkspaceIds, workspaces]
  )

  const wecomBotStatuses = useChannelStatuses(openWorkspaceIds, '/bot/status')
  const feishuBotStatuses = useChannelStatuses(openWorkspaceIds, '/feishu/status')

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

  const hasLiveSession = (workspaceId: string) => {
    const sessionId = activeSessionIds[workspaceId]
    if (!sessionId) return false
    return isStreaming[sessionId] || (sessionStatus[sessionId]?.pendingCount ?? 0) > 0
  }

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (hasLiveSession(id)) {
      setConfirmCloseId(id)
    } else {
      closeWorkspace(id)
    }
  }

  return (
    <div className="flex items-center gap-1 min-w-0 relative">
      {/* Scrollable tabs — wrapped in overflow-hidden to prevent window-level scroll */}
      <div className="overflow-hidden flex-1 min-w-0">
        <div
          ref={scrollRef}
          className="flex items-center gap-1 overflow-x-auto scrollbar-hide min-w-0"
        >
        {openWorkspaces.map((ws) => {
          const isActive = activeWorkspaceId === ws.id
          const counts = getWorkspaceCounts(ws.id)
          const wecomStatus = wecomBotStatuses[ws.id]
          const feishuStatus = feishuBotStatuses[ws.id]
          return (
            <TabPill
              key={ws.id}
              ws={ws}
              isActive={isActive}
              counts={counts}
              wecomStatus={wecomStatus}
              feishuStatus={feishuStatus}
              wecomTitle={wecomStatus ? getChannelStatusLabel(wecomStatus, t, 'bot') : undefined}
              feishuTitle={feishuStatus ? getChannelStatusLabel(feishuStatus, t, 'feishuBot') : undefined}
              onClick={() => setActiveWorkspace(ws.id)}
              onClose={(e) => handleClose(e, ws.id)}
              closeLabel={t('workspaceTabs.closeTab', { name: ws.name })}
            />
          )
        })}
      </div>
      </div>

      {/* Persistent dropdown button */}
      <div className="relative flex-shrink-0">
        <Popover open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
          <PopoverTrigger asChild>
            <button
              className={`flex items-center justify-center h-[29px] px-2 rounded-lg text-xs font-medium transition-colors ${
                isDropdownOpen
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
              }`}
              aria-label={t('workspaceTabs.openTabList')}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={4}
            className="z-[60] w-64 bg-surface border border-border rounded-xl shadow-lg overflow-hidden p-0"
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
                  const wecomStatus = wecomBotStatuses[ws.id]
                  const feishuStatus = feishuBotStatuses[ws.id]
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
                      {wecomStatus && (
                        <BotStatusIcon
                          iconSrc="/wecom-icon.svg"
                          alt="WeCom"
                          status={wecomStatus}
                          title={getChannelStatusLabel(wecomStatus, t, 'bot')}
                        />
                      )}
                      {feishuStatus && (
                        <BotStatusIcon
                          iconSrc="/feishu-icon.svg"
                          alt="Feishu"
                          status={feishuStatus}
                          title={getChannelStatusLabel(feishuStatus, t, 'feishuBot')}
                        />
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
                      <button
                        className="ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-destructive transition-all"
                        onClick={(e) => handleClose(e, ws.id)}
                        aria-label={t('workspaceTabs.closeTab', { name: ws.name })}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <ConfirmDialog
        isOpen={!!confirmCloseId}
        title={t('closeWorkspace.confirmTitle', {
          name: workspaces.find((w) => w.id === confirmCloseId)?.name ?? '',
        })}
        message={t('closeWorkspace.confirmMessage')}
        confirmLabel={t('closeWorkspace.confirmButton')}
        cancelLabel={t('closeWorkspace.cancelButton')}
        onConfirm={() => {
          if (confirmCloseId) {
            closeWorkspace(confirmCloseId)
          }
          setConfirmCloseId(null)
        }}
        onCancel={() => setConfirmCloseId(null)}
      />
    </div>
  )
}
