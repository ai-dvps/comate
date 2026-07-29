import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Save, Loader2, Pencil, Eye } from 'lucide-react'
import { markdown } from '@codemirror/lang-markdown'
import type { Todo } from '../../stores/todo-store'
import {
  useTodoStore,
  MAX_TODO_TEXT_LENGTH,
  MAX_TODO_CONTENT_LENGTH,
} from '../../stores/todo-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { cn } from '../ui/utils'
import CodeMirrorEditor from '../CodeMirrorEditor'
import MarkdownPreview from '../MarkdownPreview'
import ConflictReview from './ConflictReview'

interface TodoDetailProps {
  todo: Todo | null
  onResolved: () => void
}

/**
 * Detail pane for the selected todo. Title and the optional markdown `content`
 * body are both editable (R3) and persist on an explicit save action (R4):
 * clicking Save or pressing Ctrl/Cmd+S. The content body offers an edit/preview
 * toggle reusing the app's CodeMirror editor and Streamdown preview (KTD3).
 *
 * Synced GitHub body/comments pass through Streamdown's default sanitize
 * schema (R16) once the sync engine populates them; private-repo content is
 * kept out of cross-workspace aggregation (R17) at the data layer.
 */
export default function TodoDetail({ todo, onResolved }: TodoDetailProps) {
  const { t } = useTranslation('todos')
  const { workspaces } = useWorkspaceStore()
  const updateTodo = useTodoStore((s) => s.updateTodo)
  const [pickedWorkspace, setPickedWorkspace] = useState<string>('')
  const [spawning, setSpawning] = useState(false)

  // Editable drafts for title (text) and content (markdown body).
  const [draftTitle, setDraftTitle] = useState(todo?.text ?? '')
  const [draftContent, setDraftContent] = useState(todo?.content ?? '')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const markdownLang = useMemo(() => markdown(), [])

  // Latest drafts and the last-committed snapshot, kept in refs so the
  // todo-switch effect can auto-save outgoing edits — we never silently drop
  // unsaved work.
  const draftsRef = useRef({ title: draftTitle, content: draftContent })
  draftsRef.current = { title: draftTitle, content: draftContent }
  const lastSavedRef = useRef<{ id: string; text: string; content: string | null } | null>(
    todo ? { id: todo.id, text: todo.text, content: todo.content } : null,
  )

  useEffect(() => {
    const prev = lastSavedRef.current
    const prevText = prev?.text ?? ''
    const prevContent = prev?.content ?? ''
    const draftsDirty =
      draftsRef.current.title !== prevText || draftsRef.current.content !== prevContent

    // On todo switch: auto-save outgoing dirty drafts (never silently discard).
    if (prev && todo && prev.id !== todo.id && draftsDirty) {
      void updateTodo(prev.id, {
        text: draftsRef.current.title,
        content: draftsRef.current.content,
      })
    }

    const switched = !prev || !todo || prev.id !== todo?.id
    const incomingText = todo?.text ?? ''
    const incomingContent = todo?.content ?? ''
    // Re-anchor drafts on switch, or when an external update arrives and the
    // user is not mid-edit (lets a sync refresh the view without clobbering).
    if (switched || !draftsDirty) {
      setDraftTitle(incomingText)
      setDraftContent(incomingContent)
      if (switched) {
        setMode('edit')
        setSaveError(null)
      }
    }
    lastSavedRef.current = todo ? { id: todo.id, text: todo.text, content: todo.content } : null
  }, [todo, updateTodo])

  const isDirty = !!todo && (draftTitle !== todo.text || draftContent !== (todo.content ?? ''))

  const handleSave = useCallback(async () => {
    if (!todo || saving) return
    if (!draftTitle.trim()) {
      setSaveError(t('titleRequired'))
      return
    }
    if (draftTitle.length > MAX_TODO_TEXT_LENGTH) {
      setSaveError(t('titleTooLong', { max: MAX_TODO_TEXT_LENGTH }))
      return
    }
    if (draftContent.length > MAX_TODO_CONTENT_LENGTH) {
      setSaveError(t('contentTooLong', { max: MAX_TODO_CONTENT_LENGTH }))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await updateTodo(todo.id, { text: draftTitle, content: draftContent })
      if (updated) {
        lastSavedRef.current = { id: todo.id, text: draftTitle, content: draftContent }
      } else {
        setSaveError(t('updateFailed'))
      }
    } catch {
      setSaveError(t('updateFailed'))
    } finally {
      setSaving(false)
    }
  }, [todo, saving, draftTitle, draftContent, updateTodo, t])

  // Ctrl/Cmd+S triggers the explicit save (KTD7).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

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
      <aside className="w-96 flex-shrink-0 border-l border-border bg-surface/30 flex items-center justify-center p-4">
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
    <aside className="w-96 flex-shrink-0 border-l border-border bg-surface/30 flex flex-col overflow-y-auto">
      {/* Title (editable) */}
      <div className="px-4 py-3 border-b border-border">
        <input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder={t('titlePlaceholder')}
          aria-label={t('titlePlaceholder')}
          className={cn(
            'w-full bg-bg text-sm font-medium rounded-md px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-accent',
            todo.status === 'done' ? 'line-through text-text-tertiary' : 'text-text-primary',
          )}
        />
      </div>

      {/* Content (markdown, edit/preview toggle) */}
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-tertiary">{t('detailContent')}</span>
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setMode('edit')}
              aria-pressed={mode === 'edit'}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded text-xs',
                mode === 'edit'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-text-secondary hover:bg-surface-hover',
              )}
            >
              <Pencil className="w-3 h-3" />
              {t('edit')}
            </button>
            <button
              type="button"
              onClick={() => setMode('preview')}
              aria-pressed={mode === 'preview'}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded text-xs',
                mode === 'preview'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-text-secondary hover:bg-surface-hover',
              )}
            >
              <Eye className="w-3 h-3" />
              {t('preview')}
            </button>
          </div>
        </div>

        <div className="min-h-[10rem] rounded-md border border-border bg-bg overflow-hidden">
          {mode === 'edit' ? (
            <CodeMirrorEditor
              value={draftContent}
              onChange={setDraftContent}
              language={markdownLang}
              readOnly={false}
              className="text-sm"
            />
          ) : draftContent.trim() ? (
            <MarkdownPreview content={draftContent} className="px-4 py-3" />
          ) : (
            <p className="text-text-tertiary text-xs px-4 py-3">{t('contentEmpty')}</p>
          )}
        </div>

        {/* Save row */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            title={t('saveTooltip')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 text-xs"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? t('saving') : t('save')}
          </button>
          {isDirty && !saveError && (
            <span className="text-[11px] text-text-tertiary">{t('unsavedChanges')}</span>
          )}
          {saveError && <span className="text-[11px] text-destructive">{saveError}</span>}
        </div>
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

        {/* A workspace-less todo picks a target before spawning a session. */}
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
