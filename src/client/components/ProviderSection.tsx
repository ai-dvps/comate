import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronDown, Eye, EyeOff, Loader2, Plus, RefreshCw, Save, Server, Star, Trash2, XCircle } from 'lucide-react'
import { useProviderStore, type Provider, type ProviderConfiguration, type ProviderFormData, type ProviderPreset } from '../stores/provider-store'
import type { BackendId } from '../stores/backend-store'
import { hasUsageSupport, useProviderUsageStore } from '../stores/provider-usage-store'
import ConfirmDialog from './ConfirmDialog'
import { cn } from './ui/utils'

type EndpointState = 'idle' | 'checking' | 'reachable' | 'unreachable' | 'disabled' | 'invalid'
type EndpointKind = 'anthropic' | 'openai'

const EMPTY_CONFIGURATION: ProviderConfiguration = {
  schemaVersion: 1,
  endpoints: {
    anthropic: { enabled: true, baseUrl: 'https://api.anthropic.com' },
    openai: { enabled: false, baseUrl: '', format: 'openai-responses' },
  },
  models: {}, openCode: { protocol: 'anthropic' }, claude: {},
  codex: { promptCacheRouting: 'unsupported', thinking: 'unknown' },
}

function emptyForm(): ProviderFormData {
  return { name: '', authToken: '', configuration: structuredClone(EMPTY_CONFIGURATION) }
}

function providerToForm(provider: Provider): ProviderFormData {
  return {
    name: provider.name,
    authToken: '',
    configuration: structuredClone(provider.configuration ?? EMPTY_CONFIGURATION),
  }
}

function endpointState(enabled: boolean, baseUrl: string): EndpointState {
  if (!enabled) return 'disabled'
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash ? 'idle' : 'invalid'
  } catch { return 'invalid' }
}

function providerSummary(provider: Provider): string {
  const endpoints = provider.configuration?.endpoints
  return endpoints?.openai?.enabled ? endpoints.openai.baseUrl : endpoints?.anthropic?.baseUrl ?? provider.baseUrl
}

function healthAgent(kind: EndpointKind, form: ProviderFormData): BackendId {
  if (kind === 'anthropic') return 'claude'
  return form.configuration.openCode.protocol === 'openai' && !form.configuration.models.codex ? 'opencode' : 'codex'
}

function firstHealthAgent(form: ProviderFormData): BackendId {
  const config = form.configuration
  if (config.endpoints.anthropic?.enabled && config.models.claudeCode) return 'claude'
  if (config.endpoints.openai?.enabled && config.models.codex) return 'codex'
  return 'opencode'
}

function ProviderUsagePanel({ providerId }: { providerId: string }) {
  const { t } = useTranslation('settings')
  const entry = useProviderUsageStore((state) => state.usageByProvider[providerId])
  const fetchUsage = useProviderUsageStore((state) => state.fetchUsage)
  useEffect(() => { void fetchUsage(providerId) }, [fetchUsage, providerId])
  if (!entry || entry.status === 'unsupported') return null
  if (entry.status === 'fetching') return <div role="status" className="mt-1 text-[10px] text-text-tertiary">{t('providers.usage.loading')}</div>
  if (entry.status === 'ready' && entry.summary) {
    return <div className="mt-1 text-[10px] text-text-tertiary">{entry.summary.used ?? '—'} / {entry.summary.total ?? '—'} {t('providers.usage.used')}</div>
  }
  if (entry.status === 'error') return <button type="button" onClick={() => void fetchUsage(providerId, { force: true })} className="mt-1 text-[10px] text-accent hover:underline">{t('providers.usage.retry')}</button>
  return null
}

function endpointStatusLabel(t: ReturnType<typeof useTranslation>['t'], state: EndpointState): string {
  return t(`providers.endpointStatus.${state}`)
}

