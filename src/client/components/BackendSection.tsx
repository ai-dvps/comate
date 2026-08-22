import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, Loader2, Cpu } from 'lucide-react'
import { useBackendStore, type BackendId, type BackendInfo } from '../stores/backend-store'
import { cn } from './ui/utils'

const BACKEND_LABEL_KEYS: Record<string, string> = {
  claude: 'backend.claude',
  opencode: 'backend.opencode',
}

interface BackendOptionProps {
  backend: BackendInfo
  isDefault: boolean
  isSaving: boolean
  selectionLocked: boolean
  onSelect: (backend: BackendId) => void
}

function BackendOption({
  backend,
  isDefault,
  isSaving,
  selectionLocked,
  onSelect,
}: BackendOptionProps) {
  const { t } = useTranslation('chat')
  const available = backend.availability.status === 'available'

  return (
    <label
      className={cn(
        'group flex min-h-[76px] w-full items-center gap-4 rounded-xl border px-4 py-3.5 text-left transition-[background-color,border-color,box-shadow]',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/40 focus-within:ring-offset-2 focus-within:ring-offset-bg',
        isDefault && 'border-accent/60 bg-accent/[0.07] shadow-sm',
        !isDefault && available && 'cursor-pointer border-border bg-surface hover:border-accent/30 hover:bg-surface-hover',
        !isDefault && !available && 'border-border/70 bg-surface/60 opacity-60',
        (!available || selectionLocked) && 'cursor-not-allowed',
      )}
    >
      <input
        type="radio"
        name="default-agent-backend"
        className="sr-only"
        checked={isDefault}
        onChange={() => onSelect(backend.id)}
        disabled={!available || selectionLocked}
      />

      <span
        className={cn(
          'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border transition-colors',
          isDefault
            ? 'border-accent/30 bg-accent/10 text-accent'
            : 'border-border bg-bg text-text-tertiary group-hover:text-text-secondary',
        )}
        aria-hidden="true"
      >
        <Cpu className="h-4.5 w-4.5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-text-primary">
          {t(BACKEND_LABEL_KEYS[backend.id] ?? backend.id)}
        </span>
        <span className="mt-1 flex items-start gap-1.5 text-[11px] leading-4 text-text-tertiary">
          {available ? (
            <>
              <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-green-500" aria-hidden="true" />
              <span>{t('backend.available')}</span>
            </>
          ) : (
            <>
              <XCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-destructive" aria-hidden="true" />
              <span>{backend.availability.reason ?? t('backend.unavailable')}</span>
            </>
          )}
        </span>
      </span>

      {isSaving ? (
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden="true" />
      ) : isDefault ? (
        <span className="flex-shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2.5 py-1 text-[10px] font-medium text-accent">
          {t('backend.isDefault')}
        </span>
      ) : null}
    </label>
  )
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
  const loadError = useBackendStore((s) => s.error)
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

  const error = saveError ?? loadError

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8" aria-labelledby="backend-settings-title">
      <header className="mb-6 max-w-2xl">
        <h3 id="backend-settings-title" className="text-base font-semibold text-text-primary">
          {t('backend.selectorTitle')}
        </h3>
        <p className="mt-1.5 text-xs leading-5 text-text-tertiary">
          {t('backend.defaultDescription')}
        </p>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {isLoading && backends.length === 0 ? (
        <div className="flex min-h-28 items-center justify-center rounded-xl border border-border bg-surface" role="status">
          <Loader2 className="h-5 w-5 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">{t('common:loading')}</span>
        </div>
      ) : backends.length > 0 ? (
        <div className="space-y-3" role="radiogroup" aria-labelledby="backend-settings-title">
          {backends.map((backend) => (
            <BackendOption
              key={backend.id}
              backend={backend}
              isDefault={defaultBackend === backend.id}
              isSaving={saving === backend.id}
              selectionLocked={saving !== null}
              onSelect={(backendId) => void handleSelect(backendId)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-sm text-text-tertiary">
          {t('backend.noneAvailable')}
        </div>
      )}
    </section>
  )
}
