import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ExternalLink,
  Hand,
  Loader2,
  Play,
  RefreshCw,
  X,
} from 'lucide-react'
import { cn } from '../ui/utils'
import {
  EMPTY_SESSION_BROWSER_STATE,
  isLiveControlState,
  useBrowserPaneStore,
} from '../../stores/browser-pane-store'
import { isNativeBrowserView } from '../../lib/browser-view-bridge'
import { FOCUS_CLASSES } from './focus-classes'

/**
 * BrowserStateBar — the persistent control-state strip (R3). Renders the five
 * U6 states from the browser_state channel plus the local busy window:
 *
 *   agent_in_control  → "Comate is driving"   + [Take over]
 *   handoff_pending   → "asking you to take over" + [Take over] / [Continue=decline]
 *   user_in_control   → "You are driving"     + [Continue]
 *   (pendingVerb)     → transitioning — controls disabled (the flip lands when
 *                       the agent's in-progress action completes)
 *   session_lost      → crash copy            + [Retry] (next tool call also
 *                       rebuilds automatically)
 *
 * The same component backs the pane and the independent window — both drive the
 * one store state machine. State migrations are announced via aria-live.
 */

export interface BrowserStateBarProps {
  sessionId: string
  /** When provided, the independent-window button is shown (pane entry only). */
  onDetach?: () => void
}

/** Stable default for sessions with no state yet (selector identity). */
const EMPTY_SESSION = EMPTY_SESSION_BROWSER_STATE

export default function BrowserStateBar({ sessionId, onDetach }: BrowserStateBarProps) {
  const { t } = useTranslation('browser')
  const session = useBrowserPaneStore((s) => s.sessions[sessionId] ?? EMPTY_SESSION)
  const takeover = useBrowserPaneStore((s) => s.takeover)
  const handback = useBrowserPaneStore((s) => s.handback)
  const setRememberSite = useBrowserPaneStore((s) => s.setRememberSite)
  const retrySession = useBrowserPaneStore((s) => s.retrySession)
  const retryUnavailable = useBrowserPaneStore((s) => s.retryUnavailable)
  const close = useBrowserPaneStore((s) => s.close)
  const confirmIdleClose = useBrowserPaneStore((s) => s.confirmIdleClose)
  const snoozeIdle = useBrowserPaneStore((s) => s.snoozeIdle)
  const resolveTaskOutcome = useBrowserPaneStore((s) => s.resolveTaskOutcome)

  const busy = session.pendingVerb !== null
  const state = session.controlState
  const task = session.task

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
  // Explicit close (U1/U4): a live browser can be closed; distinct from the
  // parent layout's "collapse pane" (a client-side hide that keeps the session).
  const showClose =
    !busy && (state === 'agent_in_control' || state === 'user_in_control' || state === 'handoff_pending')

  return (
    <div data-testid="browser-state-bar" className="flex-shrink-0">
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-testid="browser-state-live">
        {t('a11y.stateAnnouncement', { state: stateLabel })}
      </span>
      {task && task.lifecycle !== 'abandoned' && task.lifecycle !== 'outcome-unknown' && (
        <div data-testid="browser-task-state" aria-live="polite" className="px-3 py-1 text-[11px] border-b border-border/50 text-text-secondary">
          {task.recoveryExhausted
            ? t('task.recoveryExhausted')
            : t(`task.${task.lifecycle}`, { verified: task.verified, required: task.required, pending: task.populatedPendingValidation })}
        </div>
      )}
      {task?.lifecycle === 'outcome-unknown' && task.outcome && (
        <div data-testid="browser-outcome-unknown" role="alert" className="px-3 py-2 text-xs border-b border-warning/40 bg-warning/10 text-warning">
          <div className="font-medium">{t('task.outcomePossibleDispatch')}</div>
          <div className="mt-0.5 text-text-secondary">
            {t('task.outcomeEvidence', { status: task.outcome.evidenceStatus,
              checked: task.outcome.lastCheckedAt ?? t('task.neverChecked') })}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {task.outcome.canRecheck && (
              <button type="button" className={cn('px-2 py-1 rounded border border-border', FOCUS_CLASSES)}
                onClick={() => void resolveTaskOutcome(sessionId, 'recheck')}>{t('action.recheckOutcome')}</button>
            )}
            <button type="button" className={cn('px-2 py-1 rounded border border-border', FOCUS_CLASSES)}
              onClick={() => void resolveTaskOutcome(sessionId, 'abandon')}>{t('action.abandonTracking')}</button>
            <button type="button" className={cn('px-2 py-1 rounded border border-warning/50', FOCUS_CLASSES)}
              onClick={() => void resolveTaskOutcome(sessionId, 'acknowledge_duplicate_risk')}>{t('action.acknowledgeDuplicateRisk')}</button>
          </div>
        </div>
      )}

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

      {session.idlePrompt && (
        <div
          data-testid="browser-idle-banner"
          className="px-3 py-1.5 text-xs bg-accent/10 text-text-secondary flex items-center gap-1.5"
        >
          <span className="truncate flex-1">{t('state.idlePrompt')}</span>
          <button
            type="button"
            data-testid="browser-idle-close"
            onClick={() => void confirmIdleClose(sessionId)}
            className={cn(
              'px-2 py-0.5 rounded text-[11px] font-medium bg-accent text-accent-foreground hover:bg-accent/90 transition-colors',
              FOCUS_CLASSES,
            )}
          >
            {t('action.closeNow')}
          </button>
          <button
            type="button"
            data-testid="browser-idle-snooze"
            onClick={() => snoozeIdle(sessionId)}
            className={cn(
              'px-2 py-0.5 rounded text-[11px] font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors',
              FOCUS_CLASSES,
            )}
          >
            {t('action.notNow')}
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
                'bg-accent/40 text-accent-foreground/60 cursor-not-allowed',
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
                'bg-accent text-accent-foreground hover:bg-accent/90 transition-colors',
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
                  : 'bg-accent text-accent-foreground hover:bg-accent/90',
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
              onClick={() => void retrySession(sessionId)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium',
                'bg-accent text-accent-foreground hover:bg-accent/90 transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              {t('action.retry')}
            </button>
          )}

          {onDetach && isLiveControlState(state) && isNativeBrowserView() && (
            <button
              type="button"
              data-testid="browser-detach-button"
              onClick={onDetach}
              aria-label={t('action.openIndependentWindow')}
              className={cn(
                'p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}

          {showClose && (
            <button
              type="button"
              data-testid="browser-close-button"
              onClick={() => void close(sessionId)}
              aria-label={t('action.closeBrowser')}
              title={t('action.closeBrowserHint')}
              className={cn(
                'p-1.5 rounded-md text-text-tertiary hover:text-destructive hover:bg-destructive/10 transition-colors',
                FOCUS_CLASSES,
              )}
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
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
