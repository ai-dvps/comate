import { useTranslation } from 'react-i18next'
import { BarChart3, CheckSquare, Plus, Settings, Sun, Moon } from 'lucide-react'
import { useTheme } from '../hooks/use-theme'

interface HeaderToolbarProps {
  onCreateWorkspace: () => void
  onOpenSettings: () => void
  onOpenAnalytics: () => void
  onOpenTodos: () => void
  popupOpen?: boolean
}

export default function HeaderToolbar({
  onCreateWorkspace,
  onOpenSettings,
  onOpenAnalytics,
  onOpenTodos,
  popupOpen = false,
}: HeaderToolbarProps) {
  const { t } = useTranslation('common')
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onCreateWorkspace}
        disabled={popupOpen}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title={t('header.createWorkspace')}
      >
        <Plus className="w-4 h-4" />
      </button>

      <button
        onClick={onOpenTodos}
        disabled={popupOpen}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title={t('header.todos')}
      >
        <CheckSquare className="w-4 h-4" />
      </button>

      <button
        onClick={onOpenAnalytics}
        disabled={popupOpen}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title={t('header.analytics')}
      >
        <BarChart3 className="w-4 h-4" />
      </button>

      <button
        onClick={toggleTheme}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={t('header.toggleTheme')}
      >
        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      <button
        onClick={onOpenSettings}
        disabled={popupOpen}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        title={t('header.settings')}
      >
        <Settings className="w-4 h-4" />
      </button>

      {/* User Profile placeholder */}
      <div
        className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-[11px] font-medium text-accent ml-0.5"
        title={t('header.userProfile')}
      >
        D
      </div>
    </div>
  )
}
