import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  ListTodo,
  Moon,
  Play,
  RotateCcw,
  TimerReset,
  XCircle,
} from 'lucide-react'
import type { Todo, TodoRun, TodoStatus, TodoExecutionType } from '../../stores/todo-store'
import { useChatStore } from '../../stores/chat-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { cn } from '../ui/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import ConflictReview from './ConflictReview'
import CodeMirrorEditor from '../CodeMirrorEditor'
import MarkdownPreview from '../MarkdownPreview'
import { getCodeMirrorLanguage } from '../../lib/codemirror-language'
import { EditorView } from '@codemirror/view'
import { openSessionDirect } from '../../lib/session-jump'

interface TodoDetailProps {
  todo: Todo | null
  width: number
  onWidthChange: (width: number) => void
  onResolved: () => void
  /** Kept while older panel callers migrate; runs now open independently. */
  onClose: () => void
  onUpdateTodo: (todoId: string, patch: Partial<Todo>) => Promise<Todo | null>
  onChangeStatus: (todoId: string, status: TodoStatus) => Promise<void>
}

const MIN_WIDTH = 280
const MAX_WIDTH = 520
const SAVE_DEBOUNCE_MS = 800

function RunStatusIcon({ status }: { status: TodoRun['status'] }) {
  const className = 'h-3.5 w-3.5'
  if (status === 'succeeded') return <CheckCircle2 className={`${className} text-success`} />
  if (status === 'failed') return <XCircle className={`${className} text-destructive`} />
  if (status === 'running') return <Clock3 className={`${className} text-warning animate-pulse`} />
  return <CircleAlert className={`${className} text-text-tertiary`} />
}

/**
 * Detail pane for the selected todo (U3). Renders local fields plus sync/origin
 * state. Synced GitHub body/comments pass through Streamdown's default sanitize
 * schema (R16) once the sync engine (U5) populates them; private-repo content is
 * kept out of cross-workspace aggregation (R17) at the data layer.
 */
