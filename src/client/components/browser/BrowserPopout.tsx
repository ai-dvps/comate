import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import BrowserStateBar from './BrowserStateBar'
import BrowserBody from './BrowserBody'
import { useBrowserPaneStore } from '../../stores/browser-pane-store'
import { cn } from '../ui/utils'
import { FOCUS_CLASSES } from './focus-classes'

/**
 * BrowserPopout — the in-app floating window (PiP-style overlay; never an OS
 * window). It mirrors the pane's state machine: the state bar here drives the
 * same store, and the viewer iframe lives in exactly one surface at a time —
 * opening the popout moves the viewer here (the pane shows a placeholder) and
 * closing returns it ("关闭即回面板"). The popout follows the active session
 * (App renders it against the store's active pointers).
 *
 * A11y: focus is trapped while open, Esc closes, and focus returns to the
 * element that opened the popout.
 */

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], iframe, [tabindex]:not([tabindex="-1"])'

export default function BrowserPopout() {
  const { t } = useTranslation('browser')
  const popoutOpen = useBrowserPaneStore((s) => s.popoutOpen)
  const sessionId = useBrowserPaneStore((s) => s.activeSessionId)
  const workspaceId = useBrowserPaneStore((s) => s.activeWorkspaceId)
  const setPopoutOpen = useBrowserPaneStore((s) => s.setPopoutOpen)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    setPopoutOpen(false)
  }, [setPopoutOpen])

  // Focus trap + initial focus + restore on close.
  useEffect(() => {
    if (!popoutOpen) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    const root = rootRef.current
    root?.focus()
    return () => {
      restoreFocusRef.current?.focus?.()
      restoreFocusRef.current = null
    }
  }, [popoutOpen])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const root = rootRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el.tagName === 'IFRAME')
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    },
    [close],
  )

  if (!popoutOpen || !sessionId || !workspaceId) return null

  return (
    <div
      ref={rootRef}
      data-testid="browser-popout"
      role="dialog"
      aria-modal="false"
      aria-label={t('popout.title')}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'fixed bottom-4 right-4 z-40 flex flex-col overflow-hidden',
        'w-[560px] max-w-[90vw] h-[380px] max-h-[80vh]',
        'rounded-xl border border-border bg-bg shadow-2xl outline-none',
      )}
    >
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border/50 flex-shrink-0">
        <span className="text-xs font-medium text-text-primary truncate flex-1">
          {t('popout.title')}
        </span>
        <button
          type="button"
          data-testid="browser-popout-close"
          onClick={close}
          aria-label={t('action.closePopout')}
          className={cn(
            'p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors',
            FOCUS_CLASSES,
          )}
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
      <BrowserStateBar sessionId={sessionId} />
      <div className="flex-1 min-h-0 relative">
        <BrowserBody workspaceId={workspaceId} sessionId={sessionId} viewerHere />
      </div>
    </div>
  )
}
