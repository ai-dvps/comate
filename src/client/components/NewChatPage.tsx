import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, ChevronDown, FolderPlus, MessageSquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Workspace } from '../stores/workspace-store'
import { CREATE_WORKSPACE_VALUE, chooseDefaultNewChatWorkspace } from './new-chat-workspace'

interface NewChatPageProps {
  workspaces: Workspace[]
  defaultWorkspaceId?: string | null
  selectedWorkspaceId?: string | null
  onCreateWorkspace: () => void
  onSubmit: (workspaceId: string, prompt: string) => Promise<void>
  isSubmitting?: boolean
  error?: string | null
}

export default function NewChatPage({
  workspaces,
  defaultWorkspaceId,
  selectedWorkspaceId,
  onCreateWorkspace,
  onSubmit,
  isSubmitting = false,
  error,
}: NewChatPageProps) {
  const { t } = useTranslation('common')
  const resolvedDefault = useMemo(
    () => chooseDefaultNewChatWorkspace(workspaces, defaultWorkspaceId),
    [defaultWorkspaceId, workspaces],
  )
  const [workspaceId, setWorkspaceId] = useState(resolvedDefault ?? '')
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (!workspaceId || !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceId(resolvedDefault ?? '')
    }
  }, [resolvedDefault, workspaceId, workspaces])

  useEffect(() => {
    if (selectedWorkspaceId && workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setWorkspaceId(selectedWorkspaceId)
    }
  }, [selectedWorkspaceId, workspaces])

  const submit = async () => {
    const content = prompt.trim()
    if (!workspaceId || !content || isSubmitting) return
    await onSubmit(workspaceId, content)
  }

  if (workspaces.length === 0) {
    return (
      <main className="flex h-full items-center justify-center bg-work px-6" data-testid="new-chat-workspace-gate">
        <div className="flex max-w-sm flex-col items-center text-center">
          <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface shadow-sm">
            <FolderPlus className="h-5 w-5 text-accent" aria-hidden="true" />
          </span>
          <h1 className="text-lg font-semibold text-text-primary">{t('newChat.workspaceGateTitle')}</h1>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{t('newChat.workspaceGateDescription')}</p>
          <button
            type="button"
            onClick={onCreateWorkspace}
            className="mt-6 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-work"
          >
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
            {t('newChat.createWorkspace')}
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="flex h-full items-center justify-center bg-work px-6 py-10" data-testid="new-chat-page">
      <div className="w-full max-w-2xl -translate-y-[6vh]">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-surface shadow-sm">
            <MessageSquarePlus className="h-5 w-5 text-accent" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">{t('newChat.title')}</h1>
          <p className="mt-1.5 text-sm text-text-secondary">{t('newChat.description')}</p>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.12)] focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/20">
          <div className="flex items-center border-b border-border/70 px-4 py-2.5">
            <span className="mr-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
              {t('newChat.workspace')}
            </span>
            <div className="relative min-w-0 flex-1">
              <select
                aria-label={t('newChat.workspace')}
                value={workspaceId}
                onChange={(event) => {
                  if (event.target.value === CREATE_WORKSPACE_VALUE) {
                    onCreateWorkspace()
                    return
                  }
                  setWorkspaceId(event.target.value)
                }}
                className="h-7 w-full appearance-none truncate rounded-md bg-transparent pl-2 pr-7 text-xs font-medium text-text-primary outline-none hover:bg-surface-hover focus:bg-surface-hover"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
                <option value={CREATE_WORKSPACE_VALUE}>{t('newChat.createWorkspaceOption')}</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" aria-hidden="true" />
            </div>
          </div>

          <textarea
            autoFocus
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={t('newChat.promptPlaceholder')}
            className="min-h-32 w-full resize-none bg-transparent px-5 py-4 text-sm leading-6 text-text-primary outline-none placeholder:text-text-tertiary"
          />

          {error ? (
            <div role="alert" className="mx-4 mb-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-between px-4 pb-3">
            <span className="text-[11px] text-text-tertiary">{t('newChat.submitHint')}</span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!workspaceId || !prompt.trim() || isSubmitting}
              aria-label={t('newChat.startChat')}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
