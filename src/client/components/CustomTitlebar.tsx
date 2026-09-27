import { useEffect, useRef, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  File,
  GitBranch,
  GitCompare,
  Globe2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  SquarePen,
  X,
} from 'lucide-react'
import type { ContextTab } from '../stores/context-tab-store'
import { cn } from './ui/utils'

interface CustomTitlebarProps {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  contextAvailable: boolean
  viewportWidth?: number
  workspaceName?: string
  sessionName?: string
  managementTitle?: string
  tabs: ContextTab[]
  activeTabId: string | null
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onAddTab: () => void
  onNewChat: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
  isMac?: boolean
  isWindows?: boolean
}

const interactiveStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties
const COLLAPSED_LEFT_WIDTH = 48
const MACOS_TRAFFIC_LIGHTS_WIDTH = 72
const LEFT_TOGGLE_SLOT_WIDTH = 40
const NEW_CHAT_SLOT_WIDTH = 40
const WINDOWS_WINDOW_CONTROLS_WIDTH = 138
const MIN_CONVERSATION_TITLE_WIDTH = 160

function TabIcon({ tab }: { tab: ContextTab }) {
  const className = 'h-3.5 w-3.5 text-text-tertiary/70 transition-colors group-hover:text-text-secondary'
  if (tab.type === 'browser') {
    return <Globe2 className={className} strokeWidth={1.5} aria-hidden="true" />
  }
  if (tab.type === 'changes') {
    return <GitCompare className={className} strokeWidth={1.5} aria-hidden="true" />
  }
  if (tab.type === 'git-graph') {
    return <GitBranch className={className} strokeWidth={1.5} aria-hidden="true" />
  }
  if (tab.type === 'commit-diff') {
    return <GitCompare className={className} strokeWidth={1.5} aria-hidden="true" />
  }
  return <File className={className} strokeWidth={1.5} aria-hidden="true" />
}

