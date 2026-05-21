import { Plus, Settings, Sun, Moon } from 'lucide-react'
import { useTheme } from '../hooks/use-theme'

interface HeaderToolbarProps {
  onCreateWorkspace: () => void
  onOpenSettings: () => void
}

export default function HeaderToolbar({
  onCreateWorkspace,
  onOpenSettings,
}: HeaderToolbarProps) {
  const { theme, toggleTheme } = useTheme()

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
        onClick={toggleTheme}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Toggle theme"
      >
        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      <button
        onClick={onOpenSettings}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="Settings"
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
