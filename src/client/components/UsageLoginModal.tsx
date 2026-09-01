import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2, MonitorOff } from 'lucide-react'
import { useProviderUsageStore } from '../stores/provider-usage-store'
import {
  isNativeBrowserView,
  onBrowserViewEscape,
  useBrowserViewRectReport,
} from '../lib/browser-view-bridge'
import { cn } from './ui/utils'

/**
 * Root-level login-capture modal for provider usage (KTD1/U4). Reachable from
 * both the provider selector and Provider settings, it walks the capture
 * state machine. Esc / Cancel tears the capture session down (no token
 * written); "I've logged in" finalizes (server verifies origin, extracts,
 * encrypts, and tears down).
 *
 * U9: the capture session's page is hosted as a native shell view INSIDE the
 * modal — the modal reports its content rect for the capture session and
 * exempts that one session from modal occlusion (every other browser view
 * still hides behind the overlay). Outside the Electron shell there is no
 * viewer backend (the iframe viewer left with the legacy browser stack), so
 * the modal degrades to a 'needs the desktop app' state (KTD-15).
 */
export default function UsageLoginModal() {
  const { t } = useTranslation('settings')
  const login = useProviderUsageStore((s) => s.login)
  const finalize = useProviderUsageStore((s) => s.finalizeUsageLogin)
  const cancel = useProviderUsageStore((s) => s.cancelUsageLogin)
  const start = useProviderUsageStore((s) => s.startUsageLogin)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const viewHostRef = useRef<HTMLDivElement | null>(null)
  const native = isNativeBrowserView()
  const captureSessionId = login?.sessionId ?? null
  const hostNativeView = native && captureSessionId !== null

  // Focus + restore on open/close.
  useEffect(() => {
    if (!login) return
    restoreRef.current = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => {
      restoreRef.current?.focus?.()
      restoreRef.current = null
    }
    // Re-run when a new capture (sessionId) starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.sessionId, login?.providerId])

  // Native view hosting: report the modal content rect for the capture
  // session, let the user drive it, and exempt it from the modal-occlusion
  // flag this very modal raises. Cleanup hides the view and clears the
  // exemption.
  useBrowserViewRectReport(viewHostRef, captureSessionId, hostNativeView, {
    inputMode: 'user',
    occlusionExempt: true,
  })

  // Esc intercepted by the shell while the user drives the view returns focus
  // to the modal (the next Esc then cancels via the keydown handler below).
  useEffect(() => {
    if (!hostNativeView || !captureSessionId) return
    return onBrowserViewEscape((escapedSessionId) => {
      if (escapedSessionId === captureSessionId) rootRef.current?.focus()
    })
  }, [hostNativeView, captureSessionId])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    },
    [cancel],
  )

  if (!login) return null
  const { phase, providerId } = login
  const showCaptureSurface =
    phase === 'ready' || phase === 'connecting' || phase === 'capturing'

  return (
    <div
      ref={rootRef}
      data-testid="usage-login-modal"
      role="dialog"
      aria-modal="true"
      data-modal-overlay=""
      aria-label={t('providers.usageLogin.title', 'Log in to your account')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        'fixed inset-0 z-50 flex flex-col items-center justify-center',
        'bg-black/50 p-4 outline-none',
      )}
    >
      <div className="flex w-[800px] max-w-[95vw] h-[600px] max-h-[90vh] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl">
        <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border/50 px-3">
          <span className="flex-1 truncate text-sm font-medium text-text-primary">
            {t('providers.usageLogin.title', 'Log in to your account')}
          </span>
          <button
            type="button"
            onClick={cancel}
            aria-label={t('providers.usageLogin.cancel', 'Cancel')}
            title={t('providers.usageLogin.cancel', 'Cancel')}
            className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-surface">
          {!native ? (
            // KTD-15 degraded state: no shell, no viewer backend at all.
            <div
              data-testid="usage-login-needs-desktop"
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
            >
              <MonitorOff className="h-8 w-8 text-text-tertiary" aria-hidden="true" />
              <p className="text-sm font-medium text-text-primary">
                {t('providers.usageLogin.needsDesktopTitle', 'Login capture needs the desktop app')}
              </p>
              <p className="text-xs text-text-secondary">
                {t(
                  'providers.usageLogin.needsDesktopDetail',
                  'The in-app browser is only available in the Comate desktop app. Open this page there to log in.',
                )}
              </p>
            </div>
          ) : (
            <>
              {/* The native view paints over this box at the reported rect. */}
              <div ref={viewHostRef} data-testid="usage-login-view-host" className="h-full w-full bg-black" />
              {(!showCaptureSurface || phase === 'connecting') && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-text-tertiary">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span className="text-sm">{t('providers.usageLogin.connecting', 'Preparing login…')}</span>
                </div>
              )}
            </>
          )}

          {phase === 'capturing' && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-bg/80 text-text-secondary">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              <span className="text-sm">{t('providers.usageLogin.capturing', 'Capturing your session…')}</span>
            </div>
          )}

          {phase === 'failed' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/90 px-6 text-center">
              <p className="text-sm text-text-primary">
                {t(
                  'providers.usageLogin.failed',
                  'Could not capture your session. Finish logging in, then try again.',
                )}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => start(providerId)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-text-on-primary"
                >
                  {t('providers.usageLogin.retry', 'Try again')}
                </button>
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-md border border-border px-3 py-1.5 text-sm"
                >
                  {t('providers.usageLogin.cancel', 'Cancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex h-12 flex-shrink-0 items-center justify-end gap-2 border-t border-border/50 px-3">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            {t('providers.usageLogin.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => finalize()}
            disabled={!native || phase !== 'ready'}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-text-on-primary disabled:opacity-50"
          >
            {t('providers.usageLogin.capture', "I've logged in — capture")}
          </button>
        </div>
      </div>
    </div>
  )
}