export default function CustomTitlebar({
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  contextAvailable,
  viewportWidth,
  workspaceName,
  sessionName,
  managementTitle,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onNewChat,
  onToggleLeft,
  onToggleRight,
  isMac = false,
  isWindows = false,
}: CustomTitlebarProps) {
  const { t } = useTranslation('common')
  const leftSegmentWidth = leftCollapsed
    ? isMac
      ? MACOS_TRAFFIC_LIGHTS_WIDTH + LEFT_TOGGLE_SLOT_WIDTH + NEW_CHAT_SLOT_WIDTH
      : COLLAPSED_LEFT_WIDTH + NEW_CHAT_SLOT_WIDTH
    : leftWidth
  const contextSegmentWidth = contextAvailable ? (rightCollapsed ? 44 : rightWidth) : 0
  const titlebarContextWidth = contextSegmentWidth
    + (isWindows ? WINDOWS_WINDOW_CONTROLS_WIDTH : 0)
  const availableConversationWidth = viewportWidth === undefined
    ? Number.POSITIVE_INFINITY
    : viewportWidth - leftSegmentWidth - titlebarContextWidth
  const hideConversationTitle = contextAvailable
    && !managementTitle
    && !rightCollapsed
    && availableConversationWidth < MIN_CONVERSATION_TITLE_WIDTH
  const leftToggleRef = useRef<HTMLButtonElement>(null)
  const rightToggleRef = useRef<HTMLButtonElement>(null)
  const previousCollapse = useRef({ left: leftCollapsed, right: rightCollapsed })

  useEffect(() => {
    const activeElement = document.activeElement
    if (
      leftCollapsed
      && !previousCollapse.current.left
      && activeElement
      && document.getElementById('agent-command-center-region')?.contains(activeElement)
    ) {
      leftToggleRef.current?.focus()
    }
    if (
      rightCollapsed
      && !previousCollapse.current.right
      && activeElement
      && document.getElementById('context-workspace-region')?.contains(activeElement)
    ) {
      rightToggleRef.current?.focus()
    }
    previousCollapse.current = { left: leftCollapsed, right: rightCollapsed }
  }, [leftCollapsed, rightCollapsed])

  return (
    <header
      className="relative z-30 flex h-11 flex-shrink-0 items-stretch bg-chrome"
      data-testid="custom-titlebar"
    >
      <div
        data-testid="titlebar-command-center"
        className={cn(
          'flex flex-shrink-0 items-center border-b border-border transition-[width] duration-200 ease-out motion-reduce:transition-none',
          !leftCollapsed && 'border-r border-border/70',
        )}
        style={{ width: leftSegmentWidth }}
      >
        {isMac ? (
          <div
            data-electron-drag-region
            data-testid="titlebar-macos-traffic-lights"
            className="w-[72px] flex-shrink-0 self-stretch"
          />
        ) : null}
        <button
          ref={leftToggleRef}
          type="button"
          data-testid="titlebar-interactive"
          style={interactiveStyle}
          onClick={onToggleLeft}
          className={cn(
            'group m-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
            'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          aria-label={leftCollapsed ? t('shell.expandCommandCenter') : t('shell.collapseCommandCenter')}
          title={leftCollapsed ? t('shell.expandCommandCenter') : t('shell.collapseCommandCenter')}
          aria-expanded={!leftCollapsed}
        >
          {leftCollapsed
            ? <PanelLeftOpen className="h-4 w-4 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            : <PanelLeftClose className="h-4 w-4 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />}
        </button>
        {leftCollapsed ? (
          <button
            type="button"
            data-testid="titlebar-interactive"
            style={interactiveStyle}
            onClick={onNewChat}
            className={cn(
              'group m-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
              'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
            aria-label={t('newChat.title')}
            title={t('newChat.title')}
          >
            <SquarePen className="h-4 w-4 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
          </button>
        ) : null}
        <div data-electron-drag-region className="min-w-0 flex-1 self-stretch" />
      </div>

      <div
        data-testid="titlebar-conversation"
        className={cn(
          'flex min-w-0 flex-1 items-center border-b border-border',
          !hideConversationTitle && 'px-3',
        )}
      >
        <div data-electron-drag-region className="min-w-0 flex-1 self-stretch" />
        {hideConversationTitle ? null : (
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
        )}
        <div data-electron-drag-region className="min-w-0 flex-1 self-stretch" />
      </div>

      <div
        data-electron-drag-region
        data-testid="titlebar-context"
        className={cn(
          'flex flex-shrink-0 items-center border-b border-border transition-[width] duration-200 ease-out motion-reduce:transition-none',
          contextAvailable && !rightCollapsed && 'border-l border-border/70',
          isWindows && 'pr-[138px]',
        )}
        style={{ width: titlebarContextWidth }}
      >
        {!contextAvailable ? (
          <div data-electron-drag-region className="flex-1 self-stretch" />
        ) : managementTitle ? (
          <div data-electron-drag-region className="flex-1 self-stretch" />
        ) : rightCollapsed ? (
          <div className="flex flex-1 items-center justify-center">
            <button
              ref={rightToggleRef}
              type="button"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
              onClick={onToggleRight}
              className="group flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('shell.expandContext')}
              title={t('shell.expandContext')}
              aria-expanded="false"
            >
              <PanelRightOpen className="h-4 w-4 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <div
              role="tablist"
              aria-label={t('shell.contextTabs')}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 scrollbar-hide"
            >
              {tabs.map((tab) => {
                const active = tab.id === activeTabId
                const isPreview = 'preview' in tab && tab.preview
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    tabIndex={active ? 0 : -1}
                    aria-selected={active}
                    data-testid="titlebar-interactive"
                    style={interactiveStyle}
                    onClick={() => onSelectTab(tab.id)}
                    title={isPreview ? t('shell.previewTabHint') : undefined}
                    className={cn(
                      'group flex h-7 min-w-0 max-w-44 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active
                        ? 'bg-surface-active text-text-primary'
                        : 'text-text-tertiary hover:bg-surface-hover hover:text-text-secondary',
                    )}
                  >
                    <TabIcon tab={tab} />
                    <span className={cn('truncate', isPreview && 'italic')}>{tab.name}</span>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCloseTab(tab.id)
                      }}
                      className="rounded p-0.5 opacity-0 hover:bg-surface-hover group-hover:opacity-100 focus:opacity-100"
                      aria-label={t('shell.closeTab', { name: tab.name })}
                      title={t('shell.closeTab', { name: tab.name })}
                    >
                      <X className="h-3 w-3 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              ref={rightToggleRef}
              type="button"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
              onClick={onAddTab}
              className="group flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('shell.addContextTab')}
              title={t('shell.addContextTab')}
            >
              <Plus className="h-4 w-4 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="titlebar-interactive"
              style={interactiveStyle}
              onClick={onToggleRight}
              className="group mr-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t('shell.collapseContext')}
              title={t('shell.collapseContext')}
              aria-expanded="true"
            >
              <PanelRightClose className="h-4 w-4 text-text-tertiary/70 transition-colors group-hover:text-text-secondary" strokeWidth={1.5} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
