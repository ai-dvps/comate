import { useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../stores/workspace-store'
import { cn } from './ui/utils'
import { COLLAPSED_WIDTH } from '../hooks/use-sidebar-width'
import SessionList from './SessionList'

interface SidebarProps {
  width: number
  onWidthChange: (width: number) => void
  isCollapsed?: boolean
  onOpenPlugins?: () => void
  onOpenSkills?: () => void
}

export default function Sidebar({
  width,
  onWidthChange,
  isCollapsed = false,
  onOpenPlugins,
  onOpenSkills,
}: SidebarProps) {
  const { t } = useTranslation('common')
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

  return (
    <aside
      className={cn(
        'relative bg-surface flex flex-col h-full flex-shrink-0',
        'transition-[width] duration-200 ease-in-out overflow-hidden',
        'motion-reduce:transition-none',
        isCollapsed ? 'border-r-0 pointer-events-none' : 'border-r border-border',
      )}
      style={{ width: isCollapsed ? COLLAPSED_WIDTH : width }}
    >
      {!isCollapsed && (
        <div
          key="expanded"
          className="flex flex-col h-full animate-sidebar-content-reveal motion-reduce:animate-none"
        >
          <div className="flex-1 overflow-hidden flex flex-col">
            {activeWorkspaceId ? (
              <SessionList workspaceId={activeWorkspaceId} onOpenPlugins={onOpenPlugins} onOpenSkills={onOpenSkills} />
            ) : (
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
        </div>
      )}
    </aside>
  )
}
