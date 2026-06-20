import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, LayoutGrid } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { useWorkspaceStore } from '../stores/workspace-store'

interface WorkspaceSwitcherProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export default function WorkspaceSwitcher({ open, onOpenChange }: WorkspaceSwitcherProps) {
  const { t } = useTranslation('settings')
  const [internalOpen, setInternalOpen] = useState(false)

  const isOpen = open ?? internalOpen
  const setIsOpen = onOpenChange ?? setInternalOpen

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const openWorkspaceIds = useWorkspaceStore((s) => s.openWorkspaceIds)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  const handleSelect = (id: string) => {
    openWorkspace(id)
    setIsOpen(false)
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title={t('workspaceSwitcher.switchWorkspace')}
        >
          <LayoutGrid className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="z-[60] w-64 bg-surface border border-border rounded-xl shadow-lg overflow-hidden p-0"
      >
        <div className="px-3 py-2 border-b border-border/50">
          <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide">
            {t('workspaceSwitcher.workspaces')}
          </span>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {workspaces.length === 0 ? (
            <div className="px-3 py-4 text-xs text-text-tertiary text-center">
              {t('workspaceSwitcher.noWorkspaces')}
            </div>
          ) : (
            workspaces.map((ws) => {
              const isOpenTab = openWorkspaceIds.includes(ws.id)
              const isActive = activeWorkspaceId === ws.id
              return (
                <button
                  key={ws.id}
                  onClick={() => handleSelect(ws.id)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-left transition-colors ${
                    isActive
                      ? 'bg-surface-active text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <span className="truncate flex-1">{ws.name}</span>
                  {isOpenTab && (
                    <Check
                      className={`w-3.5 h-3.5 flex-shrink-0 ${
                        isActive ? 'text-accent' : 'text-text-tertiary'
                      }`}
                    />
                  )}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
