import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Pencil,
  Play,
  Pause,
  Plus,
  Trash2,
  X,
} from 'lucide-react'

import { cn } from './ui/utils'
import { useScheduledTaskStore, type ScheduledTaskWithLatestRun } from '../stores/scheduled-task-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { openSessionDirect } from '../lib/session-jump'
import { describeCron } from '../lib/cron-presets'
import type { TaskRun } from '@server/models/scheduled-task.js'
import { ScheduledTaskForm } from './ScheduledTaskForm'

interface ScheduledTasksPanelProps {
  onClose: () => void
}

type PanelView = { kind: 'list' } | { kind: 'detail'; task: ScheduledTaskWithLatestRun } | { kind: 'form'; task: ScheduledTaskWithLatestRun | null }

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDuration(run: TaskRun): string {
  if (!run.startedAt || !run.endedAt) return '—'
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function describeSchedule(task: ScheduledTaskWithLatestRun, t: (k: string) => string): string {
  if (task.scheduleType === 'once') return `${t('form.once')} · ${formatTime(task.scheduleTime)}`
  return describeCron(task.cronExpr ?? '', {
    hourly: t('form.hourly'),
    daily: t('form.daily'),
    weekdays: t('form.weekdays'),
    weekly: t('form.weekly'),
    weekdayLabel: (day) => t(`weekday.${day}`),
  })
}

const RUN_STATUS_STYLES: Record<string, string> = {
  running: 'bg-blue-500/15 text-blue-500',
  succeeded: 'bg-green-500/15 text-green-600',
  failed: 'bg-red-500/15 text-red-500',
  missed: 'bg-amber-500/15 text-amber-600',
  skipped: 'bg-gray-500/15 text-gray-500',
}

function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation('scheduledTasks')
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', RUN_STATUS_STYLES[status] ?? 'bg-gray-500/15 text-gray-500')}>
      {t(`status.${status}`)}
    </span>
  )
}

function panelTitle(view: PanelView, t: (k: string) => string): string {
  if (view.kind === 'detail') return view.task.name
  if (view.kind === 'form') return view.task ? t('form.editTitle') : t('form.createTitle')
  return t('panel.title')
}

