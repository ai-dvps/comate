import { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspace-store';
import { Folder, Plus, X } from 'lucide-react';

export default function WorkspaceList() {
  const { workspaces, activeWorkspaceId, isLoading, error, fetchWorkspaces, createWorkspace, openWorkspace, clearError } = useWorkspaceStore();
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newDesc, setNewDesc] = useState('');

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    const ws = await createWorkspace({
      name: newName.trim(),
      folderPath: newPath.trim(),
      description: newDesc.trim(),
    });
    if (ws) {
      setNewName('');
      setNewPath('');
      setNewDesc('');
      setIsCreating(false);
      openWorkspace(ws.id);
    }
  };

  return (
    <div className="w-72 bg-surface border-r border-border flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <h2 className="text-sm font-medium text-text-primary">Workspaces</h2>
        <button
          onClick={() => setIsCreating(true)}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title="New Workspace"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-red-400 hover:text-red-300">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {isCreating && (
        <div className="p-3 space-y-2 border-b border-border/50">
          <input
            type="text"
            placeholder="Workspace name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-border-hover"
          />
          <input
            type="text"
            placeholder="Folder path"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-border-hover"
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-border-hover"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={isLoading || !newName.trim() || !newPath.trim()}
              className="flex-1 px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 rounded-lg text-xs font-medium text-white transition-colors"
            >
              Create
            </button>
            <button
              onClick={() => setIsCreating(false)}
              className="px-3 py-1.5 bg-surface-hover hover:bg-surface-active rounded-lg text-xs text-text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-2">
        {isLoading && workspaces.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">Loading...</div>
        ) : workspaces.length === 0 ? (
          <div className="px-4 py-3 text-xs text-text-tertiary">No workspaces yet.</div>
        ) : (
          workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => openWorkspace(ws.id)}
              className={`w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors ${
                activeWorkspaceId === ws.id
                  ? 'bg-surface-active text-text-primary'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <Folder className={`w-4 h-4 flex-shrink-0 ${activeWorkspaceId === ws.id ? 'text-accent' : 'text-text-tertiary'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{ws.name}</p>
                <p className="text-[11px] text-text-tertiary truncate">{ws.folderPath}</p>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
