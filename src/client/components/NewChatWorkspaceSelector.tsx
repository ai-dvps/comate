import { Check, ChevronDown, Folder, FolderPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace } from '../stores/workspace-store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

interface NewChatWorkspaceSelectorProps {
  workspaces: Workspace[]
  workspaceId: string
  onSelect: (workspaceId: string) => void
  onCreateWorkspace: () => void
}

export default function NewChatWorkspaceSelector({
  workspaces,
  workspaceId,
  onSelect,
  onCreateWorkspace,
}: NewChatWorkspaceSelectorProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('newChat.workspace')}
          title={t('newChat.workspace')}
          className="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-hover active:bg-surface-active"
        >
          <Folder className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="max-w-64 truncate">{selectedWorkspace?.name ?? t('newChat.workspace')}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="z-50 min-w-[220px] rounded-lg border border-border bg-surface-active p-1 shadow-lg"
      >
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
          {t('newChat.workspace')}
        </div>
        <div data-testid="new-chat-workspace-options" className="max-h-64 overflow-y-auto overscroll-contain">
          {workspaces.map((workspace) => {
            const isActive = workspace.id === workspaceId
            return (
              <button
                key={workspace.id}
                type="button"
                onClick={() => {
                  onSelect(workspace.id)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                  isActive
                    ? 'bg-surface-active text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <Folder className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                <Check className={`h-3.5 w-3.5 shrink-0 ${isActive ? '' : 'opacity-0'}`} aria-hidden="true" />
              </button>
            )
          })}
        </div>
        <div className="my-1 border-t border-border" />
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onCreateWorkspace()
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <FolderPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('newChat.createWorkspaceOption')}</span>
        </button>
      </PopoverContent>
    </Popover>
  )
}
