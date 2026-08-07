import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
 * NativeBrowserView — the native-stack viewer surface (U8; the only viewer
 * surface since U9 removed the iframe stack with the legacy browser runtime).
 * The actual page lives in a shell-side WebContentsView layered OVER the UI
 * view at the rect this component reports; React renders only the backdrop
 * (which is what shows through while the shell hides the view during modal
 * occlusion).
 *
 * Contract:
 *  - rect reporting: ResizeObserver + window resize, rAF-throttled; null on
 *    unmount / zero area / hidden surface → the shell hides the view;
 *  - input gating: user_in_control → `user` mode (input reaches the page),
 *    everything else → `agent` mode (the shell drops pointer + keyboard);
 *  - Esc: intercepted shell-side on a user-driven view; the notification here
 *    returns focus to the panel frame and announces the release;
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
