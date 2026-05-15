import { useWorkspaceStore } from '../stores/workspace-store'
import { Folder, X } from 'lucide-react'

export default function WorkspaceTabs() {
  const { workspaces, openWorkspaceIds, activeWorkspaceId, setActiveWorkspace, closeWorkspace } = useWorkspaceStore()

  const openWorkspaces = openWorkspaceIds
    .map(id => workspaces.find(w => w.id === id))
    .filter(Boolean)

  return (
    <div className="flex items-center gap-1">
      {openWorkspaces.map(ws => {
        if (!ws) return null
        const isActive = activeWorkspaceId === ws.id
        return (
          <div
            key={ws.id}
            className={`tab-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer text-xs transition-all group ${
              isActive
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
            }`}
            onClick={() => setActiveWorkspace(ws.id)}
            role="tab"
            aria-selected={isActive}
          >
            <Folder className={`w-3 h-3 flex-shrink-0 ${isActive ? 'text-accent' : 'text-text-tertiary'}`} />
            <span className="truncate max-w-[100px]">{ws.name}</span>
            {openWorkspaces.length > 1 && (
              <button
                className={`ml-0.5 p-0.5 rounded hover:bg-surface-hover hover:text-red-400 transition-all ${
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeWorkspace(ws.id)
                }}
                aria-label={`Close ${ws.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
