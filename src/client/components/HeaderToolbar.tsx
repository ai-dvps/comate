import { Plus, Settings } from 'lucide-react'

interface HeaderToolbarProps {
  onCreateWorkspace: () => void
  onOpenSettings: () => void
  canOpenSettings: boolean
}

export default function HeaderToolbar({
  onCreateWorkspace,
  onOpenSettings,
  canOpenSettings,
}: HeaderToolbarProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onCreateWorkspace}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Create workspace"
      >
        <Plus className="w-4 h-4" />
      </button>

      <button
        onClick={onOpenSettings}
        disabled={!canOpenSettings}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-tertiary transition-colors"
        title="Workspace settings"
      >
        <Settings className="w-4 h-4" />
      </button>

      {/* User Profile placeholder */}
      <div
        className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-[11px] font-medium text-accent ml-0.5"
        title="User profile (coming soon)"
      >
        D
      </div>
    </div>
  )
}
