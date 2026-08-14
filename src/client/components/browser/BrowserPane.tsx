import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import BrowserStateBar from './BrowserStateBar'
import BrowserBody from './BrowserBody'
import { useBrowserPaneStore } from '../../stores/browser-pane-store'
import { useChatStore } from '../../stores/chat-store'
import BrowserDetachedPlaceholder from './BrowserDetachedPlaceholder'
import {
  detachBrowserWindow,
  focusDetachedBrowserWindow,
  restoreDetachedBrowser,
} from '../../lib/detached-browser-api'

/**
 * BrowserPane — the browser viewer content rendered inside RightPanel.
 *
 * The parent (RightPanel) controls sizing and visibility. This component
 * only renders the state bar and viewer body, filling its container.
 *
 * Keep-alive: RightPanel renders BrowserPane instances for all open workspaces
 * and only shows the active one, so the native view surface is never
 * unmounted on workspace switches or panel collapse/expand.
 */

export interface BrowserPaneProps {
  workspaceId: string
  /**
   * U8: false while this pane is keep-alive mounted but off screen (another
   * workspace's surface or another right-panel tab is showing). The native
   * view must stop reporting its rect then.
   */
  surfaceVisible?: boolean
}

export default function BrowserPane({ workspaceId, surfaceVisible = true }: BrowserPaneProps) {
  const { t } = useTranslation('browser')
  const sessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const hasOpened = useBrowserPaneStore((s) => s.hasOpened)
  const detachedPlacement = useBrowserPaneStore((s) => s.detachedPlacement)
  const recordActivity = useBrowserPaneStore((s) => s.recordActivity)
  const sessionTitle = useChatStore((s) =>
    s.sessions[workspaceId]?.find((session) => session.id === sessionId)?.name,
  )
  const focusAfterRestoreRef = useRef(false)
  const isDetached = detachedPlacement?.workspaceId === workspaceId
    && detachedPlacement.sessionId === sessionId

  const handleActivity = useCallback(() => {
    if (sessionId) recordActivity(sessionId)
  }, [recordActivity, sessionId])

  const handleDetach = useCallback(() => {
    if (!sessionId) return
    void detachBrowserWindow({
      workspaceId,
      sessionId,
      title: sessionTitle?.trim() || t('pane.untitledSession'),
    })
  }, [sessionId, sessionTitle, t, workspaceId])

  const handleRestore = useCallback(() => {
    focusAfterRestoreRef.current = true
    void restoreDetachedBrowser()
  }, [])

  if (!sessionId) return null

  return (
    <div
      data-testid="browser-pane"
      aria-label={t('pane.title')}
      className="relative flex flex-col flex-1 h-full min-w-0 bg-bg"
      onPointerDown={handleActivity}
    >
      <BrowserStateBar sessionId={sessionId} onDetach={isDetached ? undefined : handleDetach} />
      <div className="flex-1 min-h-0 relative">
        {isDetached && detachedPlacement ? (
          <BrowserDetachedPlaceholder
            title={detachedPlacement.title}
            onFocus={() => void focusDetachedBrowserWindow()}
            onRestore={handleRestore}
          />
        ) : hasOpened ? (
          <BrowserBody
            workspaceId={workspaceId}
            sessionId={sessionId}
            surfaceVisible={surfaceVisible}
            focusOnMount={focusAfterRestoreRef.current}
          />
        ) : (
          <div data-testid="browser-pane-dormant" className="h-full" />
        )}
      </div>
    </div>
  )
}
