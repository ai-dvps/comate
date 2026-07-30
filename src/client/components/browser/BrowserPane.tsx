import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import BrowserStateBar from './BrowserStateBar'
import BrowserBody from './BrowserBody'
import { useBrowserPaneStore } from '../../stores/browser-pane-store'
import { useChatStore } from '../../stores/chat-store'

/**
 * BrowserPane — the browser viewer content rendered inside RightPanel.
 *
 * The parent (RightPanel) controls sizing and visibility. This component
 * only renders the state bar and viewer body, filling its container.
 *
 * Keep-alive: RightPanel renders BrowserPane instances for all open workspaces
 * and only shows the active one, so the iframe is never unmounted on workspace
 * switches or panel collapse/expand.
 */

export interface BrowserPaneProps {
  workspaceId: string
}

export default function BrowserPane({ workspaceId }: BrowserPaneProps) {
  const { t } = useTranslation('browser')
  const sessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const hasOpened = useBrowserPaneStore((s) => s.hasOpened)
  const popoutOpen = useBrowserPaneStore((s) => s.popoutOpen)
  const setPopoutOpen = useBrowserPaneStore((s) => s.setPopoutOpen)
  const recordActivity = useBrowserPaneStore((s) => s.recordActivity)

  const handleActivity = useCallback(() => {
    if (sessionId) recordActivity(sessionId)
  }, [recordActivity, sessionId])

  if (!sessionId) return null

  return (
    <div
      data-testid="browser-pane"
      aria-label={t('pane.title')}
      className="relative flex flex-col flex-1 h-full min-w-0 bg-bg"
      onPointerDown={handleActivity}
    >
      <BrowserStateBar sessionId={sessionId} onPopout={() => setPopoutOpen(true)} />
      <div className="flex-1 min-h-0 relative">
        {hasOpened ? (
          <BrowserBody workspaceId={workspaceId} sessionId={sessionId} viewerHere={!popoutOpen} />
        ) : (
          <div data-testid="browser-pane-dormant" className="h-full" />
        )}
      </div>
    </div>
  )
}
