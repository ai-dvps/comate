import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import {
  selectHandoffPending,
  selectSessionOpen,
  useBrowserPaneStore,
} from '../../stores/browser-pane-store'
import { useChatStore } from '../../stores/chat-store'
import { cn } from '../ui/utils'
import { FOCUS_CLASSES } from './focus-classes'

/**
 * BrowserPaneButton — the chat header's browser toggle (R1). Shows the
 * handoff badge (R5): a handoff from the agent lights the dot and the store
 * has already auto-expanded the pane.
 */

export interface BrowserPaneButtonProps {
  workspaceId: string
}

export default function BrowserPaneButton({ workspaceId }: BrowserPaneButtonProps) {
  const { t } = useTranslation('browser')
  const sessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isOpen = useBrowserPaneStore((s) => selectSessionOpen(s, sessionId))
  const togglePane = useBrowserPaneStore((s) => s.togglePane)
  const handoffPending = useBrowserPaneStore((s) => selectHandoffPending(s, sessionId))

  return (
    <button
      type="button"
      data-testid="browser-pane-button"
      aria-label={isOpen ? t('pane.collapse') : t('pane.expand')}
      aria-pressed={isOpen}
      onClick={() => {
        if (sessionId) togglePane(sessionId)
      }}
      className={cn(
        'relative p-1.5 rounded-md transition-colors',
        FOCUS_CLASSES,
        isOpen
          ? 'text-text-primary bg-surface-hover'
          : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover',
      )}
    >
      <Globe className="w-4 h-4" aria-hidden="true" />
      {handoffPending && (
        <span
          data-testid="browser-pane-badge"
          aria-label={t('pane.needsYou')}
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-warning border border-bg animate-pulse"
        />
      )}
    </button>
  )
}
