import { useState } from 'react'
import WorkspaceList from './WorkspaceList'
import FileExplorer from './FileExplorer'

interface SidebarProps {
  onFileClick: (path: string, name: string) => void
}

type SidebarTab = 'workspaces' | 'files'

export default function Sidebar({ onFileClick }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('workspaces')

  return (
    <aside className="w-72 bg-surface border-r border-border flex flex-col h-full flex-shrink-0">
      {/* Tab Switcher */}
      <div className="flex border-b border-border/50">
        <button
          className={`flex-1 py-3 text-xs font-medium text-center transition-all ${
            activeTab === 'workspaces'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => setActiveTab('workspaces')}
        >
          Workspaces
        </button>
        <button
          className={`flex-1 py-3 text-xs font-medium text-center transition-all ${
            activeTab === 'files'
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => setActiveTab('files')}
        >
          Files
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'workspaces' && <WorkspaceList />}
        {activeTab === 'files' && <FileExplorer onFileClick={onFileClick} />}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-border/50">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-hover cursor-pointer transition-colors">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
            D
          </div>
          <span className="text-xs text-text-secondary">Developer</span>
        </div>
      </div>
    </aside>
  )
}
