import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Cpu,
  ChevronDown,
  ExternalLink,
  KeyRound,
  LogOut,
  RefreshCw,
} from 'lucide-react'
import { useBackendStore, type BackendId, type BackendInfo } from '../stores/backend-store'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { cn } from './ui/utils'
import OutputStyleSetting from './OutputStyleSetting'
import { openUrlInBrowser } from '../lib/open-url'

const BACKEND_LABEL_KEYS: Record<string, string> = {
  claude: 'backend.claude',
  opencode: 'backend.opencode',
  codex: 'backend.codex',
}

interface BackendOptionProps {
  backend: BackendInfo
  isDefault: boolean
  isSaving: boolean
  selectionLocked: boolean
  onSelect: (backend: BackendId) => void
  children?: ReactNode
}

function AgentSettingsGroup({ backendLabel, children }: { backendLabel: string; children: ReactNode }) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(true)

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="border-t border-border/70 bg-bg/30">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={t(isOpen ? 'backend.collapseSettings' : 'backend.expandSettings', {
              backend: backendLabel,
            })}
            aria-expanded={isOpen}
            className="flex min-h-9 w-full items-center justify-between gap-3 px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:pl-16 sm:pr-5"
          >
            <span>{t('backend.settings')}</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 flex-shrink-0 text-text-tertiary transition-transform duration-150 motion-reduce:transition-none',
                isOpen && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="animate-settings-collapse divide-y divide-border/60 border-t border-border/60">
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function BackendOption({
  backend,
  isDefault,
  isSaving,
  selectionLocked,
  onSelect,
  children,
}: BackendOptionProps) {
  const { t } = useTranslation('chat')
  const available = backend.availability.status === 'available'
  const backendLabel = t(BACKEND_LABEL_KEYS[backend.id] ?? backend.id)

  return (
    <div
      data-backend-option={backend.id}
      className="w-full text-left"
    >
      <label
        className={cn(
          'group relative flex min-h-16 w-full items-center gap-3 px-4 py-2.5 transition-colors sm:px-5',
          isDefault && 'bg-accent/[0.055]',
          available && !selectionLocked && 'cursor-pointer hover:bg-surface-hover/70 active:bg-surface-hover',
          (!available || selectionLocked) && 'cursor-not-allowed',
          !available && 'opacity-55',
        )}
      >
        <input
          type="radio"
          name="default-agent-backend"
          checked={isDefault}
          onChange={() => onSelect(backend.id)}
          disabled={!available || selectionLocked}
          className="peer sr-only"
        />

        <span
          className={cn(
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors',
            isDefault
              ? 'border-accent/30 bg-accent/10 text-accent'
              : 'border-border bg-bg text-text-tertiary group-hover:text-text-secondary',
          )}
          aria-hidden="true"
        >
          <Cpu className="h-4 w-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-text-primary">
              {backendLabel}
            </span>
            {isDefault && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-accent">
                {t('backend.isDefault')}
              </span>
            )}
          </span>
          <span className="mt-1 flex items-start gap-1.5 text-xs leading-4 text-text-tertiary">
            {available ? (
              <>
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" aria-hidden="true" />
                <span>{t('backend.available')}</span>
              </>
            ) : (
              <>
                <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" aria-hidden="true" />
                <span>{backend.availability.reason ?? t('backend.unavailable')}</span>
              </>
            )}
          </span>
        </span>

        <span
          className={cn(
            'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-[border-color,box-shadow]',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface',
            isDefault || isSaving ? 'border-accent bg-accent' : 'border-text-tertiary/50 bg-bg',
          )}
          aria-hidden="true"
        >
          {isSaving ? (
            <Loader2 className="h-3 w-3 animate-spin text-white motion-reduce:animate-none" />
          ) : isDefault ? (
            <span className="h-2 w-2 rounded-full bg-white" />
          ) : null}
        </span>
      </label>

      {children && (
        <AgentSettingsGroup backendLabel={backendLabel}>{children}</AgentSettingsGroup>
      )}
    </div>
  )
}

