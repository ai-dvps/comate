import type { CSSProperties } from 'react'
import {
  File,
  GitCompare,
  Globe2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from 'lucide-react'
import type { ContextTab } from '../stores/context-tab-store'
import { cn } from './ui/utils'

interface CustomTitlebarProps {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  workspaceName?: string
  sessionName?: string
  managementTitle?: string
  tabs: ContextTab[]
  activeTabId: string | null
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onAddTab: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
  isMac?: boolean
  isWindows?: boolean
}

const interactiveStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

function TabIcon({ tab }: { tab: ContextTab }) {
  if (tab.type === 'browser') return <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
  if (tab.type === 'changes') return <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
  return <File className="h-3.5 w-3.5" aria-hidden="true" />
}

export default function CustomTitlebar({
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  workspaceName,
  sessionName,
  managementTitle,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onToggleLeft,
  onToggleRight,
  isMac = false,
  isWindows = false,
}: CustomTitlebarProps) {
  const leftSegmentWidth = leftCollapsed ? 48 : leftWidth
  const contextSegmentWidth = rightCollapsed ? 44 : rightWidth

  return (
    <header
      className="relative z-30 flex h-11 flex-shrink-0 items-stretch border-b border-border bg-chrome"
      data-testid="custom-titlebar"
    >
      <div
        data-testid="titlebar-command-center"
        className="flex flex-shrink-0 items-center border-r border-border/70 transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: leftSegmentWidth }}
      >
        {isMac ? <div data-tauri-drag-region className="w-[72px] self-stretch" /> : null}
        <button
          type="button"
          data-testid="titlebar-interactive"
          style={interactiveStyle}
          onClick={onToggleLeft}
          className={cn(
            'm-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-tertiary',
            'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          aria-label={leftCollapsed ? 'Expand command center' : 'Collapse command center'}
          aria-expanded={!leftCollapsed}
        >
          {leftCollapsed
            ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}
        </button>
        <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
      </div>

      <div className="flex min-w-0 flex-1 items-center px-3">
        <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
        <div className="pointer-events-none min-w-0 max-w-[70%] text-center">
          {managementTitle ? (
            <div className="truncate text-xs font-medium text-text-primary">{managementTitle}</div>
          ) : (
            <div className="flex min-w-0 items-center justify-center gap-1.5 text-xs">
              <span className="truncate text-text-tertiary">{workspaceName}</span>
              {workspaceName && sessionName ? <span className="text-text-tertiary/50">/</span> : null}
              <span className="truncate font-medium text-text-primary">{sessionName}</span>
            </div>
          )}
        </div>
        <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
      </div>

      <div
        data-testid="titlebar-context"
        className={cn(
          'flex flex-shrink-0 items-center border-l border-border/70 transition-[width] duration-200 ease-out motion-reduce:transition-none',
          isWindows && 'pr-[138px]',
        )}
        style={{ width: contextSegmentWidth + (isWindows ? 138 : 0) }}
      >
        {managementTitle ? (
          <div data-tauri-drag-region className="flex-1 self-stretch" />
        ) : rightCollapsed ? (
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
              onClick={onToggleRight}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Expand context panel"
              aria-expanded="false"
            >
              <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <div
              role="tablist"
              aria-label="Context tabs"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 scrollbar-hide"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
            >
              {tabs.map((tab) => {
                const active = tab.id === activeTabId
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    tabIndex={active ? 0 : -1}
                    aria-selected={active}
                    onClick={() => onSelectTab(tab.id)}
                    className={cn(
                      'group flex h-7 min-w-0 max-w-44 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active
                        ? 'bg-surface-active text-text-primary'
                        : 'text-text-tertiary hover:bg-surface-hover hover:text-text-secondary',
                    )}
                  >
                    <TabIcon tab={tab} />
                    <span className="truncate">{tab.name}</span>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCloseTab(tab.id)
                      }}
                      className="rounded p-0.5 opacity-0 hover:bg-surface-hover group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Close ${tab.name}`}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
              onClick={onAddTab}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Add context tab"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
              onClick={onToggleRight}
              className="mr-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Collapse context panel"
              aria-expanded="true"
            >
              <PanelRightClose className="h-4 w-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
