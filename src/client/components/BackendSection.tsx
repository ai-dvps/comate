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
  Gauge,
  Coins,
} from 'lucide-react'
import {
  useBackendStore,
  type BackendId,
  type BackendInfo,
  type CodexAccountUsage,
} from '../stores/backend-store'
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
  const defaultModel = useBackendStore((state) => state.codexDefaultModel)
  const defaultEffort = useBackendStore((state) => state.codexDefaultEffort)
  const defaultSpeed = useBackendStore((state) => state.codexDefaultSpeed)
  const loading = useBackendStore((state) => state.codexAccountLoading)
  const error = useBackendStore((state) => state.codexAccountError)
  const usage = useBackendStore((state) => state.codexUsage)
  const usageLoading = useBackendStore((state) => state.codexUsageLoading)
  const usageError = useBackendStore((state) => state.codexUsageError)
  const fetchAccount = useBackendStore((state) => state.fetchCodexAccount)
  const startLogin = useBackendStore((state) => state.startCodexLogin)
  const cancelLogin = useBackendStore((state) => state.cancelCodexLogin)
  const logout = useBackendStore((state) => state.logoutCodex)
  const fetchModels = useBackendStore((state) => state.fetchCodexModels)
  const fetchUsage = useBackendStore((state) => state.fetchCodexUsage)
  const setDefaults = useBackendStore((state) => state.setCodexDefaults)
  const [apiKey, setApiKey] = useState('')
  const [pendingLogin, setPendingLogin] = useState<{ loginId: string; authUrl: string } | null>(null)

  useEffect(() => {
    void fetchAccount()
  }, [fetchAccount])

  useEffect(() => {
    if (account) void Promise.all([fetchModels(), fetchUsage()])
  }, [account, fetchModels, fetchUsage])

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

  let accountLabel: string | null = null
  if (account?.type === 'chatgpt') {
    accountLabel = account.email || t('backend.codexChatGptAccount')
  } else if (account?.type === 'apiKey') {
    accountLabel = t('backend.codexApiKeyAccount')
  } else if (account?.type === 'amazonBedrock') {
    accountLabel = t('backend.codexBedrockAccount')
  }
  const selectedModel = models.find((model) => model.model === defaultModel)
    ?? models.find((model) => model.isDefault)
  const updateDefaults = (patch: Partial<{ model: string | null; effort: string | null; speed: string | null }>) => {
    const next = {
      model: defaultModel,
      effort: defaultEffort,
      speed: defaultSpeed,
      ...patch,
    }
    void setDefaults(next).catch(() => undefined)
  }

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
        <div className="space-y-3">
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
          <CodexUsageSummary usage={usage} loading={usageLoading} error={usageError} />
          {models.length > 0 && (
            <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {t('backend.codexDefaultModel')}
                </span>
                <select
                  value={defaultModel ?? ''}
                  onChange={(event) => updateDefaults({
                    model: event.target.value || null,
                    effort: null,
                    speed: null,
                  })}
                  className="h-9 w-full rounded-md border border-border bg-bg px-3 text-xs text-text-primary outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
                >
                  <option value="">{t('backend.codexNativeDefaultModel')}</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.model}>
                      {model.displayName}{model.isDefault ? ` (${t('backend.codexCatalogDefault')})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {t('backend.codexDefaultEffort')}
                </span>
                <select
                  value={defaultEffort ?? ''}
                  onChange={(event) => updateDefaults({ effort: event.target.value || null })}
                  className="h-9 w-full rounded-md border border-border bg-bg px-3 text-xs text-text-primary outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
                >
                  <option value="">{t('backend.codexModelDefault')}</option>
                  {selectedModel?.supportedReasoningEfforts.map((option) => (
                    <option key={option.reasoningEffort} value={option.reasoningEffort}>
                      {option.reasoningEffort}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {t('backend.codexDefaultSpeed')}
                </span>
                <select
                  value={defaultSpeed ?? ''}
                  onChange={(event) => updateDefaults({ speed: event.target.value || null })}
                  className="h-9 w-full rounded-md border border-border bg-bg px-3 text-xs text-text-primary outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
                >
                  <option value="">{t('backend.codexModelDefault')}</option>
                  {selectedModel?.serviceTiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>{tier.name}</option>
                  ))}
                </select>
              </label>
              <span className="text-xs leading-4 text-text-tertiary sm:col-span-3">
                {t('backend.codexDefaultModelDescription')}
              </span>
            </div>
          )}
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

function CodexUsageSummary({
  usage,
  loading,
  error,
}: {
  usage: CodexAccountUsage | null
  loading: boolean
  error: string | null
}) {
  const { t, i18n } = useTranslation('chat')
  if (loading && !usage) {
    return (
      <div role="status" className="flex items-center gap-2 text-xs text-text-tertiary">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {t('backend.codexUsageLoading')}
      </div>
    )
  }
  if (!usage) {
    return <div className="text-xs text-text-tertiary">{error || t('backend.codexUsageUnavailable')}</div>
  }

  const tokenUsage = usage.tokenUsage
  const sevenDays = sumRecentTokens(tokenUsage?.dailyUsageBuckets ?? [], 7)
  const thirtyDays = sumRecentTokens(tokenUsage?.dailyUsageBuckets ?? [], 30)
  const rateWindows = [usage.rateLimit?.primary, usage.rateLimit?.secondary].filter(
    (window): window is NonNullable<typeof window> => Boolean(window),
  )

  return (
    <section aria-label={t('backend.codexUsage')} className="space-y-2.5 rounded-lg border border-border/70 bg-bg/40 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
        <Gauge className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
        {t('backend.codexUsage')}
        {loading ? <Loader2 className="h-3 w-3 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" /> : null}
      </div>

      {rateWindows.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {rateWindows.map((window) => (
            <div key={`${window.windowDurationMins}-${window.resetsAt}`} className="rounded-md border border-border/60 bg-surface px-3 py-2.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-text-secondary">{rateWindowLabel(t, window.windowDurationMins)}</span>
                <span className="tabular-nums text-text-tertiary">{t('backend.codexUsageUsed', { percent: Math.round(window.usedPercent) })}</span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(window.usedPercent)}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/70"
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
              </div>
              {window.resetsAt ? (
                <div className="mt-1.5 text-[11px] text-text-tertiary">
                  {t('backend.codexUsageResets', { time: formatResetTime(window.resetsAt, i18n.language) })}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <UsageMetric label={t('backend.codexUsageSevenDays')} value={formatTokenCount(sevenDays, i18n.language)} />
        <UsageMetric label={t('backend.codexUsageThirtyDays')} value={formatTokenCount(thirtyDays, i18n.language)} />
        <UsageMetric label={t('backend.codexUsageLifetime')} value={formatTokenCount(tokenUsage?.lifetimeTokens, i18n.language)} />
        <UsageMetric
          label={t('backend.codexUsageCredits')}
          value={formatCredits(usage.rateLimit?.credits, t)}
          icon={<Coins className="h-3 w-3" aria-hidden="true" />}
        />
      </div>
      {error ? <div className="text-[11px] text-destructive">{error}</div> : null}
    </section>
  )
}

function UsageMetric({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-surface px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] text-text-tertiary">{icon}{label}</div>
      <div className="mt-1 truncate text-xs font-medium tabular-nums text-text-primary" title={value}>{value}</div>
    </div>
  )
}

function sumRecentTokens(buckets: Array<{ tokens: string }>, days: number): string | null {
  if (buckets.length === 0) return null
  return buckets.slice(-days).reduce((sum, bucket) => sum + BigInt(bucket.tokens), 0n).toString()
}

function formatTokenCount(value: string | null | undefined, locale: string): string {
  if (!value) return '—'
  try {
    return new Intl.NumberFormat(locale).format(BigInt(value))
  } catch {
    return value
  }
}

function rateWindowLabel(t: (key: string, options?: Record<string, unknown>) => string, minutes: number | null): string {
  if (minutes === 300) return t('backend.codexUsageFiveHour')
  if (minutes === 10_080) return t('backend.codexUsageWeekly')
  return t('backend.codexUsageWindow', { hours: minutes ? Math.round(minutes / 60) : '—' })
}

function formatResetTime(timestampSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(timestampSeconds * 1_000))
}

function formatCredits(
  credits: NonNullable<CodexAccountUsage['rateLimit']>['credits'] | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!credits?.hasCredits) return '—'
  if (credits.unlimited) return t('backend.codexUsageUnlimited')
  return t('backend.codexUsageCreditBalance', { balance: credits.balance ?? '0' })
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
