import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, X, File } from 'lucide-react'
import { cn } from './ui/utils'
import { useRightPanelStore, type ContentTab, type FileTab, type DiffTab } from '../stores/right-panel-store'
import CodeMirrorFileViewer from './CodeMirrorFileViewer'
import CodeMirrorDiffViewer from './CodeMirrorDiffViewer'
import { getFileIcon } from '../lib/file-helpers'
import { getStatusBadgeClass } from '../lib/git-status-helpers'

interface RightPanelContentProps {
  workspacePath?: string
  contentWidth?: number
}

function isFileTab(tab: ContentTab): tab is FileTab {
  return tab.type === 'file'
}

function isDiffTab(tab: ContentTab): tab is DiffTab {
  return tab.type === 'diff'
}

export default function RightPanelContent({
  workspacePath,
  contentWidth = 0,
}: RightPanelContentProps) {
  const { t } = useTranslation('common')
  const openTabs = useRightPanelStore((s) => s.openTabs)
  const activeTabId = useRightPanelStore((s) => s.activeTabId)
  const selectTab = useRightPanelStore((s) => s.selectTab)
  const closeTab = useRightPanelStore((s) => s.closeTab)
  const tabRefs = useRef<(HTMLDivElement | null)[]>([])

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null

  const focusTabAt = useCallback((index: number) => {
    const el = tabRefs.current[index]
    if (el) {
      el.focus()
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (openTabs.length === 0) return
      const activeIndex = openTabs.findIndex((tab) => tab.id === activeTabId)
      const currentIndex = activeIndex >= 0 ? activeIndex : 0

      const selectAt = (index: number) => {
        const tab = openTabs[index]
        if (!tab) return
        selectTab(tab.id)
        focusTabAt(index)
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        selectAt((currentIndex + 1) % openTabs.length)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        selectAt((currentIndex - 1 + openTabs.length) % openTabs.length)
      } else if (e.key === 'Home') {
        e.preventDefault()
        selectAt(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        selectAt(openTabs.length - 1)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const tab = openTabs[currentIndex]
        if (!tab) return
        const nextIndex =
          currentIndex < openTabs.length - 1 ? currentIndex : currentIndex - 1
        closeTab(tab.id)
        if (nextIndex >= 0) {
          // Defer focus until after React removes the closed tab.
          requestAnimationFrame(() => focusTabAt(nextIndex))
        }
      }
    },
    [openTabs, activeTabId, selectTab, closeTab, focusTabAt],
  )

  return (
    <div
      data-testid="right-panel-content"
      className="flex flex-col h-full"
    >
      <div
        role="tablist"
        aria-label={t('rightPanel.openTabs')}
        className="flex items-center gap-1 overflow-x-auto scrollbar-hide flex-shrink-0 px-2 border-b border-border/50"
        onKeyDown={handleKeyDown}
      >
        {openTabs.map((tab, index) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              ref={(el) => { tabRefs.current[index] = el }}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              className={cn(
                'group flex items-center gap-1.5 px-3 py-2 rounded-lg cursor-pointer text-xs transition-all whitespace-nowrap flex-shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isActive
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover',
              )}
              onClick={() => selectTab(tab.id)}
            >
              {isFileTab(tab) && getFileIcon(tab.name)}
              {isDiffTab(tab) && (
                <GitBranch className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
              )}
              {isDiffTab(tab) && (
                <span
                  className={cn(
                    'flex-shrink-0 px-1 py-0.5 rounded text-[10px] font-mono font-medium',
                    getStatusBadgeClass(tab.statusCode),
                  )}
                  title={tab.statusCode}
                >
                  {tab.statusCode}
                </span>
              )}
              <span className="truncate max-w-[120px]">{tab.name}</span>
              <button
                data-testid="close-tab-button"
                className={cn(
                  'ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-destructive transition-all',
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                aria-label={t('rightPanel.closeTab')}
                title={t('rightPanel.closeTab')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>

      <div
        role="tabpanel"
        className="flex-1 min-h-0 overflow-hidden"
      >
        {!activeTab ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary px-4">
            <File className="w-8 h-8" />
            <p className="text-sm text-center">{t('rightPanel.emptyState')}</p>
          </div>
        ) : isFileTab(activeTab) ? (
          <CodeMirrorFileViewer tab={activeTab} workspacePath={workspacePath} />
        ) : (
          <CodeMirrorDiffViewer
            tab={activeTab}
            workspacePath={workspacePath}
            width={contentWidth}
          />
        )}
      </div>
    </div>
  )
}
