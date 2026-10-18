import { Loader2, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionBackgroundTask } from '../types/message'

function taskRows(tasks: SessionBackgroundTask[]) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const children = new Map<string | undefined, SessionBackgroundTask[]>()
  for (const task of tasks) {
    let parentId = byId.has(task.parentTaskId ?? '') ? task.parentTaskId : undefined
    const visited = new Set([task.id])
    let ancestor = parentId
    while (ancestor && byId.has(ancestor)) {
      if (visited.has(ancestor)) { parentId = undefined; break }
      visited.add(ancestor)
      ancestor = byId.get(ancestor)?.parentTaskId
    }
    const siblings = children.get(parentId) ?? []
    siblings.push(task)
    children.set(parentId, siblings)
  }
  const rows: Array<{ task: SessionBackgroundTask; depth: number }> = []
  const pending = (children.get(undefined) ?? []).map(task => ({ task, depth: 0 })).reverse()
  while (pending.length) {
    const row = pending.pop()!
    rows.push(row)
    for (const child of [...(children.get(row.task.id) ?? [])].reverse()) pending.push({ task: child, depth: row.depth + 1 })
  }
  return rows
}

interface BackgroundTaskListProps {
  tasks: SessionBackgroundTask[]
  supportsStop: boolean
  typeLabel: (type: string) => string
  isStopping: (task: SessionBackgroundTask) => boolean
  onStop: (task: SessionBackgroundTask) => void
}

export default function BackgroundTaskList({ tasks, supportsStop, typeLabel, isStopping, onStop }: BackgroundTaskListProps) {
  const { t } = useTranslation('chat')
  const renderRows = (entries: SessionBackgroundTask[]) => taskRows(entries).map(({ task, depth }) => {
    const stopping = isStopping(task)
    const stopLabel = t(stopping ? 'activity.stoppingTask' : 'activity.stopTask', { description: task.description })
    return <div key={JSON.stringify([task.id, task.runId])} className="flex min-w-0 items-start gap-1.5 leading-4" style={{ paddingInlineStart: `${Math.min(depth, 4) * 12}px` }}>
      <span className="max-w-28 shrink-0 break-words text-text-tertiary">
        <span className="block">{typeLabel(task.type)}</span>
        {task.subagentType && <span className="block">{task.subagentType}</span>}
      </span>
      <span className="min-w-0 flex-1 break-words">{task.description}</span>
      {supportsStop && <button type="button" onClick={() => onStop(task)} disabled={stopping}
        aria-label={stopLabel} title={stopLabel}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60">
        {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-2.5 w-2.5 fill-current" />}
      </button>}
    </div>
  })
  const maintenance = tasks.filter(task => task.ambient)
  return <div className="mt-0.5 space-y-1">
    {renderRows(tasks.filter(task => !task.ambient))}
    {maintenance.length > 0 && <details className="pt-1 text-text-tertiary">
      <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">{t('activity.maintenance', { count: maintenance.length })}</summary>
      <div className="mt-1 space-y-1">{renderRows(maintenance)}</div>
    </details>}
  </div>
}
