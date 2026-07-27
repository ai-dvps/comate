import { useTranslation } from 'react-i18next'
import { Inbox, CalendarDays, Clock, List } from 'lucide-react'
import { cn } from '../ui/utils'

export type SmartView = 'inbox' | 'today' | 'upcoming' | 'all'
export type GroupBy = 'none' | 'workspace' | 'repo' | 'origin'

interface TodosRailProps {
  view: SmartView
  onViewChange: (view: SmartView) => void
  groupBy: GroupBy
  onGroupByChange: (groupBy: GroupBy) => void
}

export default function TodosRail({ view, onViewChange, groupBy, onGroupByChange }: TodosRailProps) {
  const { t } = useTranslation('todos')
  const views: { id: SmartView; label: string; icon: React.ReactNode }[] = [
    { id: 'inbox', label: t('viewInbox'), icon: <Inbox className="w-4 h-4" /> },
    { id: 'today', label: t('viewToday'), icon: <CalendarDays className="w-4 h-4" /> },
    { id: 'upcoming', label: t('viewUpcoming'), icon: <Clock className="w-4 h-4" /> },
    { id: 'all', label: t('viewAll'), icon: <List className="w-4 h-4" /> },
  ]

  return (
    <nav className="w-44 flex-shrink-0 border-r border-border flex flex-col bg-surface/30">
      <div className="flex flex-col gap-0.5 p-2">
        {views.map((v) => (
          <button
            key={v.id}
            onClick={() => onViewChange(v.id)}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left',
              view === v.id
                ? 'bg-accent/10 text-text-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
            )}
          >
            {v.icon}
            <span>{v.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-auto p-2 border-t border-border">
        <label className="block text-[11px] text-text-tertiary mb-1">{t('groupBy')}</label>
        <select
          value={groupBy}
          onChange={(e) => onGroupByChange(e.target.value as GroupBy)}
          className="w-full bg-surface text-text-primary text-xs rounded-md px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="none">{t('groupNone')}</option>
          <option value="workspace">{t('groupWorkspace')}</option>
          <option value="repo">{t('groupRepo')}</option>
          <option value="origin">{t('groupOrigin')}</option>
        </select>
      </div>
    </nav>
  )
}
