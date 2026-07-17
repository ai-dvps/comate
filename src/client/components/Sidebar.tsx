import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, CheckSquare } from 'lucide-react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { cn } from './ui/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { RAIL_WIDTH } from '../hooks/use-sidebar-width'
import SessionList from './SessionList'
import TodoList from './TodoList'

interface SidebarProps {
  width: number
  onWidthChange: (width: number) => void
  isCollapsed?: boolean
}

type SidebarTab = 'sessions' | 'todos'

export default function Sidebar({
  width,
  onWidthChange,
  isCollapsed = false,
}: SidebarProps) {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const dragRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    document.removeEventListener('mousemove', dragRef.current.move)
    document.removeEventListener('mouseup', dragRef.current.up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    dragRef.current = null
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX
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
    [width, onWidthChange, endDrag],
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

  const tabs: { id: SidebarTab; label: string; tooltip: string; icon: React.ReactNode }[] = [
    {
      id: 'sessions',
      label: t('sidebar.sessions'),
      tooltip: t('sidebar.showSessions'),
      icon: <MessageSquare className="w-4 h-4" />,
    },
    {
      id: 'todos',
      label: t('sidebar.todos'),
      tooltip: t('sidebar.showTodos'),
      icon: <CheckSquare className="w-4 h-4" />,
    },
  ]

  return (
    <aside
      className={cn(
        'relative bg-surface border-r border-border flex flex-col h-full flex-shrink-0',
      )}
      style={{ width: isCollapsed ? RAIL_WIDTH : width }}
    >
      {isCollapsed ? (
        <>
          {/* Collapsed icon rail */}
          <div className="flex flex-col items-center py-1.5 gap-0.5">
            {tabs.map((tab) => (
              <Tooltip key={tab.id}>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      'p-1.5 rounded-md transition-colors',
                      activeTab === tab.id
                        ? 'text-text-primary bg-accent/10'
                        : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                    )}
                    aria-label={tab.tooltip}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.icon}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{tab.tooltip}</TooltipContent>
              </Tooltip>
            ))}
          </div>

        </>
      ) : (
        <>
          {/* Tab Switcher */}
          <div className="flex flex-shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn(
                  'flex-1 py-2 text-xs font-medium text-center transition-all border-b',
                  activeTab === tab.id
                    ? 'text-text-primary border-accent'
                    : 'text-text-secondary hover:text-text-primary border-border/50',
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {activeTab === 'sessions' && activeWorkspaceId && (
              <SessionList workspaceId={activeWorkspaceId} />
            )}
            {activeTab === 'sessions' && !activeWorkspaceId && (
              <div className="flex-1 flex items-center justify-center p-4">
                <p className="text-text-tertiary text-center">
                  {t('sidebar.noWorkspace')}
                </p>
              </div>
            )}
            {activeTab === 'todos' && activeWorkspaceId && (
              <TodoList
                workspaceId={activeWorkspaceId}
                onSessionNavigate={() => setActiveTab('sessions')}
              />
            )}
            {activeTab === 'todos' && !activeWorkspaceId && (
              <div className="flex-1 flex items-center justify-center p-4">
                <p className="text-text-tertiary text-center">
                  {t('sidebar.noWorkspace')}
                </p>
              </div>
            )}
          </div>

          {/* Resize Handle */}
          <div
            data-testid="sidebar-resize-handle"
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
            onMouseDown={handleMouseDown}
          />
        </>
      )}
    </aside>
  )
}
