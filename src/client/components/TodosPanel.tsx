import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Loader2 } from 'lucide-react'
import { useTodoStore, type Todo } from '../stores/todo-store'
import { cn } from './ui/utils'
import TodosRail, { type SmartView, type GroupBy } from './todos/TodosRail'
import TodoDetail from './todos/TodoDetail'

interface TodosPanelProps {
  onClose: () => void
}

function filterByView(todos: Todo[], view: SmartView): Todo[] {
  const todayStr = new Date().toISOString().slice(0, 10)
  switch (view) {
    case 'inbox':
      return todos.filter((t) => !t.dueDate)
    case 'today':
      return todos.filter((t) => !!t.dueDate && t.dueDate.slice(0, 10) <= todayStr)
    case 'upcoming':
      return todos.filter((t) => !!t.dueDate && t.dueDate.slice(0, 10) > todayStr)
    default:
      return todos
  }
}

export default function TodosPanel({ onClose }: TodosPanelProps) {
  const { t } = useTranslation('todos')
  const { todos, isLoading, fetchTodos, createTodo, changeStatus, deleteTodo } = useTodoStore()
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<SmartView>('inbox')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    fetchTodos()
  }, [fetchTodos])

  const handleAdd = async () => {
    if (!draft.trim()) return
    await createTodo(draft)
    setDraft('')
  }

  const grouped = useMemo(() => {
    const filtered = filterByView(todos, view)
    if (groupBy === 'none') return [{ key: '', items: filtered }]
    const map = new Map<string, Todo[]>()
    for (const todo of filtered) {
      let key: string
      if (groupBy === 'workspace') {
        key = todo.workspaceId ? `${t('groupWorkspace')} · ${todo.workspaceId.slice(0, 8)}` : t('noWorkspace')
      } else if (groupBy === 'repo') {
        key = todo.repoFullName ?? t('noRepo')
      } else {
        key = todo.origin === 'github' ? t('originGithub') : t('originLocal')
      }
      const bucket = map.get(key)
      if (bucket) bucket.push(todo)
      else map.set(key, [todo])
    }
    return [...map.entries()].map(([key, items]) => ({ key, items }))
  }, [todos, view, groupBy, t])

  const selected = todos.find((todo) => todo.id === selectedId) ?? null

  return (
    <div className="flex flex-col h-full bg-bg">
      <header className="flex items-center gap-2 px-4 h-12 border-b border-border flex-shrink-0">
        <h1 className="text-sm font-semibold text-text-primary flex-1">{t('title')}</h1>
        <button
          onClick={onClose}
          className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
          aria-label={t('close')}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          placeholder={t('addPlaceholder')}
          className="flex-1 bg-surface text-text-primary text-sm rounded-md px-2.5 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={handleAdd}
          className="p-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover"
          aria-label={t('add')}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <TodosRail view={view} onViewChange={setView} groupBy={groupBy} onGroupByChange={setGroupBy} />

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-text-tertiary">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : grouped.length === 0 || grouped.every((g) => g.items.length === 0) ? (
            <p className="text-center text-text-tertiary text-sm mt-8">{t('empty')}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {grouped.map((group) => (
                <section key={group.key || 'default'}>
                  {group.key && (
                    <h3 className="px-2 mb-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                      {group.key}
                    </h3>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((todo) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        selected={todo.id === selectedId}
                        onSelect={() => setSelectedId(todo.id)}
                        onToggle={() => changeStatus(todo.id, todo.status === 'done' ? 'pending' : 'done')}
                        onDelete={() => deleteTodo(todo.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <TodoDetail todo={selected} />
      </div>
    </div>
  )
}

function TodoRow({
  todo,
  selected,
  onSelect,
  onToggle,
  onDelete,
}: {
  todo: Todo
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('todos')
  const done = todo.status === 'done'
  return (
    <li
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
        selected ? 'bg-accent/10' : 'hover:bg-surface-hover',
      )}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className={cn(
          'w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors',
          done ? 'bg-accent border-accent' : 'border-border',
        )}
        aria-label={t('toggleDone')}
      />
      <span className={cn('flex-1 text-sm', done ? 'line-through text-text-tertiary' : 'text-text-primary')}>
        {todo.text}
      </span>
      {todo.origin === 'github' && (
        <span className="text-[10px] px-1 rounded bg-surface text-text-tertiary">GH</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded text-text-tertiary hover:text-destructive"
        aria-label={t('delete')}
      >
        ×
      </button>
    </li>
  )
}
