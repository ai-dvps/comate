import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback } from 'react'
import {
  Circle,
  Loader2,
  CheckCircle2,
  XCircle,
  PauseCircle,
  Ban,
  ChevronDown,
  ChevronUp,
  ListTodo,
} from 'lucide-react'

import { useChatStore, type TaskItem } from '../stores/chat-store'
import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeClass } from '../lib/font-size'
import { cn } from './ui/utils'

const EMPTY_ARRAY: [] = []

interface TaskPanelProps {
  sessionId: string
}

const statusConfig = {
  pending: {
    icon: Circle,
    iconClass: 'text-text-tertiary',
    label: 'Pending',
  },
  in_progress: {
    icon: Loader2,
    iconClass: 'text-warning animate-spin',
    label: 'In progress',
  },
  completed: {
    icon: CheckCircle2,
    iconClass: 'text-success',
    label: 'Completed',
  },
  failed: {
    icon: XCircle,
    iconClass: 'text-destructive',
    label: 'Failed',
  },
  killed: {
    icon: Ban,
    iconClass: 'text-text-tertiary',
    label: 'Killed',
  },
  paused: {
    icon: PauseCircle,
    iconClass: 'text-warning',
    label: 'Paused',
  },
}

function TaskRow({ task }: { task: TaskItem }) {
  const config = statusConfig[task.status] ?? statusConfig.pending
  const Icon = config.icon
  const isDone = task.status === 'completed' || task.status === 'killed'
  const isActive = task.status === 'in_progress' || task.status === 'paused'

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 py-2 px-3 rounded-md',
        isDone && 'opacity-50',
      )}
    >
      <Icon className={cn('size-4 mt-0.5 shrink-0', config.iconClass)} />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'whitespace-normal break-words',
            isDone
              ? 'text-text-tertiary line-through'
              : task.status === 'failed'
                ? 'text-destructive'
                : 'text-text-primary',
          )}
        >
          {task.subject}
        </span>
        {isActive && task.activeForm && (
          <p className="text-xs text-text-tertiary mt-0.5">{task.activeForm}</p>
        )}
      </div>
    </div>
  )
}

export default function TaskPanel({ sessionId }: TaskPanelProps) {
  const { t } = useTranslation('chat')
  const tasks = useChatStore((s) => s.tasks[sessionId] ?? EMPTY_ARRAY)
  const { chatFontSize } = useAppSettings()
  const [expanded, setExpanded] = useState(false)

  const completedCount = tasks.filter((t) => t.status === 'completed').length
  const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length
  const total = tasks.length

  const toggle = useCallback(() => setExpanded((e) => !e), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    if (expanded) {
      window.addEventListener('keydown', onKey)
    }
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // Auto-collapse when switching sessions (sessionId changes)
  useEffect(() => {
    setExpanded(false)
  }, [sessionId])

  if (total === 0) return null

  const progressPercent = total > 0 ? (completedCount / total) * 100 : 0

  return (
    <div className="pointer-events-auto rounded-lg border border-border bg-surface p-3 shadow-lg w-full max-w-xs">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 hover:bg-surface-hover transition-colors rounded-md p-1 -m-1"
        aria-label={t('taskPanelTitle')}
      >
        <ListTodo className="size-4 text-text-tertiary shrink-0" />
        <span className="text-xs font-medium text-text-secondary shrink-0">
          {t('taskPanelTitle')}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-surface-active rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs text-text-secondary shrink-0">
              {completedCount}/{total}
            </span>
          </div>
        </div>
        {inProgressCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning shrink-0">
            <Loader2 className="size-3 animate-spin" />
            {inProgressCount}
          </span>
        )}
        {expanded ? (
          <ChevronUp className="size-3.5 text-text-tertiary shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 text-text-tertiary shrink-0" />
        )}
      </button>

      {expanded && (
        <div className={cn('mt-2 max-h-64 overflow-y-auto', fontSizeClass(chatFontSize))}>
          <div className="py-1">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
