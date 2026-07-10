import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, LayoutGrid, Pin, Search, X } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useWorkspacePins } from '../hooks/use-workspace-pins'
import { BotStatusIcon } from './BotStatusIcon'
import { getChannelStatusLabel, useChannelStatuses } from '../hooks/use-channel-statuses'

interface WorkspaceSwitcherProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export default function WorkspaceSwitcher({ open, onOpenChange }: WorkspaceSwitcherProps) {
  const { t } = useTranslation('settings')
  const [internalOpen, setInternalOpen] = useState(false)

  const isOpen = open ?? internalOpen
  const setIsOpen = onOpenChange ?? setInternalOpen

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const openWorkspaceIds = useWorkspaceStore((s) => s.openWorkspaceIds)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  const { pinnedIds, isPinned, togglePin, prunePins } = useWorkspacePins()
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Reset the search query whenever the popover closes.
  useEffect(() => {
    if (!isOpen) setSearchQuery('')
  }, [isOpen])

  // All workspace ids (memoized so the polling effects do not restart every render).
  const allWorkspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces])
  const wecomStatuses = useChannelStatuses(allWorkspaceIds, '/bot/status')
  const feishuStatuses = useChannelStatuses(allWorkspaceIds, '/feishu/status')

  // Drop pin entries for workspaces that no longer exist.
  useEffect(() => {
    prunePins(allWorkspaceIds)
  }, [allWorkspaceIds, prunePins])

  const trimmedQuery = searchQuery.trim().toLowerCase()
  const visibleWorkspaces = useMemo(() => {
    const filtered = trimmedQuery
      ? workspaces.filter((ws) => ws.name.toLowerCase().includes(trimmedQuery))
      : workspaces
    const byId = new Map(filtered.map((ws) => [ws.id, ws]))
    const pinned = pinnedIds.flatMap((id) => {
      const ws = byId.get(id)
      return ws ? [ws] : []
    })
    const pinnedSet = new Set(pinnedIds)
    const unpinned = filtered.filter((ws) => !pinnedSet.has(ws.id))
    return [...pinned, ...unpinned]
  }, [workspaces, pinnedIds, trimmedQuery])

  const handleSelect = (id: string) => {
    openWorkspace(id)
    setIsOpen(false)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (searchQuery) {
        setSearchQuery('')
      } else {
        setIsOpen(false)
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
    }
  }

  const clearSearch = () => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title={t('workspaceSwitcher.switchWorkspace')}
        >
          <LayoutGrid className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchInputRef.current?.focus()
        }}
        className="z-[60] w-64 bg-surface border border-border rounded-xl shadow-lg overflow-hidden p-0"
      >
        <div className="px-3 py-2 border-b border-border/50">
          <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide">
            {t('workspaceSwitcher.workspaces')}
          </span>
        </div>
        {workspaces.length > 0 && (
          <div className="px-2 py-2 border-b border-border/50">
            <div className="relative" role="search">
              <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                <Search className="w-3.5 h-3.5 text-text-tertiary" />
              </div>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('workspaceSwitcher.searchPlaceholder')}
                aria-label={t('workspaceSwitcher.searchPlaceholder')}
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-bg border border-border rounded-md focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              {trimmedQuery && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label={t('workspaceSwitcher.clearSearch')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto py-1">
          {workspaces.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-tertiary text-center">
              {t('workspaceSwitcher.noWorkspaces')}
            </div>
          ) : visibleWorkspaces.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-tertiary text-center">
              {t('workspaceSwitcher.noMatchingWorkspaces')}
            </div>
          ) : (
            visibleWorkspaces.map((ws) => {
              const isOpenTab = openWorkspaceIds.includes(ws.id)
              const isActive = activeWorkspaceId === ws.id
              const wecomStatus = wecomStatuses[ws.id]
              const feishuStatus = feishuStatuses[ws.id]
              const pinned = isPinned(ws.id)
              return (
                <div
                  key={ws.id}
                  role="button"
                  tabIndex={0}
                  data-testid="workspace-row"
                  onClick={() => handleSelect(ws.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleSelect(ws.id)
                    }
                  }}
                  className={`group w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-left cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-surface-active text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <span className="truncate flex-1">{ws.name}</span>
                  <span className="flex items-center gap-1.5 flex-shrink-0">
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
                    {isOpenTab && (
                      <Check
                        className={`w-3.5 h-3.5 flex-shrink-0 ${
                          isActive ? 'text-accent' : 'text-text-tertiary'
                        }`}
                      />
                    )}
                    <button
                      type="button"
                      data-testid="pin-toggle"
                      onClick={(e) => {
                        e.stopPropagation()
                        togglePin(ws.id)
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={
                        pinned
                          ? t('workspaceSwitcher.unpinWorkspace')
                          : t('workspaceSwitcher.pinWorkspace')
                      }
                      className={`p-0.5 rounded transition-colors ${
                        pinned
                          ? 'text-accent opacity-100'
                          : 'text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-primary'
                      }`}
                    >
                      <Pin className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </div>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
