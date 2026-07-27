import { useTranslation } from 'react-i18next'
import type { Todo } from '../../stores/todo-store'
import { cn } from '../ui/utils'

interface TodoDetailProps {
  todo: Todo | null
}

/**
 * Detail pane for the selected todo (U3). Renders local fields plus sync/origin
 * state. Synced GitHub body/comments pass through Streamdown's default sanitize
 * schema (R16) once the sync engine (U5) populates them; private-repo content is
 * kept out of cross-workspace aggregation (R17) at the data layer.
 */
export default function TodoDetail({ todo }: TodoDetailProps) {
  const { t } = useTranslation('todos')

  if (!todo) {
    return (
      <aside className="w-72 flex-shrink-0 border-l border-border bg-surface/30 flex items-center justify-center p-4">
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
    <aside className="w-72 flex-shrink-0 border-l border-border bg-surface/30 flex flex-col">
      <div className="px-4 py-3 border-b border-border">
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
