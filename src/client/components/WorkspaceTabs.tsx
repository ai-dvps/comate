import { useState } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { Folder, X, Plus } from 'lucide-react'

export default function WorkspaceTabs() {
  const { workspaces, openWorkspaceIds, activeWorkspaceId, setActiveWorkspace, closeWorkspace, createWorkspace, openWorkspace } = useWorkspaceStore()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')

  const openWorkspaces = openWorkspaceIds
    .map(id => workspaces.find(w => w.id === id))
    .filter(Boolean)

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return
    const ws = await createWorkspace({
      name: newName.trim(),
      folderPath: newPath.trim(),
    })
    if (ws) {
      setNewName('')
      setNewPath('')
      setShowCreate(false)
      openWorkspace(ws.id)
    }
  }

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

      {/* New Workspace */}
      {showCreate ? (
        <div className="flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') {
                setShowCreate(false)
                setNewName('')
                setNewPath('')
              }
            }}
            placeholder="Name"
            className="w-20 px-2 py-1 text-[11px] bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') {
                setShowCreate(false)
                setNewName('')
                setNewPath('')
              }
            }}
            placeholder="Path"
            className="w-28 px-2 py-1 text-[11px] bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || !newPath.trim()}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-hover disabled:opacity-40 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowCreate(true)}
          className="p-1.5 text-text-tertiary hover:text-text-secondary hover:bg-surface-hover rounded-lg transition-colors"
          title="New workspace"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
