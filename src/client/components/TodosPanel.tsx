import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X, Plus, Loader2, Github, RefreshCw } from 'lucide-react'
import { useTodoStore, type Todo } from '../stores/todo-store'
import { useGithubStore } from '../stores/github-store'
import { cn } from './ui/utils'
import TodoDetail from './todos/TodoDetail'
import TodoRow from './todos/TodoRow'
import GitHubConnect from './todos/GitHubConnect'
import ModalPanel from './ModalPanel'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export type SmartView = 'inbox' | 'today' | 'upcoming' | 'all'
export type GroupBy = 'none' | 'workspace' | 'repo' | 'origin'

interface TodosPanelProps {
  isOpen: boolean
  onClose: () => void
}

const VIEWS: { id: SmartView; labelKey: string }[] = [
  { id: 'inbox', labelKey: 'viewInbox' },
  { id: 'today', labelKey: 'viewToday' },
  { id: 'upcoming', labelKey: 'viewUpcoming' },
  { id: 'all', labelKey: 'viewAll' },
]

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

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
  )
}

export default function TodosPanel({ isOpen, onClose }: TodosPanelProps) {
  const { t } = useTranslation('todos')
  const {
    todos,
    isLoading,
    isSyncing,
    error,
    fetchTodos,
    syncTodos,
    createTodo,
    changeStatus,
    updateTodo,
    deleteTodo,
    setSearchQuery,
    searchQuery,
  } = useTodoStore()
  const lastSyncErrors = useTodoStore((s) => s.lastSyncErrors)
  const githubConnected = useGithubStore((s) => s.connection?.connected ?? false)
  const fetchGithubStatus = useGithubStore((s) => s.fetchStatus)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<SmartView>('inbox')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showConnect, setShowConnect] = useState(false)
  const [detailWidth, setDetailWidth] = useState(384)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    fetchTodos()
    fetchGithubStatus()
  }, [isOpen, fetchTodos, fetchGithubStatus])

  // AE5: opening the panel triggers an on-demand sync when connected.
  useEffect(() => {
    if (!isOpen || !githubConnected) return
    syncTodos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, githubConnected])

  // R13: reset search query when the panel opens.
  useEffect(() => {
    if (!isOpen) return
    setSearchQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // AE4: Escape in the search input clears the query first, then blurs on a
  // second press. The shell-level Escape listener skips text inputs so this
  // panel can implement its own search behavior.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTextInput(e.target)) return
      const input = searchInputRef.current
      if (!input || document.activeElement !== input) return
      e.stopPropagation()
      if (searchQuery) {
        setSearchQuery('')
      } else {
        input.blur()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [searchQuery, setSearchQuery])

  const query = searchQuery.trim().toLowerCase()

  const visibleTodos = useMemo(() => {
    const byView = filterByView(todos, view)
    if (!query) return byView
    return byView.filter((todo) => todo.text.toLowerCase().includes(query))
  }, [todos, view, query])

  // Start every panel visit with the first item in the active view selected.
  // If a filter or view removes the current selection, keep the detail pane in
  // sync with the first visible Todo instead of leaving a stale selection.
  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null)
      return
    }
    const firstVisibleId = visibleTodos[0]?.id ?? null
    setSelectedId((currentId) => {
      if (currentId && visibleTodos.some((todo) => todo.id === currentId)) return currentId
      return firstVisibleId
    })
  }, [isOpen, visibleTodos])

  const viewCounts = useMemo(() => {
    const counts: Record<SmartView, number> = { inbox: 0, today: 0, upcoming: 0, all: 0 }
    for (const v of VIEWS) {
      counts[v.id] = filterByView(todos, v.id).length
    }
    return counts
  }, [todos])

  const grouped = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', items: visibleTodos }]
    const map = new Map<string, Todo[]>()
    for (const todo of visibleTodos) {
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
  }, [visibleTodos, groupBy, t])

  const handleAdd = async () => {
    const text = draft.trim()
    if (!text) return
    const todo = await createTodo(text)
    setDraft('')
    // R14: clear search if the new todo would be hidden by the active query.
    if (todo && query && !todo.text.toLowerCase().includes(query)) {
      setSearchQuery('')
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (searchQuery) {
        setSearchQuery('')
      } else {
        searchInputRef.current?.blur()
      }
    }
  }

  const clearSearch = () => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  const selected = todos.find((todo) => todo.id === selectedId) ?? null

  return (
    <ModalPanel open={isOpen} onClose={onClose}>
      {/* Card */}
      <div className="relative w-full h-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 border-b border-border/50 bg-surface">
            <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 h-auto min-h-[3.5rem] py-2">
              {/* Segmented view control */}
              <div
                role="tablist"
                aria-label={t('viewControl')}
                className="flex items-center gap-1 p-1 rounded-lg bg-surface-hover/50 border border-border/50"
              >
                {VIEWS.map((v) => {
                  const active = view === v.id
                  const count = viewCounts[v.id]
                  return (
                    <button
                      key={v.id}
                      role="tab"
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      onClick={() => setView(v.id)}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap',
                        active
                          ? 'bg-surface text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
                      )}
                      aria-label={t('viewCountLabel', { view: t(v.labelKey), count })}
                      title={t('viewCountLabel', { view: t(v.labelKey), count })}
                    >
                      <span>{t(v.labelKey)}</span>
                      <span
                        className={cn(
                          'text-[10px] px-1 py-0 rounded-full min-w-[1rem] text-center',
                          active ? 'bg-accent/10 text-accent' : 'bg-surface-hover text-text-tertiary',
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  )
                })}
              </div>

              <div className="flex-1" />

              {/* Search */}
              <div className="relative w-full sm:w-56 lg:w-64 order-last sm:order-none">
                <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                  <Search className="w-3.5 h-3.5 text-text-tertiary" />
                </div>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t('searchPlaceholder')}
                  aria-label={t('searchPlaceholder')}
                  className="w-full h-[34px] pl-8 pr-7 py-1.5 text-xs bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                {query && (
                  <button
                    type="button"
                    onClick={clearSearch}
                    aria-label={t('searchClear')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Group by */}
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
                <SelectTrigger className="w-28 sm:w-32 h-[34px] text-xs px-2.5" aria-label={t('groupBy')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('groupNone')}</SelectItem>
                  <SelectItem value="workspace">{t('groupWorkspace')}</SelectItem>
                  <SelectItem value="repo">{t('groupRepo')}</SelectItem>
                  <SelectItem value="origin">{t('groupOrigin')}</SelectItem>
                </SelectContent>
              </Select>

              {/* Sync */}
              <button
                onClick={() => syncTodos()}
                disabled={isSyncing}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover disabled:opacity-50"
                aria-label={t('sync')}
                title={t('sync')}
              >
                <RefreshCw className={cn('w-4 h-4', isSyncing && 'animate-spin')} />
              </button>

              {/* GitHub connect */}
              <button
                onClick={() => setShowConnect(true)}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border',
                  githubConnected
                    ? 'border-green-500/40 text-green-600 dark:text-green-400 bg-green-500/10'
                    : 'border-border text-text-secondary hover:bg-surface-hover',
                )}
                aria-label={t('ghConnect')}
                title={t('ghConnect')}
              >
                <Github className="w-3.5 h-3.5" />
                {githubConnected ? t('ghConnected') : t('ghConnect')}
              </button>

              {/* Close */}
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
                aria-label={t('close')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Sync-error strip */}
          {lastSyncErrors && lastSyncErrors.length > 0 && (
            <div className="flex items-start gap-2 px-4 sm:px-6 py-1.5 border-b border-border/50 bg-yellow-500/5 flex-shrink-0">
              <span className="text-[11px] text-yellow-600 dark:text-yellow-400 flex-1">
                {t('syncFailedRepos', { count: lastSyncErrors.length })}{' '}
                <span className="text-text-tertiary">{lastSyncErrors[0].repo}: {lastSyncErrors[0].message}</span>
              </span>
              <button
                onClick={() => useTodoStore.setState({ lastSyncErrors: null })}
                className="text-text-tertiary hover:text-text-primary text-xs"
                aria-label={t('close')}
              >
                ×
              </button>
            </div>
          )}

          {/* Body */}
          <div className="flex flex-1 overflow-hidden bg-bg">
            {/* List */}
            <div className="flex-1 overflow-y-auto min-w-0" role="region" aria-label={t('title')}>
              {/* Quick add */}
              <div className="px-4 sm:px-6 py-3 border-b border-border/50">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAdd}
                    className="p-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover"
                    aria-label={t('add')}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAdd()
                    }}
                    placeholder={t('addPlaceholder')}
                    className="flex-1 bg-transparent text-text-primary text-sm outline-none placeholder:text-text-tertiary"
                  />
                </div>
              </div>

              {/* List content */}
              <div className="px-2 sm:px-4 py-2">
                {isLoading && todos.length === 0 ? (
                  <div className="flex items-center justify-center h-40 text-text-tertiary">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                ) : error && todos.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-3">
                    <p className="text-sm text-destructive">{error}</p>
                    <button
                      onClick={() => fetchTodos()}
                      className="px-3 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
                    >
                      {t('retry')}
                    </button>
                  </div>
                ) : visibleTodos.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                    {query ? (
                      <>
                        <p className="text-sm text-text-tertiary">
                          {t('noResults', { query })}
                        </p>
                        <button
                          onClick={clearSearch}
                          className="text-xs text-accent hover:text-accent-hover underline underline-offset-2"
                        >
                          {t('clearSearch')}
                        </button>
                      </>
                    ) : (
                      <p className="text-sm text-text-tertiary">{t('empty')}</p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {grouped.map((group) =>
                      group.items.length === 0 ? null : (
                        <section key={group.key || 'default'}>
                          {group.key && (
                            <h3 className="px-2 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                              {group.key}
                            </h3>
                          )}
                          <ul className="flex flex-col">
                            {group.items.map((todo) => (
                              <TodoRow
                                key={todo.id}
                                todo={todo}
                                selected={todo.id === selectedId}
                                onSelect={() => setSelectedId(todo.id)}
                                onToggle={() => changeStatus(todo.id, todo.status === 'done' ? 'pending' : 'done')}
                                onDelete={() => deleteTodo(todo.id)}
                                onRename={(text) => {
                                  void updateTodo(todo.id, { text })
                                }}
                              />
                            ))}
                          </ul>
                        </section>
                      ),
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Detail pane */}
            <TodoDetail
              todo={selected}
              width={detailWidth}
              onWidthChange={setDetailWidth}
              onResolved={fetchTodos}
              onClose={onClose}
              onUpdateTodo={updateTodo}
              onChangeStatus={changeStatus}
            />
          </div>

          {showConnect && <GitHubConnect onClose={() => setShowConnect(false)} />}
        </div>
      </ModalPanel>
  )
}
