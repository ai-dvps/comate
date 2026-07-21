import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import BrowserStateBar from './BrowserStateBar'
import BrowserBody from './BrowserBody'
import { selectSessionOpen, useBrowserPaneStore } from '../../stores/browser-pane-store'
import { useChatStore } from '../../stores/chat-store'
import { cn } from '../ui/utils'

/**
 * BrowserPane — the chat-side collapsible, drag-resizable browser panel (R1).
 * The pane is deliberately independent of RightPanel (no ContentTab union
 * change); the header's browser button toggles it.
 *
 * Keep-alive (RightPanel.tsx:287-292 precedent): the root stays mounted for
 * the ChatPanel's lifetime and is CSS-hidden while collapsed, so the viewer
 * iframe is never unmounted — collapsing and reopening never reloads the
 * cast stream. The iframe's src only changes when the server hands a new
 * viewer URL (session switch / crash rebuild) or a manual retry bumps the
 * nonce.
 */

export interface BrowserPaneProps {
  workspaceId: string
}

export default function BrowserPane({ workspaceId }: BrowserPaneProps) {
  const { t } = useTranslation('browser')
  const sessionId = useChatStore((s) => s.activeSessionIds[workspaceId])
  const isOpen = useBrowserPaneStore((s) => selectSessionOpen(s, sessionId))
  const width = useBrowserPaneStore((s) => s.width)
  const hasOpened = useBrowserPaneStore((s) => s.hasOpened)
  const popoutOpen = useBrowserPaneStore((s) => s.popoutOpen)
  const setWidth = useBrowserPaneStore((s) => s.setWidth)
  const setPopoutOpen = useBrowserPaneStore((s) => s.setPopoutOpen)
  const recordActivity = useBrowserPaneStore((s) => s.recordActivity)

  // Drag the left edge: moving the pointer left widens the pane.
  const handleResizeStart = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = useBrowserPaneStore.getState().width
      const onMove = (ev: PointerEvent) => {
        setWidth(startWidth + (startX - ev.clientX))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    },
    [setWidth],
  )

  const handleActivity = useCallback(() => {
    if (sessionId) recordActivity(sessionId)
  }, [recordActivity, sessionId])

  if (!sessionId) return null

  return (
    <aside
      data-testid="browser-pane"
      aria-label={t('pane.title')}
      hidden={!isOpen}
      className={cn(
        'relative flex flex-col flex-shrink-0 h-full border-l border-border/50 bg-bg',
        isOpen ? 'flex' : 'hidden',
      )}
      style={isOpen ? { width } : undefined}
      onPointerDown={handleActivity}
    >
      <div
        data-testid="browser-pane-resize-handle"
        role="separator"
        aria-label={t('pane.resize')}
        aria-orientation="vertical"
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-accent/30 transition-colors"
        onPointerDown={handleResizeStart}
      />
      <BrowserStateBar sessionId={sessionId} onPopout={() => setPopoutOpen(true)} />
      <div className="flex-1 min-h-0 relative">
        {/* The iframe mounts only after the first open — a never-opened pane
            must not spawn a cast stream in the background. */}
        {hasOpened ? (
          <BrowserBody workspaceId={workspaceId} sessionId={sessionId} viewerHere={!popoutOpen} />
        ) : (
          <div data-testid="browser-pane-dormant" className="h-full" />
        )}
      </div>
    </aside>
  )
}
