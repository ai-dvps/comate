import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MousePointerClick } from 'lucide-react'
import { cn } from '../ui/utils'
import {
  useBrowserPaneStore,
  type BrowserPaneControlState,
} from '../../stores/browser-pane-store'
import {
  onBrowserViewEscape,
  reportBrowserViewRect,
  setBrowserViewInputMode,
} from '../../lib/browser-view-bridge'

/**
 * BrowserViewer — the keep-alive viewer iframe plus the local input-capture
 * shield (R4): while the agent drives, a passive shield makes the view
 * read-only; in user_in_control an explicit click lifts the shield (capture),
 * and Esc (while the pane chrome holds focus) or any window blur re-arms it
 * (release). Capture is a LOCAL pointer concern only — the server-side
 * control state never changes here, and no keystroke ever leaves the viewer
 * iframe (KTD-6: activity pings stay content-free).
 */

export interface BrowserViewerProps {
  sessionId: string
  viewerUrl: string
  viewerNonce: number
  controlState: BrowserPaneControlState
}

export default function BrowserViewer({
  sessionId,
  viewerUrl,
  viewerNonce,
  controlState,
}: BrowserViewerProps) {
  const { t } = useTranslation('browser')
  const recordActivity = useBrowserPaneStore((s) => s.recordActivity)
  const [capturing, setCapturing] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const userDriving = controlState === 'user_in_control'

  const releaseCapture = useCallback(() => {
    setCapturing((was) => {
      if (was) setAnnouncement(t('action.captureReleased'))
      return false
    })
  }, [t])

  // Release capture whenever the window (or the surface) loses focus, and any
  // time the control state leaves user_in_control (handback, crash, …).
  useEffect(() => {
    if (!capturing) return
    if (!userDriving) {
      setCapturing(false)
      return
    }
    window.addEventListener('blur', releaseCapture)
    return () => window.removeEventListener('blur', releaseCapture)
  }, [capturing, userDriving, releaseCapture])

  useEffect(() => {
    if (!userDriving) setCapturing(false)
  }, [userDriving])

  const handleCapture = useCallback(() => {
    setCapturing(true)
    // Move focus into the viewer so keystrokes reach the page.
    iframeRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && capturing) {
        event.preventDefault()
        event.stopPropagation()
        releaseCapture()
        // Return focus to the pane chrome so the next Esc/Tab lands somewhere
        // sensible and the release is keyboard-observable.
        rootRef.current?.focus()
      }
    },
    [capturing, releaseCapture],
  )

  const handleActivity = useCallback(() => {
    recordActivity(sessionId)
  }, [recordActivity, sessionId])

  const shieldActive = !userDriving || !capturing

  return (
    <div
      ref={rootRef}
      data-testid="browser-viewer"
      className="relative h-full w-full outline-none"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onPointerDown={handleActivity}
    >
      <iframe
        // viewerNonce bumps on manual retry: a fresh element forces a reload.
        key={viewerNonce}
        ref={iframeRef}
        src={viewerUrl}
        title={t('a11y.viewerFrame')}
        className="h-full w-full border-0 bg-black"
      />
      {shieldActive && (
        userDriving ? (
          <button
            type="button"
            data-testid="browser-capture-shield"
            onClick={handleCapture}
            className={cn(
              'absolute inset-0 flex items-center justify-center gap-2 bg-bg/40',
              'text-xs text-text-secondary hover:text-text-primary hover:bg-bg/30 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            )}
            aria-label={t('action.clickToDrive')}
          >
            <MousePointerClick className="w-4 h-4" aria-hidden="true" />
            <span>{t('action.clickToDrive')}</span>
          </button>
        ) : (
          // Read-only shield: the agent (or a dead session) drives — pointer
          // events never reach the viewer (R4).
          <div
            data-testid="browser-readonly-shield"
            className="absolute inset-0 cursor-not-allowed"
            aria-hidden="true"
          />
        )
      )}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}

/**
 * NativeBrowserView — the U8 native-stack viewer surface. The actual page
 * lives in a shell-side WebContentsView layered OVER the UI view at the rect
 * this component reports; React renders only the backdrop (which is what
 * shows through while the shell hides the view during modal occlusion).
 *
 * Contract mapping from the iframe viewer above:
 *  - rect reporting: ResizeObserver + window resize, rAF-throttled; null on
 *    unmount / zero area / hidden surface → the shell hides the view;
 *  - input gating: user_in_control → `user` mode (input reaches the page),
 *    everything else → `agent` mode (the shell drops pointer + keyboard);
 *  - Esc: intercepted shell-side on a user-driven view; the notification here
 *    returns focus to the panel frame and announces the release (the iframe
 *    stack's release-capture parity);
 *  - activity: input that reaches the page is forwarded by the shell; clicks
 *    that land here (agent mode — the view ignores them) ping like before.
 */
export interface NativeBrowserViewProps {
  sessionId: string
  controlState: BrowserPaneControlState
  /** False while this surface is kept alive but not on screen (workspace/tab switch). */
  surfaceVisible: boolean
}

export function NativeBrowserView({ sessionId, controlState, surfaceVisible }: NativeBrowserViewProps) {
  const { t } = useTranslation('browser')
  const recordActivity = useBrowserPaneStore((s) => s.recordActivity)
  const [announcement, setAnnouncement] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  // KTD-14 input gating: the control state maps 1:1 onto the shell's mode.
  useEffect(() => {
    setBrowserViewInputMode(sessionId, controlState === 'user_in_control' ? 'user' : 'agent')
  }, [sessionId, controlState])

  // Rect reporting: the shell attaches/resizes the view to follow this box.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let raf = 0
    const report = () => {
      raf = 0
      if (!surfaceVisible) {
        reportBrowserViewRect(sessionId, null)
        return
      }
      const rect = el.getBoundingClientRect()
      reportBrowserViewRect(
        sessionId,
        rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null,
      )
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(report)
    }
    report()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(el)
    }
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
      reportBrowserViewRect(sessionId, null)
    }
  }, [sessionId, surfaceVisible])

  // Esc on a user-driven view returns focus to the panel frame (the shell
  // moved real focus back to the UI view; we land it on this surface).
  useEffect(
    () =>
      onBrowserViewEscape((escapedSessionId) => {
        if (escapedSessionId !== sessionId) return
        setAnnouncement(t('action.captureReleased'))
        rootRef.current?.focus()
      }),
    [sessionId, t],
  )

  return (
    <div
      ref={rootRef}
      data-testid="browser-viewer-native"
      className="relative h-full w-full outline-none bg-black"
      tabIndex={-1}
      aria-label={t('a11y.viewerFrame')}
      onPointerDown={() => recordActivity(sessionId)}
    >
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}
