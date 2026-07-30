import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import type { Todo } from '../../stores/todo-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { cn } from '../ui/utils'
import ConflictReview from './ConflictReview'

interface TodoDetailProps {
  todo: Todo | null
  onResolved: () => void
}

/**
 * Detail pane for the selected todo (U3). Renders local fields plus sync/origin
 * state. Synced GitHub body/comments pass through Streamdown's default sanitize
 * schema (R16) once the sync engine (U5) populates them; private-repo content is
 * kept out of cross-workspace aggregation (R17) at the data layer.
 */
export default function TodoDetail({ todo, onResolved }: TodoDetailProps) {
  const { t } = useTranslation('todos')
  const { workspaces } = useWorkspaceStore()
  const [pickedWorkspace, setPickedWorkspace] = useState<string>('')
  const [spawning, setSpawning] = useState(false)

  const handleSpawn = async () => {
    if (!todo) return
    const target = todo.workspaceId ?? pickedWorkspace
    if (!target) return
    setSpawning(true)
    try {
      const res = await fetch(`/api/todos/${todo.id}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: target }),
      })
      if (res.ok) onResolved()
    } finally {
      setSpawning(false)
    }
  }

  const canSpawn = !!todo && todo.status === 'pending' && !todo.sessionId && (!!todo.workspaceId || !!pickedWorkspace)

  if (!todo) {
    return (
      <aside className="w-72 flex-shrink-0 border-l border-border/50 bg-surface/30 flex items-center justify-center p-4">
        <p className="text-text-tertiary text-sm text-center">{t('noSelection')}</p>
      </aside>
    )
  }

  const statusLabel: Record<Todo['status'], string> = {
    pending: t('statusPending'),
    done: t('statusDone'),
    'did-but-need-verify': t('statusVerify'),
    discard: t('statusDiscard'),
  }

  return (
    <aside className="w-72 flex-shrink-0 border-l border-border/50 bg-surface/30 flex flex-col">
      <div className="px-4 py-3 border-b border-border/50">
        <h2 className={cn('text-sm font-medium', todo.status === 'done' ? 'line-through text-text-tertiary' : 'text-text-primary')}>
          {todo.text}
        </h2>
      </div>
      <dl className="flex flex-col gap-3 p-4 text-xs">
        <Field label={t('detailStatus')} value={statusLabel[todo.status]} />
        <Field label={t('detailOrigin')} value={todo.origin === 'github' ? t('originGithub') : t('originLocal')} />
        <Field label={t('detailWorkspace')} value={todo.workspaceId ?? t('noWorkspace')} />
        <Field label={t('detailDue')} value={todo.dueDate ?? '—'} />
        {todo.repoFullName && <Field label={t('groupRepo')} value={`${todo.repoFullName}#${todo.issueNumber ?? ''}`} />}
        <Field label={t('detailSynced')} value={todo.lastSyncedAt ? t('detailSynced') : t('detailNotSynced')} />
      </dl>

      <div className="px-4 pb-4">
        <ConflictReview todoId={todo.id} onResolved={onResolved} />

        {/* U7 (R4): start a session from a todo. A workspace-less todo picks a target first. */}
        {todo.sessionId ? (
          <p className="text-[11px] text-text-tertiary">{t('detailHasSession')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {!todo.workspaceId && (
              <select
                value={pickedWorkspace}
                onChange={(e) => setPickedWorkspace(e.target.value)}
                className="bg-surface text-text-primary text-xs rounded px-1.5 py-1 border border-border focus:outline-none"
              >
                <option value="">{t('spawnPickWorkspace')}</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={handleSpawn}
              disabled={!canSpawn || spawning}
              className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 text-xs"
            >
              <Play className="w-3.5 h-3.5" />
              {t('spawnSession')}
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="text-text-primary break-words">{value}</dd>
    </div>
  )
}
