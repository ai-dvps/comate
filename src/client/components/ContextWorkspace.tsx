import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { File, GitCompare, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useContextTabStore } from '../stores/context-tab-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { cn } from './ui/utils'
import FileExplorer from './FileExplorer'
import GitChangesPanel from './GitChangesPanel'
import CodeMirrorFileViewer from './CodeMirrorFileViewer'
import CodeMirrorDiffViewer from './CodeMirrorDiffViewer'
import BrowserPane from './browser/BrowserPane'

const DEFAULT_NAVIGATOR_WIDTH = 260
const MIN_NAVIGATOR_WIDTH = 180
const MAX_NAVIGATOR_WIDTH = 420
const PANEL_RESIZE_GUTTER = 4

interface ContextWorkspaceProps {
  width: number
  isCollapsed: boolean
  onWidthChange: (width: number) => void
  workspaceId: string
  workspacePath?: string
}

export default function ContextWorkspace({
  width,
  isCollapsed,
  onWidthChange,
  workspaceId,
  workspacePath,
}: ContextWorkspaceProps) {
  const { t } = useTranslation('common')
  const openTabs = useContextTabStore((state) => state.openTabs)
  const activeTabId = useContextTabStore((state) => state.activeTabId)
  const openWorkspaceIds = useWorkspaceStore((state) => state.openWorkspaceIds)
  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null
  const [navigatorWidth, setNavigatorWidth] = useState(DEFAULT_NAVIGATOR_WIDTH)
  const [navigatorCollapsedByTab, setNavigatorCollapsedByTab] = useState<Record<string, boolean>>({})
  const dragRef = useRef<{ move: (event: MouseEvent) => void; up: () => void } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const hasNavigator = activeTab?.type === 'file' || activeTab?.type === 'changes'
  const navigatorCollapsed = activeTab ? navigatorCollapsedByTab[activeTab.id] === true : false
  const showNavigator = hasNavigator && !navigatorCollapsed && !isCollapsed
  const showBrowser = activeTab?.type === 'browser'
  const primaryWidth = Math.max(0, width - (showNavigator ? navigatorWidth : 0))

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    document.removeEventListener('mousemove', dragRef.current.move)
    document.removeEventListener('mouseup', dragRef.current.up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    dragRef.current = null
    setIsDragging(false)
  }, [])

  useEffect(() => endDrag, [endDrag])
  useEffect(() => {
    if (isCollapsed) endDrag()
  }, [endDrag, isCollapsed])

  const handlePanelResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const move = (moveEvent: MouseEvent) => onWidthChange(startWidth + startX - moveEvent.clientX)
    const up = () => endDrag()
    setIsDragging(true)
    dragRef.current = { move, up }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [endDrag, onWidthChange, width])

  const handleNavigatorResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = navigatorWidth
    const move = (moveEvent: MouseEvent) => setNavigatorWidth(Math.max(
      MIN_NAVIGATOR_WIDTH,
      Math.min(MAX_NAVIGATOR_WIDTH, startWidth + startX - moveEvent.clientX),
    ))
    const up = () => endDrag()
    setIsDragging(true)
    dragRef.current = { move, up }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [endDrag, navigatorWidth])

  const toggleNavigator = () => {
    if (!activeTab) return
    setNavigatorCollapsedByTab((current) => ({
      ...current,
      [activeTab.id]: !current[activeTab.id],
    }))
  }

  const previewFile = (path: string, name: string) => {
    void useContextTabStore.getState().openFile(workspaceId, path, name, { preview: true })
  }
  const openFile = (path: string, name: string) => {
    void useContextTabStore.getState().openFile(workspaceId, path, name)
  }

  const renderPrimary = () => {
    if (!activeTab) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-text-tertiary">
          {t('shell.emptyContext')}
        </div>
      )
    }
    if (activeTab.type === 'file') {
      return activeTab.path ? (
        <CodeMirrorFileViewer tab={activeTab} workspacePath={workspacePath} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
          <File className="h-7 w-7" aria-hidden="true" />
          <span className="text-xs">{t('shell.selectFile')}</span>
        </div>
      )
    }
    if (activeTab.type === 'changes') {
      if (!activeTab.path) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
            <GitCompare className="h-7 w-7" aria-hidden="true" />
            <span className="text-xs">{t('shell.selectChange')}</span>
          </div>
        )
      }
      const diffTab = { ...activeTab, type: 'diff' as const }
      return (
        <CodeMirrorDiffViewer
          tab={diffTab}
          workspacePath={workspacePath}
          width={primaryWidth}
        />
      )
    }
    return null
  }

  return (
    <aside
      id="context-workspace-region"
      data-testid="context-workspace"
      className={cn(
        'relative flex h-full flex-shrink-0 flex-col overflow-hidden border-l border-border bg-work',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        isDragging && 'transition-none',
      )}
      style={{ width: isCollapsed ? 0 : width }}
      aria-hidden={isCollapsed}
    >
      <div className={cn('relative flex min-h-0 flex-1', isCollapsed && 'invisible')}>
        <div data-testid="context-primary" className="relative min-w-0 flex-1 overflow-hidden">
          {!showBrowser ? renderPrimary() : null}
          {openWorkspaceIds.map((openWorkspaceId) => (
            <div
              key={openWorkspaceId}
              className={cn(
                'absolute inset-y-0 right-0',
                openWorkspaceId === workspaceId && showBrowser
                  ? 'visible'
                  : 'invisible pointer-events-none',
              )}
              style={{ left: PANEL_RESIZE_GUTTER }}
              aria-hidden={openWorkspaceId !== workspaceId || !showBrowser}
            >
              <BrowserPane
                workspaceId={openWorkspaceId}
                surfaceVisible={!isCollapsed && openWorkspaceId === workspaceId && showBrowser}
              />
            </div>
          ))}

          {hasNavigator && navigatorCollapsed ? (
            <button
              type="button"
              onClick={toggleNavigator}
              className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-text-tertiary shadow-sm hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('shell.expandNavigator')}
            >
              <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div
          data-testid={showNavigator ? 'context-navigator' : undefined}
          className={cn(
            'relative flex h-full flex-shrink-0 flex-col overflow-hidden border-l border-border/70 bg-chrome',
            !showNavigator && 'w-0 border-l-0 invisible pointer-events-none',
          )}
          style={showNavigator ? { width: navigatorWidth } : undefined}
        >
          <div className="flex h-9 flex-shrink-0 items-center border-b border-border/70 px-2">
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-secondary">
              {activeTab?.type === 'changes' ? t('shell.changedFiles') : t('shell.files')}
            </span>
            <button
              type="button"
              onClick={toggleNavigator}
              className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('shell.collapseNavigator')}
            >
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className={cn('h-full', activeTab?.type !== 'file' && 'hidden')}>
              <FileExplorer
                selectedPath={activeTab?.type === 'file' ? activeTab.path : undefined}
                onFilePreview={previewFile}
                onFileClick={openFile}
              />
            </div>
            <div className={cn('h-full', activeTab?.type !== 'changes' && 'hidden')}>
              <GitChangesPanel />
            </div>
          </div>
          {showNavigator ? (
            <div
              role="separator"
              aria-label={t('shell.resizeNavigator')}
              className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize hover:bg-accent/50"
              onMouseDown={handleNavigatorResize}
            />
          ) : null}
        </div>
      </div>

      {!isCollapsed ? (
        <div
          data-testid="context-workspace-resize-handle"
          role="separator"
          aria-label={t('shell.resizeContext')}
          className="absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize hover:bg-accent/50"
          onMouseDown={handlePanelResize}
        />
      ) : null}
    </aside>
  )
}