export default function TodoDetail({
  todo,
  width,
  onWidthChange,
  onResolved,
  onClose,
  onUpdateTodo,
  onChangeStatus,
}: TodoDetailProps) {
  const { t } = useTranslation('todos')
  const { workspaces } = useWorkspaceStore()
  const [spawning, setSpawning] = useState(false)
  const [bodyMode, setBodyMode] = useState<'edit' | 'preview'>('preview')
  const [bodyDraft, setBodyDraft] = useState('')
  const saveTimeoutRef = useRef<number | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const [runs, setRuns] = useState<TodoRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState(false)
  const [activeTab, setActiveTab] = useState<'details' | 'history'>('details')

  // Keep the local body draft in sync with the todo content.
  useEffect(() => {
    setBodyDraft(todo?.content ?? '')
  }, [todo?.content, todo?.id])

  useEffect(() => {
    setActiveTab('details')
  }, [todo?.id])

  useEffect(() => {
    if (!todo) { setRuns([]); setRunsLoading(false); setRunsError(false); return }
    let cancelled = false
    setRunsLoading(true)
    setRunsError(false)
    void fetch(`/api/todos/${todo.id}/runs`).then(async (res) => {
      if (!res.ok) throw new Error('Failed to fetch Todo runs')
      const data = await res.json()
      if (!cancelled) setRuns(data.runs ?? [])
    }).catch(() => {
      if (!cancelled) setRunsError(true)
    }).finally(() => {
      if (!cancelled) setRunsLoading(false)
    })
    return () => { cancelled = true }
  }, [todo?.id, todo?.updatedAt])

  const handleSpawn = async () => {
    if (!todo?.workspaceId) return
    setSpawning(true)
    try {
      const res = await fetch(`/api/todos/${todo.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: todo.workspaceId }),
      })
      if (!res.ok) return
      // Refresh the todo list so the new run + linked session show up.
      onResolved()
      // The session is created server-side (todo-execution-service), so the
      // chat-store does not know about it yet. Reload the workspace's session
      // list so the freshly started session appears, then open it so it loads
      // and streams. The todo panel stays open (runs open independently).
      const data = await res.json().catch(() => null) as { run?: TodoRun } | null
      const sessionId = data?.run?.sessionId
      if (sessionId) {
        await useChatStore.getState().fetchSessions(todo.workspaceId)
        openSessionDirect(todo.workspaceId, sessionId)
      }
    } finally {
      setSpawning(false)
    }
  }

  const canSpawn = !!todo && todo.status === 'pending' && !!todo.workspaceId

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)))
      }
      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [width, onWidthChange],
  )

  const handleWorkspaceChange = (workspaceId: string) => {
    if (!todo) return
    const shouldReactivateWorkspaceBlockedAutomation = workspaceId
      && !todo.workspaceId
      && todo.executionType === 'idle'
      && todo.executionStatus === 'disabled'
      && !todo.latestRun
    void onUpdateTodo(todo.id, {
      workspaceId: workspaceId || null,
      ...(shouldReactivateWorkspaceBlockedAutomation ? { executionStatus: 'active' as const } : {}),
    })
  }

  const handleStatusChange = (status: string) => {
    if (!todo) return
    void onChangeStatus(todo.id, status as TodoStatus)
  }

  const handleExecutionTypeChange = (executionType: string) => {
    if (!todo) return
    const type = executionType as TodoExecutionType
    void onUpdateTodo(todo.id, {
      executionType: type,
      executionStatus: type === 'manual' ? 'disabled' : 'active',
      scheduleTime: type === 'once' ? todo.scheduleTime : null,
      cronExpr: type === 'recurring' ? todo.cronExpr : null,
    })
  }

  const saveBody = useCallback(
    (next: string) => {
      if (!todo || next === (todo.content ?? '')) return
      void onUpdateTodo(todo.id, { content: next })
    },
    [todo, onUpdateTodo],
  )

  const handleBodyChange = (next: string) => {
    setBodyDraft(next)
    if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = window.setTimeout(() => saveBody(next), SAVE_DEBOUNCE_MS)
  }

  const handleBodyBlur = () => {
    if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current)
    saveBody(bodyDraft)
  }

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current)
    }
  }, [])

  const language = useMemo(() => getCodeMirrorLanguage('.md'), [])

  if (!todo) {
    return (
      <aside
        ref={asideRef}
        style={{ width }}
        className="relative flex-shrink-0 border-l border-border/50 bg-surface/30 flex items-center justify-center p-4 transition-[width] duration-300 ease-out"
      >
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-accent/50"
          onMouseDown={handleResizeMouseDown}
        />
        <p className="text-text-tertiary text-sm text-center">{t('noSelection')}</p>
      </aside>
    )
  }

  const statusLabel: Record<TodoStatus, string> = {
    pending: t('statusPending'),
    done: t('statusDone'),
    'did-but-need-verify': t('statusVerify'),
    discard: t('statusDiscard'),
  }
  const executionType = todo.executionType ?? 'manual'
  const executionTypeLabel: Record<TodoExecutionType, string> = {
    manual: t('executionManual'),
    once: t('executionOnce'),
    recurring: t('executionRecurring'),
    idle: t('executionIdle'),
  }
  const runStatusLabel: Record<TodoRun['status'], string> = {
    running: t('runStatusRunning'),
    succeeded: t('runStatusSucceeded'),
    failed: t('runStatusFailed'),
    missed: t('runStatusMissed'),
    skipped: t('runStatusSkipped'),
  }
  const executionStatusLabel = todo.executionStatus === 'paused'
    ? t('executionPaused')
    : todo.executionStatus === 'disabled'
      ? t('executionDisabled')
      : t('executionActive')

  return (
    <aside
      ref={asideRef}
      style={{ width }}
      className="relative flex-shrink-0 border-l border-border/50 bg-surface/30 flex flex-col transition-[width] duration-300 ease-out"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-accent/50 z-10"
        onMouseDown={handleResizeMouseDown}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <header className="border-b border-border/50 px-4 py-4 flex-shrink-0">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
              <ListTodo className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                className={cn(
                  'text-sm font-medium leading-5',
                  todo.status === 'done' ? 'line-through text-text-tertiary' : 'text-text-primary',
                )}
              >
                {todo.text}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="rounded-full bg-surface-hover px-2 py-0.5 font-medium text-text-secondary">{statusLabel[todo.status]}</span>
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-text-tertiary">{executionTypeLabel[executionType]}</span>
                {executionType !== 'manual' && (
                  <span className="rounded-full border border-border/60 px-2 py-0.5 text-text-tertiary">{executionStatusLabel}</span>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 -mb-4 flex" role="tablist" aria-label={t('detailTabs')}>
            <button type="button" role="tab" id="todo-detail-tab" aria-selected={activeTab === 'details'} aria-controls="todo-detail-panel"
              onClick={() => setActiveTab('details')}
              className={cn(
                'border-b-2 px-2.5 py-2 text-xs font-medium transition-colors',
                activeTab === 'details' ? 'border-accent text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary',
              )}>
              {t('detailTab')}
            </button>
            <button type="button" role="tab" id="todo-history-tab" aria-selected={activeTab === 'history'} aria-controls="todo-history-panel"
              onClick={() => setActiveTab('history')}
              className={cn(
                'border-b-2 px-2.5 py-2 text-xs font-medium transition-colors',
                activeTab === 'history' ? 'border-accent text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary',
              )}>
              {t('historyTab', { count: runs.length })}
            </button>
          </div>
        </header>

        {activeTab === 'details' ? (
          <div id="todo-detail-panel" role="tabpanel" aria-labelledby="todo-detail-tab" className="flex-1 overflow-y-auto">
            <div className="border-b border-border/50 px-4 py-4">
              <div className="flex flex-col gap-2">
                <button onClick={handleSpawn} disabled={!canSpawn || spawning}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50">
                  {runs.length ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {runs.length ? t('runAgain') : t('spawnSession')}
                </button>
                {todo.sessionId && todo.workspaceId && (
                  <button type="button" onClick={() => { openSessionDirect(todo.workspaceId!, todo.sessionId!); onClose() }}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary active:translate-y-px">
                    {t('detailHasSession')} <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <section className="border-b border-border/50 px-4 py-4">
            <SectionTitle icon={<CalendarClock className="h-3.5 w-3.5" />} title={t('detailExecution')} />
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <Field label={t('detailStatus')}>
              <Select value={todo.status} onValueChange={handleStatusChange}>
                <SelectTrigger className="w-full h-8 text-xs px-2.5" aria-label={t('detailStatus')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">{statusLabel.pending}</SelectItem>
                  <SelectItem value="done">{statusLabel.done}</SelectItem>
                  <SelectItem value="did-but-need-verify">{statusLabel['did-but-need-verify']}</SelectItem>
                  <SelectItem value="discard">{statusLabel.discard}</SelectItem>
                </SelectContent>
              </Select>
              </Field>
              <Field label={t('executionType')}>
                <Select value={executionType} onValueChange={handleExecutionTypeChange}>
                  <SelectTrigger className="w-full h-8 text-xs px-2.5" aria-label={t('executionType')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('executionManual')}</SelectItem>
                    <SelectItem value="once" disabled={!todo.workspaceId}>{t('executionOnce')}</SelectItem>
                    <SelectItem value="recurring" disabled={!todo.workspaceId}>{t('executionRecurring')}</SelectItem>
                    <SelectItem value="idle" disabled={!todo.workspaceId}>{t('executionIdle')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {!todo.workspaceId && (
                <div role="alert" className="col-span-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  {t('executionWorkspaceRequired')}
                </div>
              )}
              {executionType === 'once' && (
                <Field label={t('executionAt')} className="col-span-2">
                  <input type="datetime-local" value={todo.scheduleTime?.slice(0, 16) ?? ''}
                    onChange={(e) => void onUpdateTodo(todo.id, { scheduleTime: e.target.value ? new Date(e.target.value).toISOString() : null })}
                    aria-label={t('executionAt')}
                    className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs" />
                </Field>
              )}
              {executionType === 'recurring' && (
                <Field label={t('executionCron')} className="col-span-2">
                  <input value={todo.cronExpr ?? ''} onChange={(e) => void onUpdateTodo(todo.id, { cronExpr: e.target.value })}
                    placeholder="0 9 * * *" aria-label={t('executionCron')}
                    className="h-8 w-full rounded-md border border-border bg-bg px-2 text-xs" />
                </Field>
              )}
              {executionType === 'idle' && (
                <div className="col-span-2 flex items-center gap-2 rounded-md bg-surface-hover/50 px-3 py-2 text-[11px] text-text-secondary">
                  <Moon className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
                  {t('executionIdleHint')}
                </div>
              )}
              {todo.nextFireAt && executionType !== 'manual' && (
                <div className="col-span-2 flex items-center gap-2 text-[11px] text-text-tertiary">
                  <TimerReset className="h-3.5 w-3.5" />
                  {t('executionNextRun', { time: new Date(todo.nextFireAt).toLocaleString() })}
                </div>
              )}
            </dl>
          </section>

            <section className="border-b border-border/50 px-4 py-4">
            <SectionTitle icon={<ListTodo className="h-3.5 w-3.5" />} title={t('detailContext')} />
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <Field label={t('detailWorkspace')} className="col-span-2">
                <Select value={todo.workspaceId ?? ''} onValueChange={handleWorkspaceChange}>
                  <SelectTrigger className="w-full h-8 text-xs px-2.5" aria-label={t('detailWorkspace')}>
                  <SelectValue placeholder={t('noWorkspace')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value=""
                    disabled={(todo.executionType ?? 'manual') !== 'manual' && todo.executionStatus === 'active'}
                  >
                    {t('noWorkspace')}
                  </SelectItem>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              </Field>
              <Field label={t('detailOrigin')} value={todo.origin === 'github' ? t('originGithub') : t('originLocal')} />
              <Field label={t('detailDue')} value={todo.dueDate ?? '-'} />
              {todo.repoFullName && <Field label={t('groupRepo')} value={`${todo.repoFullName}#${todo.issueNumber ?? ''}`} />}
              <Field label={t('detailSynced')} value={todo.lastSyncedAt ? t('detailSynced') : t('detailNotSynced')} />
            </dl>
            </section>

            <section className="px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <SectionTitle title={t('detailBody')} />
              <div className="flex items-center gap-1 rounded-md bg-surface-hover/50 p-0.5 border border-border/50">
                <button
                  type="button"
                  onClick={() => setBodyMode('edit')}
                  className={cn(
                    'px-2 py-0.5 text-[11px] rounded transition-colors',
                    bodyMode === 'edit' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  onClick={() => setBodyMode('preview')}
                  className={cn(
                    'px-2 py-0.5 text-[11px] rounded transition-colors',
                    bodyMode === 'preview' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {t('preview')}
                </button>
              </div>
            </div>

            <div className="min-h-[120px] max-h-64 rounded-lg border border-border/50 bg-bg overflow-y-auto overflow-x-hidden">
              {bodyMode === 'edit' ? (
                <CodeMirrorEditor
                  value={bodyDraft}
                  language={language}
                  readOnly={false}
                  className="h-full min-h-[120px] text-xs"
                  extensions={[EditorView.lineWrapping]}
                  onChange={handleBodyChange}
                  onBlur={handleBodyBlur}
                />
              ) : bodyDraft.trim() === '' ? (
                <button
                  type="button"
                  onClick={() => setBodyMode('edit')}
                  className="w-full h-full min-h-[120px] flex items-center justify-center text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {t('noBody')}
                </button>
              ) : (
                <MarkdownPreview content={bodyDraft} className="text-xs px-3 py-2" />
              )}
            </div>
            <ConflictReview todoId={todo.id} onResolved={onResolved} />
            </section>
          </div>
        ) : (
          <section id="todo-history-panel" role="tabpanel" aria-labelledby="todo-history-tab" className="flex-1 overflow-y-auto px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <SectionTitle icon={<Clock3 className="h-3.5 w-3.5" />} title={t('executionHistory')} />
              {!runsLoading && !runsError && <span className="text-[10px] text-text-tertiary">{t('executionHistoryCount', { count: runs.length })}</span>}
            </div>
            {runsLoading ? (
              <div className="mt-3 space-y-3" aria-label={t('executionHistoryLoading')}>
                <div className="h-11 animate-pulse rounded-md bg-surface-hover/70" />
                <div className="h-11 animate-pulse rounded-md bg-surface-hover/50" />
              </div>
            ) : runsError ? (
              <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-3 text-xs leading-5 text-destructive">
                {t('executionHistoryLoadFailed')}
              </div>
            ) : runs.length === 0 ? (
              <div className="mt-3 rounded-md bg-surface-hover/50 px-3 py-3 text-xs leading-5 text-text-tertiary">
                {t('executionHistoryEmpty')}
              </div>
            ) : (
              <div className="mt-3 ml-1 border-l border-border/70 pl-3">
                {runs.map((run, index) => {
                  const canOpenSession = !!run.sessionId && !!todo.workspaceId
                  return <button key={run.id} type="button" disabled={!canOpenSession}
                    onClick={() => run.sessionId && todo.workspaceId && openSessionDirect(todo.workspaceId, run.sessionId)}
                    className={cn(
                      'group relative -ml-[13px] flex w-[calc(100%+13px)] items-start gap-2.5 rounded-md py-2 pl-3 pr-2 text-left transition-colors',
                      canOpenSession ? 'hover:bg-surface-hover active:translate-y-px' : 'cursor-default',
                      index === 0 ? 'pt-0' : '',
                    )}>
                    <span className="absolute left-[-7px] top-[13px] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface">
                      <RunStatusIcon status={run.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-medium text-text-primary">{runStatusLabel[run.status]}</span>
                        <time className="flex-shrink-0 text-[10px] text-text-tertiary">{new Date(run.fireAt).toLocaleString()}</time>
                      </div>
                      {run.reason && <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-secondary">{run.reason}</p>}
                    </div>
                    {canOpenSession && <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5" />}
                  </button>
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}

function SectionTitle({ icon, title }: { icon?: React.ReactNode; title: string }) {
  return <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-primary">{icon && <span className="text-text-tertiary">{icon}</span>}{title}</h3>
}

function Field({ label, value, children, className }: { label: string; value?: string; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <dt className="text-text-tertiary">{label}</dt>
      {children ?? <dd className="text-text-primary break-words">{value}</dd>}
    </div>
  )
}
