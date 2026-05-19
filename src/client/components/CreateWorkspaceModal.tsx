import { useState, useCallback, useEffect } from 'react'
import { useWorkspaceStore } from '../stores/workspace-store'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauri } from '@tauri-apps/api/core'
import { X, Plus, FolderOpen } from 'lucide-react'

interface CreateWorkspaceModalProps {
  onClose: () => void
}

export default function CreateWorkspaceModal({ onClose }: CreateWorkspaceModalProps) {
  const [name, setName] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  const isValid = name.trim() && folderPath.trim()

  const handleSubmit = useCallback(async () => {
    if (!isValid || isCreating) return

    setIsCreating(true)
    setError(null)

    try {
      const workspace = await createWorkspace({
        name: name.trim(),
        folderPath: folderPath.trim(),
        description: description.trim() || undefined,
      })

      if (workspace) {
        openWorkspace(workspace.id)
        onClose()
      } else {
        setError('Failed to create workspace')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    } finally {
      setIsCreating(false)
    }
  }, [name, folderPath, description, isValid, isCreating, createWorkspace, openWorkspace, onClose])

  const handleBrowse = useCallback(async () => {
    if (!isTauri()) return
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      })
      if (selected && typeof selected === 'string') {
        setFolderPath(selected)
        if (!name.trim()) {
          const basename = selected.split(/[\\/]/).pop() || ''
          setName(basename)
        }
      }
    } catch {
      // Dialog cancelled or failed — leave input unchanged
    }
  }, [name])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter' && !e.shiftKey && isValid) {
        e.preventDefault()
        handleSubmit()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, handleSubmit, isValid])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 flex-shrink-0">
          <div>
            <h2 className="text-sm font-medium text-text-primary">Create Workspace</h2>
            <p className="text-xs text-text-tertiary mt-0.5">Set up a new workspace for your project</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Workspace Name <span className="text-red-400">*</span>
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Project"
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Folder Path <span className="text-red-400">*</span>
            </label>
            <div className="flex gap-2">
              <input
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/path/to/project"
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
              />
              <button
                onClick={handleBrowse}
                type="button"
                className="px-3 py-2 text-sm font-medium bg-surface-hover hover:bg-surface-active text-text-secondary rounded-lg border border-border transition-colors flex items-center gap-1.5"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Browse
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-none"
            />
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid || isCreating}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