function EndpointCard({
  kind, form, state, error, editable, onChange, onTest,
}: {
  kind: EndpointKind
  form: ProviderFormData
  state: EndpointState
  error?: string
  editable: boolean
  onChange: (configuration: ProviderConfiguration) => void
  onTest?: () => void
}) {
  const { t } = useTranslation('settings')
  const configuration = form.configuration
  const endpoint = kind === 'anthropic'
    ? configuration.endpoints.anthropic ?? { enabled: false, baseUrl: '' }
    : configuration.endpoints.openai ?? { enabled: false, baseUrl: '', format: 'openai-responses' as const }
  const id = `provider-${kind}-endpoint`
  const statusId = `${id}-status`
  const update = (patch: { enabled?: boolean; baseUrl?: string; format?: 'openai-responses' | 'openai-chat-completions' }) => {
    const next = structuredClone(configuration)
    if (kind === 'anthropic') next.endpoints.anthropic = { enabled: patch.enabled ?? endpoint.enabled, baseUrl: patch.baseUrl ?? endpoint.baseUrl }
    else {
      const openai = configuration.endpoints.openai ?? { enabled: false, baseUrl: '', format: 'openai-responses' as const }
      next.endpoints.openai = { enabled: patch.enabled ?? openai.enabled, baseUrl: patch.baseUrl ?? openai.baseUrl, format: patch.format ?? openai.format }
    }
    onChange(next)
  }
  return (
    <fieldset className="min-w-0 rounded-xl border border-border bg-bg/40 p-4" aria-describedby={statusId}>
      <legend className="px-1 text-xs font-semibold text-text-primary">{t(`providers.${kind}Endpoint`)}</legend>
      <label className="mb-3 flex items-center gap-2 text-xs text-text-secondary">
        <input type="checkbox" checked={endpoint.enabled} disabled={!editable} onChange={(event) => update({ enabled: event.target.checked })} />
        {t('providers.endpointEnabled')}
      </label>
      <label className="block text-[11px] font-medium text-text-tertiary" htmlFor={`${id}-url`}>{t('providers.baseUrl')}</label>
      <input
        id={`${id}-url`} aria-label={`${t(`providers.${kind}Endpoint`)} ${t('providers.baseUrl')}`} value={endpoint.baseUrl} disabled={!editable || !endpoint.enabled}
        onChange={(event) => update({ baseUrl: event.target.value })}
        aria-invalid={state === 'invalid'} aria-describedby={statusId}
        placeholder={kind === 'anthropic' ? 'https://api.example.com/anthropic' : 'https://api.example.com/v1'}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
      />
      {kind === 'openai' && (
        <label className="mt-3 block text-[11px] font-medium text-text-tertiary" htmlFor={`${id}-format`}>
          {t('providers.upstreamFormat')}
          <select
            id={`${id}-format`} disabled={!editable || !endpoint.enabled}
            value={configuration.endpoints.openai?.format ?? 'openai-responses'}
            onChange={(event) => update({ format: event.target.value as 'openai-responses' | 'openai-chat-completions' })}
            className="mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
          >
            <option value="openai-responses">{t('providers.formatResponses')}</option>
            <option value="openai-chat-completions">{t('providers.formatChatCompletions')}</option>
          </select>
        </label>
      )}
      <div id={statusId} role="status" aria-live="polite" className={cn(
        'mt-3 flex min-w-0 items-start gap-1.5 text-[11px]',
        state === 'reachable' ? 'text-green-600 dark:text-green-400' : state === 'unreachable' || state === 'invalid' ? 'text-destructive' : 'text-text-tertiary',
      )}>
        {state === 'checking' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : state === 'reachable' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : state === 'unreachable' || state === 'invalid' ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="break-words">{error || endpointStatusLabel(t, state)}</span>
      </div>
      {onTest && endpoint.enabled && state !== 'invalid' && (
        <button type="button" onClick={onTest} disabled={state === 'checking'} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50">
          <RefreshCw className={cn('h-3.5 w-3.5', state === 'checking' && 'animate-spin')} />
          {state === 'unreachable' ? t('providers.retryEndpoint') : t('providers.testEndpoint')}
        </button>
      )}
    </fieldset>
  )
}

export default function ProviderSection() {
  const { t } = useTranslation('settings')
  const store = useProviderStore()
  const fetchProviders = store.fetchProviders
  const fetchPresets = store.fetchPresets
  const clearError = store.clearError
  const providerCount = store.providers.length
  const presetCount = store.presets.length
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderFormData>(emptyForm)
  const [baseline, setBaseline] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingPreset, setPendingPreset] = useState<ProviderPreset | null>(null)
  const [saveFailure, setSaveFailure] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [health, setHealth] = useState<Record<string, { state: EndpointState; error?: string }>>({})
  const errorSummaryRef = useRef<HTMLDivElement>(null)
  const existing = editingId && editingId !== 'new' ? store.providers.find((provider) => provider.id === editingId) : undefined
  const dirty = editingId !== null && JSON.stringify(form) !== baseline

  useEffect(() => {
    if (providerCount === 0 || presetCount === 0) {
      void Promise.all([
        providerCount === 0 ? fetchProviders() : Promise.resolve(),
        presetCount === 0 ? fetchPresets() : Promise.resolve(),
      ])
    }
  }, [fetchPresets, fetchProviders, presetCount, providerCount])

  useEffect(() => { if (formError) errorSummaryRef.current?.focus() }, [formError])

  const endpointStates = useMemo(() => ({
    anthropic: health.anthropic ?? { state: endpointState(Boolean(form.configuration.endpoints.anthropic?.enabled), form.configuration.endpoints.anthropic?.baseUrl ?? '') },
    openai: health.openai ?? { state: endpointState(Boolean(form.configuration.endpoints.openai?.enabled), form.configuration.endpoints.openai?.baseUrl ?? '') },
  }), [form.configuration.endpoints, health])

  const resetEditor = useCallback(() => {
    setEditingId(null); setForm(emptyForm()); setBaseline(''); setFormError(null); setHealth({}); setShowAdvanced(false); clearError()
  }, [clearError])

  const beginCreate = () => {
    const next = emptyForm()
    setEditingId('new'); setForm(next); setBaseline(JSON.stringify(next)); setHealth({}); setFormError(null); store.clearError()
  }
  const beginEdit = (provider: Provider) => {
    const next = providerToForm(provider)
    setEditingId(provider.id); setForm(next); setBaseline(JSON.stringify(next)); setHealth({}); setFormError(null); store.clearError()
  }
  const applyPreset = (preset: ProviderPreset) => {
    const next = { ...form, name: preset.name, configuration: structuredClone(preset.configuration) }
    setForm(next); setHealth({}); setPendingPreset(null)
  }
  const selectPreset = (preset: ProviderPreset) => {
    if (dirty) setPendingPreset(preset)
    else applyPreset(preset)
  }

  const validate = (): string | null => {
    if (!form.name.trim()) return t('providers.nameRequired')
    if (!form.authToken.trim() && !existing?.authTokenPresent) return t('providers.authTokenRequired')
    const enabled = Object.values(form.configuration.endpoints).filter((endpoint) => endpoint?.enabled)
    if (enabled.length === 0) return t('providers.endpointRequired')
    if (endpointStates.anthropic.state === 'invalid' || endpointStates.openai.state === 'invalid') return t('providers.validHttpsRequired')
    return null
  }

  const save = async (skipHealthCheck = false) => {
    const validation = validate()
    setFormError(validation); setSaveFailure(null)
    if (validation) return
    const agent = firstHealthAgent(form)
    const result = editingId === 'new'
      ? await store.createProvider(form, { skipHealthCheck, agent })
      : editingId ? await store.updateProvider(editingId, form, { skipHealthCheck, agent }) : { provider: null }
    if (!result.provider && result.status === 422) {
      const reason = result.error ?? t('providers.endpointUnreachable')
      if (reason.toLowerCase().includes('unreachable')) setSaveFailure(reason)
      else setFormError(reason)
      return
    }
    if (result.provider) resetEditor()
  }

  const testEndpoint = async (kind: EndpointKind) => {
    if (!existing) return
    setHealth((current) => ({ ...current, [kind]: { state: 'checking' } }))
    const result = await store.runHealthCheck(existing.id, healthAgent(kind, form))
    setHealth((current) => ({ ...current, [kind]: result.ok ? { state: 'reachable' } : { state: 'unreachable', error: result.error } }))
  }

  const updateConfiguration = (configuration: ProviderConfiguration) => {
    setForm((current) => ({ ...current, configuration })); setHealth({})
  }

  if (editingId) {
    return (
      <section className="max-w-4xl p-4 sm:p-6" aria-labelledby="provider-editor-title">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 id="provider-editor-title" className="text-sm font-medium text-text-primary">{editingId === 'new' ? t('providers.add') : t('providers.edit')}</h3>
          <button type="button" onClick={resetEditor} aria-label={t('actions.cancel')} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><XCircle className="h-4 w-4" /></button>
        </div>
        {(formError || store.error) && <div ref={errorSummaryRef} tabIndex={-1} role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{formError || store.error}</div>}

        <fieldset className="mb-4 rounded-xl border border-border p-4">
          <legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.preset')}</legend>
          <div className="flex flex-wrap gap-2">
            {store.presets.map((preset) => <button key={preset.id} type="button" onClick={() => selectPreset(preset)} className={cn('rounded-lg border px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', form.configuration.preset?.id === preset.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-surface-hover')}>{preset.name}</button>)}
            {store.presetsLoading && <Loader2 aria-label={t('providers.loadingPresets')} className="h-4 w-4 animate-spin text-text-tertiary" />}
          </div>
        </fieldset>

        <fieldset className="mb-4 grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
          <legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.sharedSettings')}</legend>
          <label className="text-[11px] font-medium text-text-tertiary">{t('providers.name')} *
            <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} aria-invalid={Boolean(formError && !form.name.trim())} className="mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40" />
          </label>
          <label className="text-[11px] font-medium text-text-tertiary">{t('providers.authToken')} *
            <span className="mt-1 flex gap-2"><input type={showToken ? 'text' : 'password'} value={form.authToken} onChange={(event) => setForm((current) => ({ ...current, authToken: event.target.value }))} placeholder={existing?.authTokenPresent ? t('providers.authTokenKeepPlaceholder') : 'sk-…'} className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40" /><button type="button" onClick={() => setShowToken((value) => !value)} aria-label={showToken ? t('providers.hideToken') : t('providers.showToken')} className="rounded-lg border border-border p-2 text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></span>
          </label>
        </fieldset>

        <div className="mb-4 grid min-w-0 gap-4 lg:grid-cols-2">
          <EndpointCard kind="anthropic" form={form} state={endpointStates.anthropic.state} error={endpointStates.anthropic.error} editable onChange={updateConfiguration} onTest={existing ? () => testEndpoint('anthropic') : undefined} />
          <EndpointCard kind="openai" form={form} state={endpointStates.openai.state} error={endpointStates.openai.error} editable onChange={updateConfiguration} onTest={existing ? () => testEndpoint('openai') : undefined} />
        </div>

        <fieldset className="mb-4 grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-3">
          <legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.agentModels')}</legend>
          {(['claudeCode', 'codex', 'openCode'] as const).map((agent) => <label key={agent} className="text-[11px] font-medium text-text-tertiary">{t(`providers.models.${agent}`)}<input value={form.configuration.models[agent] ?? ''} onChange={(event) => updateConfiguration({ ...form.configuration, models: { ...form.configuration.models, [agent]: event.target.value } })} className="mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40" /></label>)}
          <label className="text-[11px] font-medium text-text-tertiary sm:col-span-3">{t('providers.openCodeProtocol')}
            <select value={form.configuration.openCode.protocol} onChange={(event) => updateConfiguration({ ...form.configuration, openCode: { protocol: event.target.value as 'anthropic' | 'openai' } })} className="mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option></select>
          </label>
        </fieldset>

        <button type="button" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((value) => !value)} className="mb-4 inline-flex items-center gap-1 text-xs text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-180')} />{t('providers.advanced')}</button>
        {showAdvanced && <fieldset className="mb-4 grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2"><legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.claudeCapabilities')}</legend>{(['defaultOpusModel', 'defaultSonnetModel', 'defaultHaikuModel', 'subagentModel', 'effortLevel'] as const).map((key) => <label key={key} className="text-[11px] font-medium text-text-tertiary">{t(`providers.${key}`)}<input value={form.configuration.claude[key] ?? ''} onChange={(event) => updateConfiguration({ ...form.configuration, claude: { ...form.configuration.claude, [key]: event.target.value } })} className="mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/40" /></label>)}</fieldset>}

        <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={resetEditor} className="rounded-lg bg-surface-hover px-4 py-2 text-xs text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t('actions.cancel')}</button><button type="button" onClick={() => void save()} disabled={store.isSaving} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50">{store.isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{store.isSaving ? t('providers.checkingHealth') : t('actions.save')}</button></div>

        <ConfirmDialog isOpen={Boolean(pendingPreset)} title={t('providers.discardPresetTitle')} message={t('providers.discardPresetMessage')} confirmLabel={t('providers.applyPreset')} cancelLabel={t('actions.cancel')} onConfirm={() => pendingPreset && applyPreset(pendingPreset)} onCancel={() => setPendingPreset(null)} />
        <ConfirmDialog isOpen={Boolean(saveFailure)} title={t('providers.saveAnywayTitle')} message={t('providers.saveAnywayNamedMessage', { reason: saveFailure })} confirmLabel={t('providers.saveAnywayConfirm')} cancelLabel={t('actions.cancel')} onConfirm={() => { setSaveFailure(null); void save(true) }} onCancel={() => setSaveFailure(null)} />
      </section>
    )
  }

  return (
    <section className="max-w-4xl p-4 sm:p-6" aria-labelledby="providers-title">
      <div className="mb-4 flex items-center justify-between gap-3"><h3 id="providers-title" className="text-sm font-medium text-text-primary">{t('providers.title')}</h3><button type="button" onClick={beginCreate} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><Plus className="h-3.5 w-3.5" />{t('providers.add')}</button></div>
      {store.error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{store.error}</div>}
      {store.isLoading && store.providers.length === 0 ? <div role="status" className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-text-tertiary" /></div> : store.providers.length === 0 ? <div className="rounded-lg border border-dashed border-border py-8 text-center"><Server className="mx-auto mb-2 h-8 w-8 text-text-tertiary" /><p className="text-sm text-text-secondary">{t('providers.emptyTitle')}</p><button type="button" onClick={beginCreate} className="mt-3 rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground">{t('providers.createFirst')}</button></div> : <div className="space-y-2">{store.providers.map((provider) => <div key={provider.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3"><Star className={cn('h-4 w-4 shrink-0', provider.isDefault ? 'fill-warning text-warning' : 'text-text-tertiary')} /><div className="min-w-[12rem] flex-1"><div className="truncate text-sm font-medium text-text-primary">{provider.name}</div><div className="truncate text-[11px] text-text-tertiary">{providerSummary(provider)}</div>{hasUsageSupport(providerSummary(provider)) && <ProviderUsagePanel providerId={provider.id} />}</div><button type="button" onClick={() => beginEdit(provider)} className="rounded-md px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t('providers.edit')}</button>{!provider.isDefault && <button type="button" onClick={() => void store.setDefaultProvider(provider.id)} className="rounded-md px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t('providers.setDefault')}</button>}<button type="button" onClick={() => setDeleteId(provider.id)} aria-label={t('providers.deleteProvider', { name: provider.name })} className="rounded-md p-1.5 text-text-tertiary hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><Trash2 className="h-4 w-4" /></button></div>)}</div>}
      <ConfirmDialog isOpen={Boolean(deleteId)} title={t('providers.deleteConfirmTitle')} message={t('providers.deleteConfirmMessage')} confirmLabel={t('providers.delete')} cancelLabel={t('actions.cancel')} onConfirm={() => { if (!deleteId) return; void store.deleteProvider(deleteId).then(({ ok }) => { if (ok) setDeleteId(null) }) }} onCancel={() => setDeleteId(null)} />
    </section>
  )
}
