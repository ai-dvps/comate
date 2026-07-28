import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'
import { useProviderUsageStore } from '../stores/provider-usage-store'
import { cn } from './ui/utils'

/**
 * Root-level login-capture modal for Kimi usage (KTD1/U4). Reachable from both
 * the provider selector and Provider settings, it hosts the transient capture
 * session's viewer-url iframe and walks the capture state machine. Esc / Cancel
 * tears the capture session down (no token written); "I've logged in" finalizes
 * (server verifies origin, extracts, encrypts, and tears down).
 */
export default function UsageLoginModal() {
  const { t } = useTranslation('settings')
  const login = useProviderUsageStore((s) => s.login)
  const finalize = useProviderUsageStore((s) => s.finalizeUsageLogin)
  const cancel = useProviderUsageStore((s) => s.cancelUsageLogin)
  const start = useProviderUsageStore((s) => s.startUsageLogin)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  // Fetch the capture session's viewer-url when a new capture begins; manage
  // focus + restore on open/close.
  useEffect(() => {
    if (!login) {
      setViewerUrl(null)
      return
    }
    restoreRef.current = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    let cancelled = false
    setViewerUrl(null)
    if (login.sessionId) {
      fetch(`/api/browser/${encodeURIComponent(login.sessionId)}/viewer-url`)
        .then((r) => r.json())
        .then((d: { url?: string | null }) => {
          if (!cancelled && d.url) setViewerUrl(d.url)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      restoreRef.current?.focus?.()
      restoreRef.current = null
    }
    // Re-run when a new capture (sessionId) starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.sessionId, login?.providerId])

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
  const showIframe = viewerUrl && (phase === 'ready' || phase === 'connecting' || phase === 'capturing')

  return (
    <div
      ref={rootRef}
      data-testid="usage-login-modal"
      role="dialog"
      aria-modal="true"
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
            className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-surface">
          {showIframe ? (
            <iframe src={viewerUrl!} title="Login" className="h-full w-full border-0" />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="text-sm">{t('providers.usageLogin.connecting', 'Preparing login…')}</span>
            </div>
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
            disabled={phase !== 'ready'}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-text-on-primary disabled:opacity-50"
          >
            {t('providers.usageLogin.capture', "I've logged in — capture")}
          </button>
        </div>
      </div>
    </div>
  )
}
