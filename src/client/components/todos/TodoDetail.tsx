import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import type { Todo, TodoStatus } from '../../stores/todo-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { cn } from '../ui/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import ConflictReview from './ConflictReview'
import CodeMirrorEditor from '../CodeMirrorEditor'
import MarkdownPreview from '../MarkdownPreview'
import { getCodeMirrorLanguage } from '../../lib/codemirror-language'
import { EditorView } from '@codemirror/view'

interface TodoDetailProps {
  todo: Todo | null
  width: number
  onWidthChange: (width: number) => void
  onResolved: () => void
  onUpdateTodo: (todoId: string, patch: Partial<Todo>) => Promise<Todo | null>
  onChangeStatus: (todoId: string, status: TodoStatus) => Promise<void>
}

const MIN_WIDTH = 280
const MAX_WIDTH = 520
const SAVE_DEBOUNCE_MS = 800

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
  const [contentVisible, setContentVisible] = useState(false)

  // Animate content when the selected todo changes.
  useEffect(() => {
    setContentVisible(false)
    const id = window.setTimeout(() => setContentVisible(true), 25)
    return () => window.clearTimeout(id)
  }, [todo?.id])

  // Keep the local body draft in sync with the todo text.
  useEffect(() => {
    setBodyDraft(todo?.text ?? '')
  }, [todo?.text, todo?.id])

  const handleSpawn = async () => {
    if (!todo?.workspaceId) return
    setSpawning(true)
    try {
      const res = await fetch(`/api/todos/${todo.id}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: todo.workspaceId }),
      })
      if (res.ok) onResolved()
    } finally {
      setSpawning(false)
    }
  }

  const canSpawn = !!todo && todo.status === 'pending' && !todo.sessionId && !!todo.workspaceId

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
    void onUpdateTodo(todo.id, { workspaceId: workspaceId || null })
  }

  const handleStatusChange = (status: string) => {
    if (!todo) return
    void onChangeStatus(todo.id, status as TodoStatus)
  }

  const saveBody = useCallback(
    (next: string) => {
      if (!todo || next === todo.text) return
      void onUpdateTodo(todo.id, { text: next })
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

      <div
        className={cn(
          'flex flex-col min-h-0 flex-1 transition-all duration-200 ease-out',
          contentVisible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2',
        )}
      >
        <div className="px-4 py-3 border-b border-border/50 flex-shrink-0">
          <h2
            className={cn(
              'text-sm font-medium',
              todo.status === 'done' ? 'line-through text-text-tertiary' : 'text-text-primary',
            )}
          >
            {todo.text || t('noBody')}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          <dl className="flex flex-col gap-3 p-4 text-xs">
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
            <Field label={t('detailOrigin')} value={todo.origin === 'github' ? t('originGithub') : t('originLocal')} />
            <Field label={t('detailWorkspace')}>
              <Select value={todo.workspaceId ?? ''} onValueChange={handleWorkspaceChange}>
                <SelectTrigger className="w-full h-8 text-xs px-2.5" aria-label={t('detailWorkspace')}>
                  <SelectValue placeholder={t('noWorkspace')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t('noWorkspace')}</SelectItem>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('detailDue')} value={todo.dueDate ?? '—'} />
            {todo.repoFullName && <Field label={t('groupRepo')} value={`${todo.repoFullName}#${todo.issueNumber ?? ''}`} />}
            <Field label={t('detailSynced')} value={todo.lastSyncedAt ? t('detailSynced') : t('detailNotSynced')} />
          </dl>

          <div className="px-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-tertiary">{t('detailBody')}</span>
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
          </div>

          <div className="px-4 pb-4">
            <ConflictReview todoId={todo.id} onResolved={onResolved} />

            {/* U7 (R4): start a session from a todo. */}
            {todo.sessionId ? (
              <p className="text-[11px] text-text-tertiary">{t('detailHasSession')}</p>
            ) : (
              <button
                onClick={handleSpawn}
                disabled={!canSpawn || spawning}
                className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 text-xs"
              >
                <Play className="w-3.5 h-3.5" />
                {t('spawnSession')}
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

function Field({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-text-tertiary">{label}</dt>
      {children ?? <dd className="text-text-primary break-words">{value}</dd>}
    </div>
  )
}
