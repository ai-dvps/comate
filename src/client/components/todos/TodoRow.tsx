import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Check, CirclePlay, Github, Moon, Repeat2, SkipForward, X, XCircle } from 'lucide-react'
import { MAX_TODO_TEXT_LENGTH, type Todo, type TodoExecutionType, type TodoLatestRun } from '../../stores/todo-store'
import { cn } from '../ui/utils'
import { Badge } from '../ui/badge'

interface TodoRowProps {
  todo: Todo
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onDelete: () => void
  /** Persist a renamed title. Called with the trimmed next text. */
  onRename: (text: string) => void
}

function ExecutionTypeIcon({ type }: { type: TodoExecutionType }) {
  const className = 'w-3.5 h-3.5'
  switch (type) {
    case 'once':
      return <CalendarClock className={className} aria-hidden="true" />
    case 'recurring':
      return <Repeat2 className={className} aria-hidden="true" />
    case 'idle':
      return <Moon className={className} aria-hidden="true" />
    default:
      return <CirclePlay className={className} aria-hidden="true" />
  }
}

function RunStatusIcon({ status }: { status: TodoLatestRun['status'] }) {
  const className = 'w-3 h-3'
  switch (status) {
    case 'succeeded':
      return <Check className={className} aria-hidden="true" />
    case 'failed':
      return <XCircle className={className} aria-hidden="true" />
    case 'missed':
    case 'skipped':
      return <SkipForward className={className} aria-hidden="true" />
    default:
      return <CirclePlay className={className} aria-hidden="true" />
  }
}

export default function TodoRow({ todo, selected, onSelect, onToggle, onDelete, onRename }: TodoRowProps) {
  const { t } = useTranslation('todos')
  const done = todo.status === 'done'
  const labelOverflow = todo.labels.length > 2 ? todo.labels.length - 2 : 0
  const executionType = todo.executionType ?? 'manual'
  const executionTypeLabels: Record<TodoExecutionType, string> = {
    manual: t('executionManual'),
    once: t('executionOnce'),
    recurring: t('executionRecurring'),
    idle: t('executionIdle'),
  }
  const runStatusLabels: Record<TodoLatestRun['status'], string> = {
    running: t('runStatusRunning'),
    succeeded: t('runStatusSucceeded'),
    failed: t('runStatusFailed'),
    missed: t('runStatusMissed'),
    skipped: t('runStatusSkipped'),
  }

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(todo.text)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against a double-commit when Enter/Escape unmounts the input and
  // fires onBlur in the same gesture.
  const committedRef = useRef(false)

  // Focus and select-all the moment edit mode activates.
  useEffect(() => {
    if (!isEditing) return
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [isEditing])

  const startEditing = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      committedRef.current = false
      setDraft(todo.text)
      setIsEditing(true)
    },
    [todo.text],
  )

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    setIsEditing(false)
    const next = draft.trim()
    // Empty/whitespace titles are not allowed — silently revert.
    if (next && next !== todo.text) {
      onRename(next)
    }
  }, [draft, todo.text, onRename])

  const cancel = useCallback(() => {
    committedRef.current = true
    setIsEditing(false)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return (
    <li
      onClick={isEditing ? undefined : onSelect}
      className={cn(
        'group flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer border border-transparent transition-colors',
        selected ? 'bg-accent/10 border-accent/10' : 'hover:bg-surface-hover hover:border-border/50',
      )}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className={cn(
          'mt-0.5 w-4 h-4 rounded-full border flex-shrink-0 flex items-center justify-center transition-colors',
          done ? 'bg-accent border-accent text-accent-foreground' : 'border-border hover:border-accent',
        )}
        aria-label={t('toggleDone')}
        title={t('toggleDone')}
      >
        {done && <Check className="w-2.5 h-2.5" />}
      </button>

      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-start gap-1.5 min-w-0">
          {executionType !== 'manual' ? (
            <span
              className="mt-0.5 text-text-tertiary flex-shrink-0"
              aria-label={executionTypeLabels[executionType]}
              title={executionTypeLabels[executionType]}
            >
              <ExecutionTypeIcon type={executionType} />
            </span>
          ) : null}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={MAX_TODO_TEXT_LENGTH}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t('editTitle')}
              className={cn(
                'w-full bg-bg text-sm leading-tight rounded-md border border-accent px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-accent',
                done ? 'text-text-tertiary line-through' : 'text-text-primary',
              )}
            />
          ) : (
            <span
              onDoubleClick={startEditing}
              className={cn(
                'text-sm leading-tight min-w-0',
                done ? 'line-through text-text-tertiary' : 'text-text-primary',
              )}
              title={t('doubleClickToEdit')}
            >
              {todo.text}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {todo.latestRun && (
            <Badge
              variant="outline"
              className={cn(
                'font-normal text-[10px] px-1.5 py-0 gap-1',
                todo.latestRun.status === 'succeeded' && 'text-success border-success/30',
                todo.latestRun.status === 'failed' && 'text-destructive border-destructive/30',
                todo.latestRun.status === 'running' && 'text-warning border-warning/30',
              )}
              title={t('latestRunStatus', {
                status: runStatusLabels[todo.latestRun.status],
                time: new Date(todo.latestRun.fireAt).toLocaleString(),
              })}
            >
              <RunStatusIcon status={todo.latestRun.status} />
              {runStatusLabels[todo.latestRun.status]}
            </Badge>
          )}
          {todo.dueDate && (
            <Badge variant="secondary" className="font-normal text-[10px] px-1.5 py-0">
              {todo.dueDate.slice(0, 10)}
            </Badge>
          )}

          {todo.labels.slice(0, 2).map((label) => (
            <Badge key={label} variant="outline" className="font-normal text-[10px] px-1.5 py-0">
              {label}
            </Badge>
          ))}
          {labelOverflow > 0 && (
            <Badge variant="outline" className="font-normal text-[10px] px-1.5 py-0">
              +{labelOverflow}
            </Badge>
          )}

          {todo.origin === 'github' && (
            <Badge variant="outline" className="font-normal text-[10px] px-1.5 py-0 gap-1">
              <Github className="w-3 h-3" />
              {t('originGithub')}
            </Badge>
          )}
        </div>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded text-text-tertiary hover:text-destructive transition-opacity flex-shrink-0"
        aria-label={t('delete')}
        title={t('delete')}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}