export default function ScheduledTasksPanel({ onClose }: ScheduledTasksPanelProps) {
  const { t } = useTranslation('scheduledTasks')
  const tasks = useScheduledTaskStore((s) => s.tasks)
  const loading = useScheduledTaskStore((s) => s.loading)
  const defaultBackend = useScheduledTaskStore((s) => s.defaultBackend)
  const fetchTasks = useScheduledTaskStore((s) => s.fetchTasks)
  const fetchDefaultBackend = useScheduledTaskStore((s) => s.fetchDefaultBackend)
  const clearUnread = useScheduledTaskStore((s) => s.clearUnread)
  const confirmTask = useScheduledTaskStore((s) => s.confirmTask)
  const deleteTask = useScheduledTaskStore((s) => s.deleteTask)
  const runNow = useScheduledTaskStore((s) => s.runNow)
  const updateTask = useScheduledTaskStore((s) => s.updateTask)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const [view, setView] = useState<PanelView>({ kind: 'list' })
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    clearUnread()
    void fetchTasks()
    void fetchDefaultBackend()
  }, [clearUnread, fetchTasks, fetchDefaultBackend])

  const workspaceName = useMemo(() => {
    const map = new Map(workspaces.map((w) => [w.id, w.name]))
    return (id: string) => map.get(id) ?? id
  }, [workspaces])

  const degraded = defaultBackend !== null && defaultBackend !== 'claude'
  const drafts = tasks.filter((task) => task.status === 'draft')
  const active = tasks.filter((task) => task.status !== 'draft')

  const handle = async (fn: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[720px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            {view.kind !== 'list' && (
              <button
                onClick={() => setView({ kind: 'list' })}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
                title={t('panel.back')}
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <Clock className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-medium text-text-primary">{panelTitle(view, t)}</h2>
          </div>
          <div className="flex items-center gap-1">
            {view.kind === 'list' && (
              <button
                onClick={() => setView({ kind: 'form', task: null })}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-accent hover:bg-accent/10"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('panel.newTask')}
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover" title={t('panel.close')}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {actionError && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-md bg-red-500/10 text-red-500 text-xs">{actionError}</div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {view.kind === 'form' && (
            <ScheduledTaskForm
              task={view.task}
              workspaces={workspaces}
              degraded={degraded}
              onCancel={() => setView({ kind: 'list' })}
              onSaved={() => setView({ kind: 'list' })}
            />
          )}

          {view.kind === 'detail' && (
            <TaskRunHistory
              task={view.task}
              degraded={degraded}
              onOpenSession={(sessionId) => {
                openSessionDirect(view.task.workspaceId, sessionId)
                onClose()
              }}
            />
          )}

          {view.kind === 'list' && (
            <>
              {degraded && (
                <div className="mb-3 px-3 py-2 rounded-md bg-amber-500/10 text-amber-600 text-xs">{t('panel.degraded')}</div>
              )}

              {drafts.length > 0 && (
                <section className="mb-4">
                  <h3 className="text-xs font-medium text-text-secondary mb-1.5">{t('panel.pendingSection')}</h3>
                  <p className="text-[11px] text-text-tertiary mb-2">{t('panel.confirmHint')}</p>
                  <div className="space-y-1.5">
                    {drafts.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/5">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-text-primary truncate">{task.name}</div>
                          <div className="text-[11px] text-text-tertiary truncate">
                            {workspaceName(task.workspaceId)} · {describeSchedule(task, t)}
                          </div>
                          <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg/60 px-2 py-1 text-[11px] text-text-secondary">
                            {task.instruction}
                          </div>
                        </div>
                        <button
                          onClick={() => setView({ kind: 'form', task })}
                          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
                          title={t('panel.edit')}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handle(() => confirmTask(task.workspaceId, task.id))}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-green-600 hover:bg-green-500/10"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {t('panel.confirm')}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h3 className="text-xs font-medium text-text-secondary mb-1.5">{t('panel.tasksSection')}</h3>
                {active.length === 0 && drafts.length === 0 && !loading && (
                  <p className="text-xs text-text-tertiary py-6 text-center">{t('panel.empty')}</p>
                )}
                <div className="space-y-1">
                  {active.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-surface-hover cursor-pointer"
                      onClick={() => setView({ kind: 'detail', task })}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-text-primary truncate">{task.name}</span>
                          <StatusChip status={task.status} />
                          {task.latestRun && <StatusChip status={task.latestRun.status} />}
                        </div>
                        <div className="text-[11px] text-text-tertiary truncate">
                          {workspaceName(task.workspaceId)} · {describeSchedule(task, t)} · {t('panel.nextFire')} {formatTime(task.nextFireAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        {task.status === 'active' && (
                          <button onClick={() => handle(() => updateTask(task.workspaceId, task.id, { status: 'paused' }))} className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-hover" title={t('panel.pause')}>
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {task.status === 'paused' && (
                          <button onClick={() => handle(() => updateTask(task.workspaceId, task.id, { status: 'active' }))} className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-hover" title={t('panel.resume')}>
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {(task.status === 'active' || task.status === 'paused') && (
                          <button onClick={() => handle(() => runNow(task.workspaceId, task.id))} className="p-1 rounded text-text-tertiary hover:text-accent hover:bg-accent/10" title={t('panel.runNow')}>
                            <Clock className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => setView({ kind: 'form', task })} className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-hover" title={t('panel.edit')}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(t('panel.deleteConfirm'))) {
                              void handle(() => deleteTask(task.workspaceId, task.id))
                            }
                          }}
                          className="p-1 rounded text-text-tertiary hover:text-red-500 hover:bg-red-500/10"
                          title={t('panel.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskRunHistory({
  task,
  degraded,
  onOpenSession,
}: {
  task: ScheduledTaskWithLatestRun
  degraded: boolean
  onOpenSession: (sessionId: string) => void
}) {
  const { t } = useTranslation('scheduledTasks')
  const fetchRuns = useScheduledTaskStore((s) => s.fetchRuns)
  const [runs, setRuns] = useState<TaskRun[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchRuns(task.workspaceId, task.id).then((r) => {
      if (!cancelled) setRuns(r)
    })
    return () => {
      cancelled = true
    }
  }, [fetchRuns, task.workspaceId, task.id])

  return (
    <div>
      <div className="text-[11px] text-text-tertiary mb-2">
        {t('panel.schedule')}: {task.scheduleType === 'once' ? `${t('form.once')} · ${formatTime(task.scheduleTime)}` : task.cronExpr}
        {degraded && <span className="ml-2 text-amber-600">{t('panel.degraded')}</span>}
      </div>
      <h3 className="text-xs font-medium text-text-secondary mb-1.5">{t('panel.history')}</h3>
      {runs === null && <p className="text-xs text-text-tertiary py-4 text-center">…</p>}
      {runs !== null && runs.length === 0 && (
        <p className="text-xs text-text-tertiary py-4 text-center">{t('panel.empty')}</p>
      )}
      <div className="space-y-1">
        {(runs ?? []).map((run) => (
          <button
            key={run.id}
            disabled={!run.sessionId}
            onClick={() => run.sessionId && onOpenSession(run.sessionId)}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-md text-left',
              run.sessionId ? 'hover:bg-surface-hover cursor-pointer' : 'opacity-70 cursor-default',
            )}
          >
            <StatusChip status={run.status} />
            <span className="text-[11px] text-text-secondary">{formatTime(run.fireAt)}</span>
            <span className="text-[11px] text-text-tertiary">{formatDuration(run)}</span>
            {run.reason && <span className="text-[11px] text-text-tertiary truncate flex-1">{run.reason}</span>}
            {run.sessionId && <span className="text-[11px] text-accent ml-auto">{t('panel.openSession')}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
