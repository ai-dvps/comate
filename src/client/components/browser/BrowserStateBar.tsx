import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ExternalLink,
  Hand,
  Loader2,
  Play,
  RefreshCw,
} from 'lucide-react'
import { cn } from '../ui/utils'
import {
  initialSessionBrowserState,
  useBrowserPaneStore,
} from '../../stores/browser-pane-store'

/**
 * BrowserStateBar — the persistent control-state strip (R3). Renders the five
 * U6 states from the browser_state channel plus the local busy window:
 *
 *   agent_in_control  → "Claude is driving"   + [Take over]
 *   handoff_pending   → "asking you to take over" + [Take over] / [Continue=decline]
 *   user_in_control   → "You are driving"     + [Continue]
 *   (pendingVerb)     → transitioning — controls disabled (the flip lands when
 *                       the agent's in-progress action completes)
 *   session_lost      → crash copy            + [Retry] (next tool call also
 *                       rebuilds automatically)
 *
 * The same component backs the pane and the popout — both entries drive the
 * one store state machine. State migrations are announced via aria-live.
 */

export interface BrowserStateBarProps {
  sessionId: string
  /** When provided, the popout button is shown (pane entry only). */
  onPopout?: () => void
}

const FOCUS_CLASSES =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** Stable default for sessions with no state yet (selector identity). */
const EMPTY_SESSION = initialSessionBrowserState()

export default function BrowserStateBar({ sessionId, onPopout }: BrowserStateBarProps) {
  const { t } = useTranslation('browser')
  const session = useBrowserPaneStore((s) => s.sessions[sessionId] ?? EMPTY_SESSION)
  const takeover = useBrowserPaneStore((s) => s.takeover)
  const handback = useBrowserPaneStore((s) => s.handback)
  const setRememberSite = useBrowserPaneStore((s) => s.setRememberSite)
  const retryViewer = useBrowserPaneStore((s) => s.retryViewer)
  const retryUnavailable = useBrowserPaneStore((s) => s.retryUnavailable)

  const busy = session.pendingVerb !== null
  const state = session.controlState

  let stateLabel = t('pane.emptyTitle')
  let stateHint = ''
  let dotClass = 'bg-text-tertiary'
  if (busy) {
    stateLabel = t('state.transitioning')
    dotClass = 'bg-accent animate-pulse'
  } else if (state === 'agent_in_control') {
    stateLabel = t('state.agentDriving')
    stateHint = t('state.agentDrivingHint')
    dotClass = 'bg-accent'
  } else if (state === 'handoff_pending') {
    stateLabel = t('state.handoffPending')
    stateHint = t('state.handoffPendingHint')
    dotClass = 'bg-warning animate-pulse'
  } else if (state === 'user_in_control') {
    stateLabel = t('state.userDriving')
    stateHint = t('state.userDrivingHint')
    dotClass = 'bg-success'
  } else if (state === 'session_lost') {
    stateLabel = t('state.sessionLost')
    dotClass = 'bg-destructive'
  }

  const showTakeover = !busy && (state === 'agent_in_control' || state === 'handoff_pending')
  const showContinue = !busy && (state === 'user_in_control' || state === 'handoff_pending')
  const showRetry = !busy && state === 'session_lost'
  // "记住此站点" (U8): only while the user is actually driving — the
  // handoff_pending "continue" means DECLINE, so no export rides it. The
  // F3 proactive takeover has no handoff card, which is exactly why the
  // checkbox lives here on the state bar instead of on a card.
  const showRememberSite = !busy && state === 'user_in_control'

  return (
    <div data-testid="browser-state-bar" className="flex-shrink-0">
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-testid="browser-state-live">
        {t('a11y.stateAnnouncement', { state: stateLabel })}
      </span>

      {session.unavailable && (
        <div
          data-testid="browser-unavailable-banner"
          className="px-3 py-1.5 text-xs bg-warning/10 text-warning flex items-center gap-1.5"
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="truncate flex-1" title={session.unavailable.reason}>
            {t('state.unavailable')}
            {session.unavailable.reason ? `: ${session.unavailable.reason}` : ''}
          </span>
          <button
            type="button"
            data-testid="browser-unavailable-retry"
            onClick={() => void retryUnavailable(sessionId)}
            className={cn(
              'ml-1 px-2 py-0.5 rounded text-[11px] font-medium bg-warning/20 hover:bg-warning/30 transition-colors',
              FOCUS_CLASSES,
            )}
          >
            {t('action.retry')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 px-3 h-9 border-b border-border/50">
        <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotClass)} aria-hidden="true" />
        <span
          data-testid="browser-state-label"
          className="text-xs font-medium text-text-primary truncate"
        >
          {stateLabel}
        </span>
        {stateHint && !busy && (
          <span className="text-[11px] text-text-tertiary truncate hidden xl:inline">
            {stateHint}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          {busy && (
            <button
              type="button"
              disabled
              data-testid="browser-busy-button"
              aria-disabled="true"
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
                'bg-accent/40 text-white/60 cursor-not-allowed',
                FOCUS_CLASSES,
              )}
            >
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
              {session.pendingVerb === 'takeover' ? t('action.takeover') : t('action.continue')}
            </button>
          )}

          {showTakeover && (
            <button
              type="button"
              data-testid="browser-takeover-button"
              onClick={() => void takeover(sessionId)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
                'bg-accent text-white hover:bg-accent/90 transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <Hand className="w-3 h-3" aria-hidden="true" />
              {t('action.takeover')}
            </button>
          )}

          {showContinue && (
            <button
              type="button"
              data-testid="browser-handback-button"
              onClick={() => void handback(sessionId)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
                state === 'handoff_pending'
                  ? 'border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                  : 'bg-accent text-white hover:bg-accent/90',
                'transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <Play className="w-3 h-3" aria-hidden="true" />
              {t('action.continue')}
            </button>
          )}

          {showRememberSite && (
            <label
              data-testid="browser-remember-site"
              title={t('action.rememberSiteHint')}
              className={cn(
                'flex items-center gap-1 px-1 py-1 rounded text-[11px] text-text-secondary',
                'hover:text-text-primary cursor-pointer select-none',
                FOCUS_CLASSES,
              )}
            >
              <input
                type="checkbox"
                data-testid="browser-remember-site-checkbox"
                checked={session.rememberSite}
                onChange={(event) => setRememberSite(sessionId, event.target.checked)}
                className="w-3 h-3 accent-accent cursor-pointer"
              />
              {t('action.rememberSite')}
            </label>
          )}

          {showRetry && (
            <button
              type="button"
              data-testid="browser-retry-button"
              onClick={() => void retryViewer(sessionId)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
                'bg-accent text-white hover:bg-accent/90 transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              {t('action.retry')}
            </button>
          )}

          {onPopout && session.viewerUrl && (
            <button
              type="button"
              data-testid="browser-popout-button"
              onClick={onPopout}
              aria-label={t('action.popout')}
              className={cn(
                'p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {session.verbError && (
        <div data-testid="browser-verb-error" className="px-3 py-1 text-[11px] text-destructive">
          {session.verbError}
        </div>
      )}
    </div>
  )
}
