import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../stores/workspace-store'
import SessionList from './SessionList'
import FileExplorer from './FileExplorer'
import TodoList from './TodoList'
import WeComQueuePanel from './WeComQueuePanel'

interface SidebarProps {
  width: number
  onWidthChange: (width: number) => void
  onFileClick: (path: string, name: string) => void
  onFileDoubleClick?: (path: string, name: string) => void
}

type SidebarTab = 'sessions' | 'files' | 'todos' | 'queue'

const MIN_WIDTH = 200
const MAX_WIDTH = 600

export default function Sidebar({
  width,
  onWidthChange,
  onFileClick,
  onFileDoubleClick,
}: SidebarProps) {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX
        const newWidth = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, startWidth + delta)
        )
        onWidthChange(newWidth)
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [width, onWidthChange]
  )

  return (
    <aside
      className="relative bg-surface border-r border-border flex flex-col h-full flex-shrink-0"
      style={{ width }}
    >
      {/* Tab Switcher */}
      <div className="flex border-b border-border/50">
        <button
          className={`flex-1 py-3 font-medium text-center transition-all ${
            activeTab === 'sessions'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => setActiveTab('sessions')}
        >
          {t('sidebar.sessions')}
        </button>
        <button
          className={`flex-1 py-3 font-medium text-center transition-all ${
            activeTab === 'todos'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => setActiveTab('todos')}
        >
          {t('sidebar.todos')}
        </button>
        <button
          className={`flex-1 py-3 font-medium text-center transition-all ${
            activeTab === 'files'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => setActiveTab('files')}
        >
          {t('sidebar.files')}
        </button>
        <button
          className={`flex-1 py-3 font-medium text-center transition-all ${
            activeTab === 'queue'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => setActiveTab('queue')}
        >
          {t('sidebar.queue')}
        </button>
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
        {activeTab === 'files' && (
          <FileExplorer
            onFileClick={onFileClick}
            onFileDoubleClick={onFileDoubleClick}
          />
        )}
        {activeTab === 'queue' && activeWorkspaceId && (
          <WeComQueuePanel workspaceId={activeWorkspaceId} />
        )}
        {activeTab === 'queue' && !activeWorkspaceId && (
          <div className="flex-1 flex items-center justify-center p-4">
            <p className="text-text-tertiary text-center">
              {t('sidebar.noWorkspace')}
            </p>
          </div>
        )}
      </div>

      {/* Resize Handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />
    </aside>
  )
}
