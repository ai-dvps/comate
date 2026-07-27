import { useTranslation } from 'react-i18next'
import { BarChart3, CheckSquare, Clock, Plus, Settings, Sun, Moon } from 'lucide-react'
import { useScheduledTaskStore } from '../stores/scheduled-task-store'
import { useTheme } from '../hooks/use-theme'

interface HeaderToolbarProps {
  onCreateWorkspace: () => void
  onOpenSettings: () => void
  onOpenAnalytics: () => void
  onOpenScheduledTasks: () => void
  onOpenTodos: () => void
}

export default function HeaderToolbar({
  onCreateWorkspace,
  onOpenSettings,
  onOpenAnalytics,
  onOpenScheduledTasks,
  onOpenTodos,
}: HeaderToolbarProps) {
  const { t } = useTranslation('common')
  const unreadScheduledTasks = useScheduledTaskStore((s) => s.unreadCount)
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onCreateWorkspace}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={t('header.createWorkspace')}
      >
        <Plus className="w-4 h-4" />
      </button>

      <button
        onClick={onOpenTodos}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={t('header.todos')}
      >
        <CheckSquare className="w-4 h-4" />
      </button>

      <button
        onClick={onOpenScheduledTasks}
        className="relative p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={t('header.scheduledTasks')}
      >
        <Clock className="w-4 h-4" />
        {unreadScheduledTasks > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-accent text-white text-[9px] leading-[14px] text-center">
            {unreadScheduledTasks > 99 ? '99+' : unreadScheduledTasks}
          </span>
        )}
      </button>

      <button
        onClick={onOpenAnalytics}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
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
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
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