function CodexAccountSetting() {
  const { t } = useTranslation('chat')
  const account = useBackendStore((state) => state.codexAccount)
  const models = useBackendStore((state) => state.codexModels)
  const loading = useBackendStore((state) => state.codexAccountLoading)
  const error = useBackendStore((state) => state.codexAccountError)
  const fetchAccount = useBackendStore((state) => state.fetchCodexAccount)
  const startLogin = useBackendStore((state) => state.startCodexLogin)
  const cancelLogin = useBackendStore((state) => state.cancelCodexLogin)
  const logout = useBackendStore((state) => state.logoutCodex)
  const fetchModels = useBackendStore((state) => state.fetchCodexModels)
  const [apiKey, setApiKey] = useState('')
  const [pendingLogin, setPendingLogin] = useState<{ loginId: string; authUrl: string } | null>(null)

  useEffect(() => {
    void fetchAccount()
  }, [fetchAccount])

  useEffect(() => {
    if (account) void fetchModels()
  }, [account, fetchModels])

  useEffect(() => {
    if (!pendingLogin) return
    const timer = window.setInterval(() => {
      void fetchAccount().then(() => {
        if (useBackendStore.getState().codexAccount) setPendingLogin(null)
      })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [fetchAccount, pendingLogin])

  const loginWithChatGpt = async () => {
    try {
      const result = await startLogin('chatgpt')
      if (result.type !== 'chatgpt') return
      setPendingLogin({ loginId: result.loginId, authUrl: result.authUrl })
      await openUrlInBrowser(result.authUrl)
    } catch {
      // The store exposes the sanitized failure inline.
    }
  }

  const loginWithApiKey = async () => {
    if (!apiKey.trim()) return
    try {
      await startLogin('apiKey', apiKey.trim())
      setApiKey('')
      await fetchAccount()
    } catch {
      // The store exposes the sanitized failure inline.
    }
  }

  const cancelPendingLogin = async () => {
    if (!pendingLogin) return
    try {
      await cancelLogin(pendingLogin.loginId)
      setPendingLogin(null)
    } catch {
      // A refresh remains available if cancellation fails.
    }
  }

  const accountLabel = account?.type === 'chatgpt'
    ? account.email || t('backend.codexChatGptAccount')
    : account?.type === 'apiKey'
      ? t('backend.codexApiKeyAccount')
      : account?.type === 'amazonBedrock'
        ? t('backend.codexBedrockAccount')
        : null

  return (
    <div className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-text-primary">{t('backend.codexAccount')}</div>
          <div className="mt-1 text-xs leading-4 text-text-tertiary">
            {accountLabel ?? t('backend.codexAccountDescription')}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
          aria-label={t('backend.codexRefreshAccount')}
          disabled={loading}
          onClick={() => void fetchAccount()}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
        </button>
      </div>

      {error && <div role="alert" className="text-xs text-destructive">{error}</div>}

      {account ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-green-500/10 px-2.5 py-1.5 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('backend.codexSignedIn')}
          </span>
          {models.length > 0 && (
            <span className="text-xs text-text-tertiary">
              {t('backend.codexModelsAvailable', { count: models.length })}
            </span>
          )}
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            disabled={loading}
            onClick={() => void logout().catch(() => undefined)}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            {t('backend.codexLogout')}
          </button>
        </div>
      ) : pendingLogin ? (
        <div className="space-y-2 rounded-lg border border-accent/20 bg-accent/[0.04] p-3">
          <div className="text-xs leading-4 text-text-secondary">{t('backend.codexLoginPending')}</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
              onClick={() => void openUrlInBrowser(pendingLogin.authUrl)}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t('backend.codexOpenLogin')}
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-hover"
              onClick={() => void cancelPendingLogin()}
            >
              {t('common:cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            disabled={loading}
            onClick={() => void loginWithChatGpt()}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t('backend.codexLoginChatGpt')}
          </button>
          <div className="flex max-w-md items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" aria-hidden="true" />
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                aria-label={t('backend.codexApiKey')}
                placeholder={t('backend.codexApiKeyPlaceholder')}
                className="h-9 w-full rounded-md border border-border bg-bg pl-8 pr-3 text-xs text-text-primary outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <button
              type="button"
              className="h-9 rounded-md border border-border px-3 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              disabled={loading || !apiKey.trim()}
              onClick={() => void loginWithApiKey()}
            >
              {t('backend.codexUseApiKey')}
            </button>
          </div>
        </div>
      )}
    </div>
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
        <div
          className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
          role="radiogroup"
          aria-labelledby="backend-settings-title"
        >
          {backends.map((backend) => (
            <BackendOption
              key={backend.id}
              backend={backend}
              isDefault={defaultBackend === backend.id}
              isSaving={saving === backend.id}
              selectionLocked={saving !== null}
              onSelect={(backendId) => void handleSelect(backendId)}
            >
              {backend.id === 'claude' ? <OutputStyleSetting /> : null}
              {backend.id === 'codex' ? <CodexAccountSetting /> : null}
            </BackendOption>
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
