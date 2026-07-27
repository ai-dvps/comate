import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Loader2 } from 'lucide-react'
import { useTodoStore, type Todo } from '../stores/todo-store'
import { cn } from './ui/utils'

interface TodosPanelProps {
  onClose: () => void
}

/**
 * Top-level Todos panel (U2 shell). Occupies the main view (mounted as a
 * main-area layer in App.tsx, not a dismissable overlay). U3 replaces the flat
 * list with smart views (Inbox/Today/Upcoming) + groupings + a detail pane.
 */
export default function TodosPanel({ onClose }: TodosPanelProps) {
  const { t } = useTranslation('todos')
  const { todos, isLoading, fetchTodos, createTodo, changeStatus, deleteTodo } = useTodoStore()
  const [draft, setDraft] = useState('')

  useEffect(() => {
    fetchTodos()
  }, [fetchTodos])

  const handleAdd = async () => {
    if (!draft.trim()) return
    await createTodo(draft)
    setDraft('')
  }

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

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-text-tertiary">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : todos.length === 0 ? (
          <p className="text-center text-text-tertiary text-sm mt-8">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {todos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                onToggle={() => changeStatus(todo.id, todo.status === 'done' ? 'pending' : 'done')}
                onDelete={() => deleteTodo(todo.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TodoRow({ todo, onToggle, onDelete }: { todo: Todo; onToggle: () => void; onDelete: () => void }) {
  const { t } = useTranslation('todos')
  const done = todo.status === 'done'
  return (
    <li className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-hover">
      <button
        onClick={onToggle}
        className={cn(
          'w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors',
          done ? 'bg-accent border-accent' : 'border-border',
        )}
        aria-label={t('toggleDone')}
      />
      <span className={cn('flex-1 text-sm', done ? 'line-through text-text-tertiary' : 'text-text-primary')}>
        {todo.text}
      </span>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-1 rounded text-text-tertiary hover:text-destructive"
        aria-label={t('delete')}
      >
        ×
      </button>
    </li>
  )
}
