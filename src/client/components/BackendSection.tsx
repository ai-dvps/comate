import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Loader2, Cpu } from 'lucide-react'
import { useBackendStore, type BackendId } from '../stores/backend-store'

const BACKEND_LABEL_KEYS: Record<string, string> = {
  claude: 'backend.claude',
  opencode: 'backend.opencode',
}

/**
 * Settings section for the app-level default agent backend (R2): pick the
 * default new sessions start with, and see each backend's availability
 * (binary presence + health check, U3).
 */
export default function BackendSection() {
  const { t } = useTranslation('chat')
  const backends = useBackendStore((s) => s.backends)
  const defaultBackend = useBackendStore((s) => s.defaultBackend)
  const isLoading = useBackendStore((s) => s.isLoading)
  const fetchBackends = useBackendStore((s) => s.fetchBackends)
  const setDefaultBackend = useBackendStore((s) => s.setDefaultBackend)
  const [saving, setSaving] = useState<BackendId | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (backends.length === 0) {
      fetchBackends()
    }
  }, [fetchBackends, backends.length])

  const handleSelect = async (backend: BackendId) => {
    if (backend === defaultBackend) return
    setSaving(backend)
    setSaveError(null)
    try {
      await setDefaultBackend(backend)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-text-primary">{t('backend.selectorTitle')}</h3>
        <p className="text-xs text-text-tertiary mt-1">{t('backend.defaultDescription')}</p>
      </div>

      {isLoading && backends.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {backends.map((backend) => {
            const available = backend.availability.status === 'available'
            const isDefault = defaultBackend === backend.id
            return (
              <button
                key={backend.id}
                onClick={() => void handleSelect(backend.id)}
                disabled={!available || saving !== null}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDefault
                    ? 'border-accent bg-accent/5'
                    : 'border-border hover:bg-surface-hover'
                }`}
              >
                <Cpu className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary">
                    {t(BACKEND_LABEL_KEYS[backend.id] ?? backend.id)}
                  </div>
                  <div className="text-[11px] text-text-tertiary flex items-center gap-1">
                    {available ? (
                      <>
                        <CheckCircle2 className="w-3 h-3 text-green-500" />
                        {t('backend.available')}
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3 h-3 text-destructive" />
                        {backend.availability.reason ?? t('backend.unavailable')}
                      </>
                    )}
                  </div>
                </div>
                {saving === backend.id ? (
                  <Loader2 className="w-4 h-4 animate-spin text-accent flex-shrink-0" />
                ) : isDefault ? (
                  <span className="text-[11px] text-accent font-medium flex-shrink-0">
                    {t('backend.isDefault')}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
      {saveError && <div className="text-xs text-destructive">{saveError}</div>}
    </div>
  )
}
