import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, GitBranch, Globe } from 'lucide-react'
import { useRightPanelStore } from '../stores/right-panel-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChatStore } from '../stores/chat-store'
import {
  selectHandoffPending,
  selectSessionOpen,
  useBrowserPaneStore,
} from '../stores/browser-pane-store'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import FileExplorer from './FileExplorer'
import GitChangesPanel from './GitChangesPanel'
import RightPanelContent from './RightPanelContent'
import BrowserPane from './browser/BrowserPane'

const LIST_SIDEBAR_WIDTH = 280
const MIN_LIST_SIDEBAR_WIDTH = 180
const MAX_LIST_SIDEBAR_WIDTH = 480

interface RightPanelProps {
  width: number
  isCollapsed: boolean
  toggleCollapse: () => void
  onWidthChange: (width: number) => void
  workspaceId: string
  workspacePath?: string
}

export default function RightPanel({
  width,
  isCollapsed,
  toggleCollapse,
  onWidthChange,
  workspaceId,
  workspacePath,
}: RightPanelProps) {
  const { t } = useTranslation('common')
  const activeListTab = useRightPanelStore((s) => s.activeListTab)
  const openTabs = useRightPanelStore((s) => s.openTabs)
  const setActiveListTab = useRightPanelStore((s) => s.setActiveListTab)
  const openWorkspaceIds = useWorkspaceStore((s) => s.openWorkspaceIds)
  const [listSidebarWidth, setListSidebarWidth] = useState(LIST_SIDEBAR_WIDTH)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const hasOpenTabs = openTabs.length > 0

  const sessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isBrowserOpen = useBrowserPaneStore((s) => selectSessionOpen(s, sessionId))
  const handoffPending = useBrowserPaneStore((s) => selectHandoffPending(s, sessionId))
  const setPaneOpen = useBrowserPaneStore((s) => s.setPaneOpen)
  const wasBrowserOpenRef = useRef(isBrowserOpen)
  const prevSessionIdRef = useRef(sessionId)

  // Clear the Files-tree selection when the workspace changes so a highlight
  // from a previous workspace does not linger.
  useEffect(() => {
    setSelectedFilePath(null)
  }, [workspaceId])

  // Handoff auto-expand: when the browser opens for the current session,
  // switch to the browser tab and expand the panel. Ignore session switches
  // — they change selectSessionOpen because openBySession is per-session
  // persisted, and we must not re-expand just because the user came back to
  // a session whose browser tab was previously open.
  useEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId
      wasBrowserOpenRef.current = isBrowserOpen
      return
    }

    if (isBrowserOpen && !wasBrowserOpenRef.current && sessionId) {
      if (activeListTab !== 'browser') {
        setActiveListTab('browser')
      }
      if (isCollapsed) {
        toggleCollapse()
      }
    }
    wasBrowserOpenRef.current = isBrowserOpen
  }, [isBrowserOpen, sessionId, activeListTab, isCollapsed, setActiveListTab, toggleCollapse])

  const handleFileOpen = useCallback(
    (path: string, name: string) => {
      if (!workspaceId) return
      useRightPanelStore
        .getState()
        .openFile(workspaceId, path, name)
        .catch((err) => {
          console.error('[RightPanel] failed to open file:', err)
        })
    },
    [workspaceId],
  )

  const handleListTabClick = useCallback(
    (tab: 'files' | 'git-changes' | 'browser') => {
      setActiveListTab(tab)
      if (tab === 'browser' && sessionId) {
        setPaneOpen(sessionId, true)
      }
    },
    [setActiveListTab, sessionId, setPaneOpen],
  )

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    document.removeEventListener('mousemove', dragRef.current.move)
    document.removeEventListener('mouseup', dragRef.current.up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    dragRef.current = null
    setIsDragging(false)
  }, [])

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (isCollapsed) return
      const startX = e.clientX
      const startWidth = width

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        onWidthChange(startWidth + delta)
      }

      const handleMouseUp = () => {
        endDrag()
      }

      setIsDragging(true)
      dragRef.current = { move: handleMouseMove, up: handleMouseUp }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [isCollapsed, width, onWidthChange, endDrag],
  )

  const handleListResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (isCollapsed) return
      const startX = e.clientX
      const startWidth = listSidebarWidth

      const handleMouseMove = (moveEvent: MouseEvent) => {
        // The list sidebar sits on the right; dragging its left edge left
        // widens it. Clamp to the configured min/max range.
        const delta = startX - moveEvent.clientX
        const next = Math.max(
          MIN_LIST_SIDEBAR_WIDTH,
          Math.min(MAX_LIST_SIDEBAR_WIDTH, startWidth + delta),
        )
        setListSidebarWidth(next)
      }

      const handleMouseUp = () => {
        endDrag()
      }

      setIsDragging(true)
      dragRef.current = { move: handleMouseMove, up: handleMouseUp }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [isCollapsed, listSidebarWidth, endDrag],
  )

  useEffect(() => {
    return () => {
      endDrag()
    }
  }, [endDrag])

  useEffect(() => {
    if (isCollapsed) {
      endDrag()
    }
  }, [isCollapsed, endDrag])

  const showBrowser = activeListTab === 'browser'
  const panelWidth = showBrowser || hasOpenTabs ? width : listSidebarWidth
  const contentWidth = Math.max(0, panelWidth - listSidebarWidth)

  return (
    <aside
      ref={panelRef}
      data-testid="right-panel"
      className={cn(
        'relative bg-work border-l border-border flex flex-col h-full flex-shrink-0',
        'transition-[width] duration-200 ease-in-out overflow-hidden',
        'motion-reduce:transition-none',
        isDragging && 'transition-none',
      )}
      style={{ width: isCollapsed ? 0 : panelWidth }}
    >
      <div
        className={cn(
          'flex flex-col h-full',
          isCollapsed && 'hidden',
        )}
      >
        {/* Top tabs: Files / Git Changes / Browser */}
        <div
          className="flex flex-shrink-0 h-10"
          role="tablist"
          aria-label={t('rightPanel.openTabs')}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="right-panel-files-tab"
                role="tab"
                aria-selected={activeListTab === 'files'}
                onClick={() => handleListTabClick('files')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 h-full text-xs font-medium transition-all border-b',
                  activeListTab === 'files'
                    ? 'text-text-primary border-accent'
                    : 'text-text-secondary hover:text-text-primary border-border/50',
                )}
                aria-label={t('rightPanel.showFiles')}
              >
                <Folder className="w-3.5 h-3.5" />
                <span>{t('rightPanel.files')}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('rightPanel.showFiles')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="right-panel-git-tab"
                role="tab"
                aria-selected={activeListTab === 'git-changes'}
                onClick={() => handleListTabClick('git-changes')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 h-full text-xs font-medium transition-all border-b',
                  activeListTab === 'git-changes'
                    ? 'text-text-primary border-accent'
                    : 'text-text-secondary hover:text-text-primary border-border/50',
                )}
                aria-label={t('rightPanel.showGitChanges')}
              >
                <GitBranch className="w-3.5 h-3.5" />
                <span>{t('rightPanel.gitChanges')}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('rightPanel.showGitChanges')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="right-panel-browser-tab"
                role="tab"
                aria-selected={activeListTab === 'browser'}
                onClick={() => handleListTabClick('browser')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 h-full text-xs font-medium transition-all border-b',
                  activeListTab === 'browser'
                    ? 'text-text-primary border-accent'
                    : 'text-text-secondary hover:text-text-primary border-border/50',
                )}
                aria-label={t('rightPanel.showBrowser')}
              >
                <Globe className="w-3.5 h-3.5" />
                <span>{t('rightPanel.browser')}</span>
                {handoffPending && (
                  <span
                    data-testid="browser-tab-badge"
                    className="w-2 h-2 rounded-full bg-warning border border-bg animate-pulse"
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('rightPanel.showBrowser')}</TooltipContent>
          </Tooltip>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {/* Browser surfaces for all open workspaces — keep-alive across
              workspace switches and tab toggles. */}
          {openWorkspaceIds.map((wsId) => (
            <div
              key={wsId}
              className={cn(
                'absolute inset-0 flex flex-col',
                wsId === workspaceId && showBrowser
                  ? 'visible'
                  : 'invisible pointer-events-none',
              )}
              aria-hidden={wsId !== workspaceId || !showBrowser}
            >
              <BrowserPane workspaceId={wsId} surfaceVisible={wsId === workspaceId && showBrowser} />
            </div>
          ))}

          {/* Files / Git Changes layout */}
          {!showBrowser && (
            <div className="absolute inset-0 flex flex-row h-full">
              {hasOpenTabs && (
                <div className="flex-1 min-w-0 flex flex-col h-full">
                  <RightPanelContent workspacePath={workspacePath} contentWidth={contentWidth} />
                </div>
              )}

              <div
                data-testid="right-panel-list-sidebar"
                className={cn(
                  'relative flex flex-col h-full flex-shrink-0',
                  hasOpenTabs && 'border-l border-border/50',
                )}
                style={{ width: listSidebarWidth }}
              >
                <div
                  data-testid="right-panel-list-resize-handle"
                  role="separator"
                  aria-label={t('rightPanel.resize')}
                  className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
                  onMouseDown={handleListResizeMouseDown}
                />
                <div className="flex-1 min-h-0 overflow-hidden">
                  {activeListTab === 'files' && (
                    <FileExplorer
                      onFileClick={handleFileOpen}
                      selectedPath={selectedFilePath ?? undefined}
                      onSelectPath={setSelectedFilePath}
                    />
                  )}
                  {/* GitChangesPanel stays mounted (CSS-toggled) for the lifetime of
                      the expanded right panel, so toggling the Files/Git-Changes tab
                      no longer tears down and recreates the git watcher. */}
                  <div className={cn('h-full', activeListTab !== 'git-changes' && 'hidden')}>
                    <GitChangesPanel />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Panel resize handle */}
      {!isCollapsed && (
        <div
          data-testid="right-panel-resize-handle"
          role="separator"
          aria-label={t('rightPanel.resize')}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
          onMouseDown={handleResizeMouseDown}
        />
      )}
    </aside>
  )
}
