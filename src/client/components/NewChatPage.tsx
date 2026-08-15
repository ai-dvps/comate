import { useMemo, useState } from 'react'
import { FolderPlus, MessageSquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BackendId } from '../stores/backend-store'
import type { ApprovalMode } from '../stores/chat-store'
import type { Workspace } from '../stores/workspace-store'
import PromptInput from './PromptInput'
import NewChatWorkspaceSelector from './NewChatWorkspaceSelector'
import { chooseDefaultNewChatWorkspace } from './new-chat-workspace'

interface NewChatPageProps {
  workspaces: Workspace[]
  defaultWorkspaceId?: string | null
  selectedWorkspaceId?: string | null
  onWorkspaceChange: (workspaceId: string) => void
  onCreateWorkspace: () => void
  onSubmit: (
    workspaceId: string,
    prompt: string,
    options: {
      backend?: BackendId
      providerId?: string
      fastMode: boolean
      approvalMode: ApprovalMode
    },
  ) => Promise<void>
  isSubmitting?: boolean
  error?: string | null
}

interface NewChatComposerOptions {
  backendId: BackendId | null
  providerId: string | null
  fastMode: boolean
  approvalMode: ApprovalMode
}

const DEFAULT_COMPOSER_OPTIONS: NewChatComposerOptions = {
  backendId: null,
  providerId: null,
  fastMode: false,
  approvalMode: 'manual',
}

export default function NewChatPage({
  workspaces,
  defaultWorkspaceId,
  selectedWorkspaceId,
  onWorkspaceChange,
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
  const workspaceId = selectedWorkspaceId && workspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ? selectedWorkspaceId
    : resolvedDefault ?? ''
  const [optionsByWorkspace, setOptionsByWorkspace] = useState<Record<string, NewChatComposerOptions>>({})
  const composerOptions = optionsByWorkspace[workspaceId] ?? DEFAULT_COMPOSER_OPTIONS
  const updateComposerOptions = (patch: Partial<NewChatComposerOptions>) => {
    setOptionsByWorkspace((current) => ({
      ...current,
      [workspaceId]: {
        ...(current[workspaceId] ?? DEFAULT_COMPOSER_OPTIONS),
        ...patch,
      },
    }))
  }

  if (workspaces.length === 0) {
    return (
      <main className="flex h-full w-full items-center justify-center bg-work px-6" data-testid="new-chat-workspace-gate">
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
    <main className="flex h-full w-full flex-col items-center bg-work px-6 pb-6 pt-10" data-testid="new-chat-page">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-surface shadow-sm">
            <MessageSquarePlus className="h-5 w-5 text-accent" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">{t('newChat.title')}</h1>
          <p className="mt-1.5 text-sm text-text-secondary">{t('newChat.description')}</p>
        </div>
      </div>

      <div data-testid="new-chat-composer-dock" className="w-full max-w-3xl shrink-0">
        {error ? (
          <div className="mb-3 px-4">
            <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          </div>
        ) : null}

        <div
          data-testid="new-chat-composer"
          className="relative"
        >
          <div
            data-testid="new-chat-workspace-context"
            className="mx-6 flex min-h-12 items-center rounded-t-2xl border border-b-0 border-border bg-surface px-3 pb-3 pt-2"
          >
            <NewChatWorkspaceSelector
              workspaces={workspaces}
              workspaceId={workspaceId}
              onSelect={onWorkspaceChange}
              onCreateWorkspace={onCreateWorkspace}
            />
          </div>

          <div className="relative z-10 -mt-2 overflow-hidden rounded-2xl border border-border bg-work shadow-[0_12px_40px_rgba(0,0,0,0.12)] transition-colors focus-within:border-border-hover">
            <PromptInput
              workspaceId={workspaceId}
              mode="new-chat"
              backendId={composerOptions.backendId}
              onBackendChange={(backendId) => updateComposerOptions({ backendId })}
              providerId={composerOptions.providerId}
              onProviderChange={(providerId) => updateComposerOptions({ providerId })}
              fastMode={composerOptions.fastMode}
              onFastModeChange={(fastMode) => updateComposerOptions({ fastMode })}
              approvalMode={composerOptions.approvalMode}
              onApprovalModeChange={(approvalMode) => updateComposerOptions({ approvalMode })}
              onSend={(content) => {
                if (!workspaceId || isSubmitting) return
                void onSubmit(workspaceId, content, {
                  backend: composerOptions.backendId ?? undefined,
                  providerId: composerOptions.providerId ?? undefined,
                  fastMode: composerOptions.fastMode,
                  approvalMode: composerOptions.approvalMode,
                })
              }}
              disabled={isSubmitting}
            />
          </div>
        </div>
      </div>
    </main>
  )
}
