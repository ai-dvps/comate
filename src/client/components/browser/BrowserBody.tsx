import { useTranslation } from 'react-i18next'
import { Globe, XCircle } from 'lucide-react'
import BrowserViewer from './BrowserViewer'
import {
  BROWSER_START_PHASE_PERCENT,
  EMPTY_SESSION_BROWSER_STATE,
  selectBrowserStartPhase,
  selectHasInFlightBrowserTool,
  useBrowserPaneStore,
} from '../../stores/browser-pane-store'
import { useChatStore } from '../../stores/chat-store'
import { cn } from '../ui/utils'
import { FOCUS_CLASSES } from './focus-classes'

/**
 * BrowserBody — the pane/popout body derivation shared by both surfaces:
 *
 *   session_lost           → crash copy (manual retry lives in the state bar)
 *   viewerUrl + viewerHere → the keep-alive viewer iframe
 *   viewerUrl + !viewerHere→ placeholder (the view lives in the other surface)
 *   startPhase             → F5 determinate progress (percent + cancel)
 *   otherwise              → the pure explanatory empty state (no primary CTA)
 */

export interface BrowserBodyProps {
  workspaceId: string
  sessionId: string
  /** False while the other surface (popout) hosts the viewer. */
  viewerHere: boolean
}

const EMPTY_SESSION = EMPTY_SESSION_BROWSER_STATE

export default function BrowserBody({ workspaceId, sessionId, viewerHere }: BrowserBodyProps) {
  const { t } = useTranslation('browser')
  const session = useBrowserPaneStore((s) => s.sessions[sessionId] ?? EMPTY_SESSION)
  const hasInFlightBrowserTool = useChatStore((s) =>
    selectHasInFlightBrowserTool(s, sessionId),
  )
  const interruptSession = useChatStore((s) => s.interruptSession)

  if (session.controlState === 'session_lost') {
    return (
      <div
        data-testid="browser-session-lost"
        className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center"
      >
        <XCircle className="w-8 h-8 text-destructive" aria-hidden="true" />
        <p className="text-sm font-medium text-text-primary">{t('state.sessionLost')}</p>
        <p className="text-xs text-text-secondary">{t('state.sessionLostDetail')}</p>
      </div>
    )
  }

  if (session.viewerUrl) {
    if (!viewerHere) {
      return (
        <div
          data-testid="browser-popout-placeholder"
          className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center"
        >
          <Globe className="w-8 h-8 text-text-tertiary" aria-hidden="true" />
          <p className="text-xs text-text-secondary">{t('pane.popoutPlaceholder')}</p>
        </div>
      )
    }
    return (
      <BrowserViewer
        sessionId={sessionId}
        viewerUrl={session.viewerUrl}
        viewerNonce={session.viewerNonce}
        controlState={session.controlState}
      />
    )
  }

  const startPhase = selectBrowserStartPhase(session, hasInFlightBrowserTool)
  if (startPhase) {
    const percent = BROWSER_START_PHASE_PERCENT[startPhase]
    return (
      <div
        data-testid="browser-start-progress"
        className="flex flex-col items-center justify-center h-full gap-4 px-8"
      >
        <p className="text-sm font-medium text-text-primary" data-testid="browser-start-phase">
          {startPhase === 'preparing' ? t('state.preparing') : t('state.starting')}
        </p>
        <div
          className="w-full max-w-xs h-1.5 rounded-full bg-surface-hover overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            data-testid="browser-start-bar"
            className="h-full bg-accent transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-xs text-text-tertiary" data-testid="browser-start-percent">
          {percent}%
        </p>
        <p className="text-[11px] text-text-secondary text-center">{t('state.firstUseHint')}</p>
        <button
          type="button"
          data-testid="browser-start-cancel"
          onClick={() => void interruptSession(workspaceId, sessionId)}
          className={cn(
            'px-3 py-1.5 rounded-md text-xs font-medium border border-border',
            'text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors',
            FOCUS_CLASSES,
          )}
        >
          {t('action.cancel')}
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="browser-empty-state"
      className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center"
    >
      <Globe className="w-8 h-8 text-text-tertiary" aria-hidden="true" />
      <p className="text-sm font-medium text-text-primary">{t('pane.emptyTitle')}</p>
      <p className="text-xs text-text-secondary">{t('pane.emptyDetail')}</p>
    </div>
  )
}
