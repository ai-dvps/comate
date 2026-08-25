import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ProviderCodexModelProfile,
  ProviderConfiguration,
  ProviderEffort,
  ProviderOpenCodeModelProfile,
  ProviderOpenCodeVariant,
} from '../stores/provider-store'

const EFFORTS: ProviderEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']
const fieldClass = 'mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary'

function numberValue(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined
}

function GroupHeading({ children }: { children: string }) {
  return <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary sm:col-span-2">{children}</h4>
}

function NumberField({ label, value, onChange }: { label: string; value?: number; onChange(value?: number): void }) {
  return <label className="text-[11px] font-medium text-text-tertiary">{label}<input type="number" min={1} step={1} value={value ?? ''} onChange={(event) => onChange(numberValue(event.target.value))} className={`${fieldClass} outline-none focus-visible:ring-2 focus-visible:ring-accent/40`} /></label>
}

function BooleanSelect({ label, value, onChange }: { label: string; value?: boolean; onChange(value?: boolean): void }) {
  const { t } = useTranslation('settings')
  return <label className="text-[11px] font-medium text-text-tertiary">{label}<select value={value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')} className={fieldClass}><option value="">{t('providers.capabilityUnset')}</option><option value="true">{t('providers.capabilitySupported')}</option><option value="false">{t('providers.capabilityUnsupported')}</option></select></label>
}

export default function ProviderAdvancedCapabilities({ configuration, onChange }: { configuration: ProviderConfiguration; onChange(configuration: ProviderConfiguration): void }) {
  const { t } = useTranslation('settings')
  const codexModel = configuration.models.codex?.trim()
  const openCodeModel = configuration.models.openCode?.trim()
  const codexProfile = codexModel ? configuration.codex.modelProfiles?.[codexModel] ?? {} : {}
  const openCodeProfile = openCodeModel ? configuration.openCode.modelProfiles?.[openCodeModel] ?? {} : {}

  const updateCodex = (patch: Partial<Record<keyof ProviderCodexModelProfile, unknown>>) => {
    if (!codexModel) return
    const profile = { ...codexProfile, ...patch } as ProviderCodexModelProfile
    for (const key of Object.keys(profile) as Array<keyof ProviderCodexModelProfile>) if (profile[key] === undefined) delete profile[key]
    const profiles = { ...configuration.codex.modelProfiles }
    if (Object.keys(profile).length) profiles[codexModel] = profile
    else delete profiles[codexModel]
    onChange({ ...configuration, codex: { modelProfiles: Object.keys(profiles).length ? profiles : undefined } })
  }

  const updateOpenCode = (patch: Partial<Record<keyof ProviderOpenCodeModelProfile, unknown>>) => {
    if (!openCodeModel) return
    const profile = { ...openCodeProfile, ...patch } as ProviderOpenCodeModelProfile
    for (const key of Object.keys(profile) as Array<keyof ProviderOpenCodeModelProfile>) if (profile[key] === undefined) delete profile[key]
    const profiles = { ...configuration.openCode.modelProfiles }
    if (Object.keys(profile).length) profiles[openCodeModel] = profile
    else delete profiles[openCodeModel]
    onChange({ ...configuration, openCode: { ...configuration.openCode, modelProfiles: Object.keys(profiles).length ? profiles : undefined } })
  }

  const updateVariant = (name: string, patch?: Partial<ProviderOpenCodeVariant>) => {
    const variants = { ...openCodeProfile.variants }
    if (patch === undefined) delete variants[name]
    else {
      const variant = { ...variants[name], ...patch }
      for (const key of Object.keys(variant) as Array<keyof ProviderOpenCodeVariant>) {
        if (variant[key] === undefined || variant[key] === '') delete variant[key]
      }
      if (Object.keys(variant).length) variants[name] = variant
      else delete variants[name]
    }
    updateOpenCode({ variants: Object.keys(variants).length ? variants : undefined })
  }

  const renameVariant = (name: string, nextName: string) => {
    const trimmed = nextName.trim()
    if (!trimmed || trimmed === name || openCodeProfile.variants?.[trimmed]) return
    updateOpenCode({ variants: Object.fromEntries(Object.entries(openCodeProfile.variants ?? {}).map(([key, value]) => [key === name ? trimmed : key, value])) })
  }

  const addVariant = () => {
    let index = 1
    while (openCodeProfile.variants?.[`variant-${index}`]) index += 1
    updateVariant(`variant-${index}`, configuration.openCode.protocol === 'anthropic' ? { thinkingBudgetTokens: 4096 } : { reasoningEffort: 'high' })
  }

  const updateEffortWireValue = (effort: ProviderEffort, value: string) => {
    const effortWireMapping = { ...codexProfile.effortWireMapping }
    if (value.trim()) effortWireMapping[effort] = value
    else delete effortWireMapping[effort]
    updateCodex({ effortWireMapping: Object.keys(effortWireMapping).length ? effortWireMapping : undefined })
  }

  return <div className="mb-4 space-y-4">
    <fieldset className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
      <legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.claudeCapabilities')}</legend>
      {(['defaultOpusModel', 'defaultSonnetModel', 'defaultHaikuModel', 'subagentModel', 'effortLevel'] as const).map((key) => <label key={key} className="text-[11px] font-medium text-text-tertiary">{t(`providers.${key}`)}<input value={configuration.claude[key] ?? ''} onChange={(event) => onChange({ ...configuration, claude: { ...configuration.claude, [key]: event.target.value || undefined } })} className={fieldClass} /></label>)}
    </fieldset>

    <fieldset disabled={!codexModel} className="grid gap-4 rounded-xl border border-border p-4 disabled:opacity-60 sm:grid-cols-2">
      <legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.codexCapabilities')}</legend>
      <p className="text-xs text-text-tertiary sm:col-span-2">{codexModel ? t('providers.editingModelProfile', { model: codexModel }) : t('providers.capabilitiesNeedModel')}</p>
      <GroupHeading>{t('providers.modelLimits')}</GroupHeading>
      <NumberField label={t('providers.contextWindow')} value={codexProfile.contextWindow} onChange={(contextWindow) => updateCodex({ contextWindow })} />
      <NumberField label={t('providers.autoCompactTokenLimit')} value={codexProfile.autoCompactTokenLimit} onChange={(autoCompactTokenLimit) => updateCodex({ autoCompactTokenLimit })} />
      <GroupHeading>{t('providers.declaredCapabilities')}</GroupHeading>
      <label className="text-[11px] font-medium text-text-tertiary">{t('providers.thinking')}<select value={codexProfile.thinking ?? ''} onChange={(event) => updateCodex({ thinking: event.target.value || undefined })} className={fieldClass}><option value="">{t('providers.capabilityUnset')}</option>{['required', 'supported', 'unsupported', 'unknown'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label className="text-[11px] font-medium text-text-tertiary">{t('providers.promptCacheRouting')}<select value={codexProfile.promptCacheRouting ?? ''} onChange={(event) => updateCodex({ promptCacheRouting: event.target.value || undefined })} className={fieldClass}><option value="">{t('providers.capabilityUnset')}</option><option value="auto">auto</option><option value="unsupported">unsupported</option></select></label>
      <div className="sm:col-span-2">
        <span className="text-[11px] font-medium text-text-tertiary">{t('providers.supportedEfforts')}</span>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{EFFORTS.map((effort) => {
          const supported = codexProfile.supportedEfforts?.includes(effort) ?? false
          return <span key={effort} className="flex items-center gap-2"><label className="inline-flex min-w-20 items-center gap-1.5 text-xs"><input type="checkbox" checked={supported} onChange={(event) => {
            const nextEfforts = event.target.checked ? [...(codexProfile.supportedEfforts ?? []), effort] : codexProfile.supportedEfforts?.filter((value) => value !== effort) ?? []
            const effortWireMapping = { ...codexProfile.effortWireMapping }
            if (!event.target.checked) delete effortWireMapping[effort]
            updateCodex({ supportedEfforts: nextEfforts.length ? nextEfforts : undefined, effortWireMapping: Object.keys(effortWireMapping).length ? effortWireMapping : undefined })
          }} />{effort}</label>{supported && <input aria-label={`${effort} ${t('providers.wireValue')}`} placeholder={t('providers.wireValue')} value={codexProfile.effortWireMapping?.[effort] ?? ''} onChange={(event) => updateEffortWireValue(effort, event.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-xs" />}</span>
        })}</div>
      </div>
      <BooleanSelect label={t('providers.reasoningSummariesSupported')} value={codexProfile.supportsReasoningSummaries} onChange={(supportsReasoningSummaries) => updateCodex({ supportsReasoningSummaries })} />
      <GroupHeading>{t('providers.runtimeBehavior')}</GroupHeading>
      <label className="text-[11px] font-medium text-text-tertiary">{t('providers.reasoningSummary')}<select value={codexProfile.reasoningSummary ?? ''} onChange={(event) => updateCodex({ reasoningSummary: event.target.value || undefined })} className={fieldClass}><option value="">{t('providers.capabilityUnset')}</option>{['auto', 'concise', 'detailed', 'none'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label className="text-[11px] font-medium text-text-tertiary">{t('providers.verbosity')}<select value={codexProfile.verbosity ?? ''} onChange={(event) => updateCodex({ verbosity: event.target.value || undefined })} className={fieldClass}><option value="">{t('providers.capabilityUnset')}</option>{['low', 'medium', 'high'].map((value) => <option key={value}>{value}</option>)}</select></label>
    </fieldset>

    <fieldset disabled={!openCodeModel} className="grid gap-4 rounded-xl border border-border p-4 disabled:opacity-60 sm:grid-cols-2">
      <legend className="px-1 text-xs font-semibold text-text-primary">{t('providers.openCodeCapabilities')}</legend>
      <p className="text-xs text-text-tertiary sm:col-span-2">{openCodeModel ? t('providers.editingModelProfile', { model: openCodeModel }) : t('providers.capabilitiesNeedModel')}</p>
      <GroupHeading>{t('providers.modelLimits')}</GroupHeading>
      <NumberField label={t('providers.contextWindow')} value={openCodeProfile.contextWindow} onChange={(contextWindow) => updateOpenCode({ contextWindow })} />
      <NumberField label={t('providers.maxOutputTokens')} value={openCodeProfile.maxOutputTokens} onChange={(maxOutputTokens) => updateOpenCode({ maxOutputTokens })} />
      <GroupHeading>{t('providers.declaredCapabilities')}</GroupHeading>
      <BooleanSelect label={t('providers.reasoning')} value={openCodeProfile.reasoning} onChange={(reasoning) => updateOpenCode({ reasoning })} />
      <BooleanSelect label={t('providers.toolCall')} value={openCodeProfile.toolCall} onChange={(toolCall) => updateOpenCode({ toolCall })} />
      <label className="text-[11px] font-medium text-text-tertiary">{t('providers.inputModalities')}<span className="mt-2 flex gap-4">{(['text', 'image'] as const).map((modality) => <span key={modality} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={openCodeProfile.inputModalities?.includes(modality) ?? false} onChange={(event) => updateOpenCode({ inputModalities: event.target.checked ? [...(openCodeProfile.inputModalities ?? []), modality] : openCodeProfile.inputModalities?.filter((value) => value !== modality) || undefined })} />{modality}</span>)}</span></label>
      <label className="text-[11px] font-medium text-text-tertiary">{t('providers.outputModalities')}<span className="mt-2 flex gap-4"><span className="inline-flex items-center gap-1.5"><input type="checkbox" checked={openCodeProfile.outputModalities?.includes('text') ?? false} onChange={(event) => updateOpenCode({ outputModalities: event.target.checked ? ['text'] : undefined })} />text</span></span></label>
      <GroupHeading>{t('providers.runtimeBehavior')}</GroupHeading>
      {configuration.openCode.protocol === 'openai' && <label className="text-[11px] font-medium text-text-tertiary sm:col-span-2">{t('providers.reasoningField')}<select value={openCodeProfile.reasoningField ?? ''} onChange={(event) => updateOpenCode({ reasoningField: event.target.value || undefined })} className={fieldClass}><option value="">{t('providers.capabilityUnset')}</option>{['reasoning', 'reasoning_content', 'reasoning_details'].map((value) => <option key={value}>{value}</option>)}</select></label>}
      <div className="sm:col-span-2">
        <div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-medium text-text-tertiary">{t('providers.variants')}</span><button type="button" onClick={addVariant} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"><Plus className="h-3 w-3" />{t('providers.addVariant')}</button></div>
        <div className="space-y-2">{Object.entries(openCodeProfile.variants ?? {}).map(([name, variant]) => <div key={name} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input defaultValue={name} aria-label={t('providers.variantName')} onBlur={(event) => { const next = event.target.value.trim(); if (!next || (next !== name && openCodeProfile.variants?.[next])) event.currentTarget.value = name; else renameVariant(name, next) }} className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs" />
          {configuration.openCode.protocol === 'anthropic'
            ? <input type="number" min={1} value={variant.thinkingBudgetTokens ?? ''} aria-label={t('providers.thinkingBudgetTokens')} onChange={(event) => updateVariant(name, { thinkingBudgetTokens: numberValue(event.target.value) })} className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs sm:col-span-2" />
            : <><input value={variant.reasoningEffort ?? ''} aria-label={t('providers.reasoningEffort')} onChange={(event) => updateVariant(name, { reasoningEffort: event.target.value || undefined })} className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs" /><select value={variant.reasoningSummary ?? ''} aria-label={t('providers.reasoningSummary')} onChange={(event) => updateVariant(name, { reasoningSummary: event.target.value as ProviderOpenCodeVariant['reasoningSummary'] || undefined })} className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs"><option value="">{t('providers.noReasoningSummary')}</option>{['auto', 'concise', 'detailed', 'none'].map((value) => <option key={value}>{value}</option>)}</select></>}
          <button type="button" onClick={() => updateVariant(name)} aria-label={t('providers.removeVariant')} className="rounded-md p-1.5 text-text-tertiary hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
        </div>)}</div>
      </div>
    </fieldset>
  </div>
}
