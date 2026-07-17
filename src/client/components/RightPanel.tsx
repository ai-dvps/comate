import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, GitBranch } from 'lucide-react'
import { useRightPanelStore } from '../stores/right-panel-store'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import FileExplorer from './FileExplorer'
import GitChangesPanel from './GitChangesPanel'
import RightPanelContent from './RightPanelContent'

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
  const setActiveListTab = useRightPanelStore((s) => s.setActiveListTab)
  const [listSidebarWidth, setListSidebarWidth] = useState(LIST_SIDEBAR_WIDTH)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)

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
    (tab: 'files' | 'git-changes') => {
      setActiveListTab(tab)
    },
    [setActiveListTab],
  )

  const handleIconClick = useCallback(
    (tab: 'files' | 'git-changes') => {
      setActiveListTab(tab)
      if (isCollapsed) {
        toggleCollapse()
      }
    },
    [isCollapsed, setActiveListTab, toggleCollapse],
  )

  const handleListSidebarWidthChange = useCallback((nextWidth: number) => {
    setListSidebarWidth(Math.max(MIN_LIST_SIDEBAR_WIDTH, Math.min(MAX_LIST_SIDEBAR_WIDTH, nextWidth)))
  }, [])

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    document.removeEventListener('mousemove', dragRef.current.move)
    document.removeEventListener('mouseup', dragRef.current.up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    dragRef.current = null
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

      dragRef.current = { move: handleMouseMove, up: handleMouseUp }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [isCollapsed, width, onWidthChange, endDrag],
  )

  useEffect(() => {
    return () => {
      endDrag()
    }
  }, [endDrag])

  const railButtons = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-testid="right-panel-files-icon"
            onClick={() => handleIconClick('files')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              activeListTab === 'files'
                ? 'text-text-primary bg-accent/10'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
            )}
            aria-label={t('rightPanel.showFiles')}
          >
            <Folder className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{t('rightPanel.showFiles')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-testid="right-panel-git-icon"
            onClick={() => handleIconClick('git-changes')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              activeListTab === 'git-changes'
                ? 'text-text-primary bg-accent/10'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
            )}
            aria-label={t('rightPanel.showGitChanges')}
          >
            <GitBranch className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{t('rightPanel.showGitChanges')}</TooltipContent>
      </Tooltip>
    </>
  )

  if (isCollapsed) {
    return (
      <aside
        ref={panelRef}
        data-testid="right-panel"
        className="relative bg-surface border-l border-border flex flex-col h-full flex-shrink-0"
        style={{ width }}
      >
        <div
          data-testid="right-panel-rail"
          className="flex flex-col items-center py-1.5 gap-0.5"
        >
          {railButtons}
        </div>
      </aside>
    )
  }

  const contentWidth = Math.max(0, width - listSidebarWidth)

  return (
    <aside
      ref={panelRef}
      data-testid="right-panel"
      className="relative bg-surface border-l border-border flex flex-row h-full flex-shrink-0"
      style={{ width }}
    >
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <RightPanelContent workspacePath={workspacePath} contentWidth={contentWidth} />
      </div>

      <div
        data-testid="right-panel-list-sidebar"
        className="flex flex-col h-full border-l border-border/50 flex-shrink-0"
        style={{ width: listSidebarWidth }}
      >
        <div
          className="flex border-b border-border/50 flex-shrink-0"
          role="tablist"
          aria-label={t('rightPanel.openTabs')}
        >
          <button
            data-testid="right-panel-files-tab"
            role="tab"
            aria-selected={activeListTab === 'files'}
            onClick={() => handleListTabClick('files')}
            className={cn(
              'flex-1 py-2 text-xs font-medium text-center transition-all',
              activeListTab === 'files'
                ? 'text-text-primary border-b-2 border-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t('rightPanel.files')}
          </button>
          <button
            data-testid="right-panel-git-tab"
            role="tab"
            aria-selected={activeListTab === 'git-changes'}
            onClick={() => handleListTabClick('git-changes')}
            className={cn(
              'flex-1 py-2 text-xs font-medium text-center transition-all',
              activeListTab === 'git-changes'
                ? 'text-text-primary border-b-2 border-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t('rightPanel.gitChanges')}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {activeListTab === 'files' && (
            <FileExplorer onFileClick={handleFileOpen} />
          )}
          {activeListTab === 'git-changes' && (
            <GitChangesPanel
              width={listSidebarWidth}
              isCollapsed={false}
              onToggleCollapse={() => {}}
              onWidthChange={handleListSidebarWidthChange}
            />
          )}
        </div>
      </div>

      <div
        data-testid="right-panel-resize-handle"
        role="separator"
        aria-label={t('rightPanel.resize')}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
        onMouseDown={handleResizeMouseDown}
      />
    </aside>
  )
}
