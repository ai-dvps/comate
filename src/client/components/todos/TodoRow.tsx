import { useTranslation } from 'react-i18next'
import { Github, X, Check } from 'lucide-react'
import type { Todo } from '../../stores/todo-store'
import { cn } from '../ui/utils'
import { Badge } from '../ui/badge'

interface TodoRowProps {
  todo: Todo
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onDelete: () => void
}

export default function TodoRow({ todo, selected, onSelect, onToggle, onDelete }: TodoRowProps) {
  const { t } = useTranslation('todos')
  const done = todo.status === 'done'
  const labelOverflow = todo.labels.length > 2 ? todo.labels.length - 2 : 0

  return (
    <li
      onClick={onSelect}
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
      >
        {done && <Check className="w-2.5 h-2.5" />}
      </button>

      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <span
          className={cn(
            'text-sm leading-tight',
            done ? 'line-through text-text-tertiary' : 'text-text-primary',
          )}
        >
          {todo.text}
        </span>

        <div className="flex flex-wrap items-center gap-1.5">
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
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}
