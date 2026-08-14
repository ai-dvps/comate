import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelRightClose } from 'lucide-react'
import BrowserBody from './BrowserBody'
import BrowserStateBar from './BrowserStateBar'
import { FOCUS_CLASSES } from './focus-classes'
import { cn } from '../ui/utils'
import { useTheme } from '../../hooks/use-theme'
import {
  getDetachedBrowserPlacement,
  markDetachedBrowserRendererReady,
  notifyDetachedBrowserSessionEnded,
  onDetachedBrowserPlacementChange,
  restoreDetachedBrowser,
} from '../../lib/detached-browser-api'
import type { DetachedBrowserPlacement } from '../../lib/desktop-api'
import {
  EMPTY_SESSION_BROWSER_STATE,
  useBrowserPaneStore,
} from '../../stores/browser-pane-store'

function samePlacement(
  left: DetachedBrowserPlacement | null,
  right: DetachedBrowserPlacement | null,
): boolean {
  return left?.workspaceId === right?.workspaceId
    && left?.sessionId === right?.sessionId
    && left?.title === right?.title
}

/** Minimal renderer used only by the independent OS browser window. */
export default function DetachedBrowserWindowApp() {
  const { t } = useTranslation('browser')
  useTheme()
  const [placement, setPlacement] = useState<DetachedBrowserPlacement | null>(null)
  const [hostReadySessionId, setHostReadySessionId] = useState<string | null>(null)
  const endedSessionRef = useRef<string | null>(null)
  const session = useBrowserPaneStore((state) =>
    placement ? state.sessions[placement.sessionId] ?? EMPTY_SESSION_BROWSER_STATE : EMPTY_SESSION_BROWSER_STATE,
  )

  const applyPlacement = useCallback((next: DetachedBrowserPlacement | null) => {
    setPlacement((current) => samePlacement(current, next) ? current : next)
  }, [])

  useEffect(() => {
    let disposed = false
    let placementEventReceived = false
    const unsubscribe = onDetachedBrowserPlacementChange((next) => {
      placementEventReceived = true
      if (!disposed) applyPlacement(next)
    })
    void getDetachedBrowserPlacement().then((snapshot) => {
      if (!disposed && !placementEventReceived) applyPlacement(snapshot)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [applyPlacement])

  useEffect(() => {
    if (!placement) {
      setHostReadySessionId(null)
      document.title = t('detached.title')
      return
    }

    document.title = placement.title
    endedSessionRef.current = null
    setHostReadySessionId(null)
    useBrowserPaneStore.getState().setActiveSession(placement.workspaceId, placement.sessionId)
    let disposed = false
    void markDetachedBrowserRendererReady(placement.sessionId).then((ready) => {
      if (!disposed && ready) setHostReadySessionId(placement.sessionId)
    })
    return () => {
      disposed = true
    }
  }, [placement, t])

  useEffect(() => () => {
    useBrowserPaneStore.getState().setActiveSession(null, null)
  }, [])

  useEffect(() => {
    if (
      !placement
      || !session.hydrated
      || session.controlState !== 'none'
      || endedSessionRef.current === placement.sessionId
    ) return
    endedSessionRef.current = placement.sessionId
    void notifyDetachedBrowserSessionEnded(placement.sessionId)
  }, [placement, session.controlState, session.hydrated])

  if (!placement) {
    return <div className="h-screen bg-bg" data-testid="detached-browser-empty" />
  }

  return (
    <main
      data-testid="detached-browser-window"
      aria-label={t('detached.title')}
      className="h-screen min-h-0 flex flex-col bg-bg text-text-primary"
    >
      <header className="h-10 flex-shrink-0 flex items-center gap-3 px-3 border-b border-border bg-chrome">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={placement.title}>
          {placement.title}
        </span>
        <button
          type="button"
          data-testid="detached-browser-restore"
          onClick={() => void restoreDetachedBrowser()}
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px]',
            'text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors',
            FOCUS_CLASSES,
          )}
        >
          <PanelRightClose className="w-3.5 h-3.5" aria-hidden="true" />
          {t('action.restoreToPanel')}
        </button>
      </header>
      <BrowserStateBar sessionId={placement.sessionId} />
      <div className="relative flex-1 min-h-0">
        {hostReadySessionId === placement.sessionId && (
          <BrowserBody
            workspaceId={placement.workspaceId}
            sessionId={placement.sessionId}
            viewerHere
          />
        )}
      </div>
    </main>
  )
}
