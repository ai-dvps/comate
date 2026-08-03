import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, Loader2, RefreshCw, Server } from 'lucide-react'
import { useSkillsStore, type SkillProviderFailureReason } from '../../stores/skills-store'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

interface SkillProviderFilterProps {
  onSelectionChange: () => void
}

const reasonKeys: Record<SkillProviderFailureReason, string> = {
  network: 'skills.providerReasonNetwork',
  timeout: 'skills.providerReasonTimeout',
  http: 'skills.providerReasonHttp',
  'invalid-response': 'skills.providerReasonInvalidResponse',
}

export default function SkillProviderFilter({ onSelectionChange }: SkillProviderFilterProps) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const {
    searchProviders,
    selectedSearchProviderIds,
    newSearchProviderIds,
    checkingSearchProviderIds,
    isCheckingSearchProviders,
    setSearchProviderSelected,
    retrySearchProvider,
  } = useSkillsStore()
  const unavailableSelected = searchProviders.some(
    ({ id, status }) => selectedSearchProviderIds.includes(id) && status === 'unavailable'
  )
  const triggerLabel = t('skills.providerFilterLabel', {
    selected: selectedSearchProviderIds.length,
    total: searchProviders.length,
  })
  const isInitialCheck = isCheckingSearchProviders && searchProviders.length === 0
  const TriggerIcon = isInitialCheck ? Loader2 : unavailableSelected ? AlertTriangle : Server

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          aria-expanded={open}
          className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border bg-bg px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/20 ${
            unavailableSelected
              ? 'border-warning/50 text-warning'
              : 'border-border text-text-secondary hover:border-text-tertiary'
          }`}
        >
          <TriggerIcon className={`h-3.5 w-3.5 ${isInitialCheck ? 'animate-spin' : ''}`} />
          <span>{searchProviders.length === 0 ? t('skills.checkingProviders') : triggerLabel}</span>
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-2 shadow-xl"
      >
        <div role="group" aria-label={t('skills.providerGroupLabel')} className="space-y-1">
          <div className="px-2 pb-1 pt-0.5">
            <p className="text-xs font-semibold text-text-primary">{t('skills.providerHeading')}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">{t('skills.providerDescription')}</p>
          </div>
          {searchProviders.map((provider) => {
            const selected = selectedSearchProviderIds.includes(provider.id)
            const checking = checkingSearchProviderIds.includes(provider.id)
            const unavailable = provider.status === 'unavailable'
            let statusText = t('skills.providerAvailable')
            if (checking) statusText = t('skills.providerChecking')
            else if (unavailable) statusText = t(reasonKeys[provider.reason || 'network'])
            return (
              <div key={provider.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-hover">
                <input
                  type="checkbox"
                  checked={selected}
                  aria-label={provider.label}
                  onChange={(event) => {
                    setSearchProviderSelected(provider.id, event.target.checked)
                    onSelectionChange()
                  }}
                  className="h-4 w-4 shrink-0 rounded border-border accent-accent focus:ring-2 focus:ring-accent/30"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-text-primary">{provider.label}</span>
                    {newSearchProviderIds.includes(provider.id) && (
                      <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                        {t('skills.providerNew')}
                      </span>
                    )}
                  </div>
                  <p className={`mt-0.5 text-[10px] ${unavailable ? 'text-warning' : 'text-success'}`} aria-live="polite">
                    {statusText}
                  </p>
                </div>
                {unavailable && (
                  <button
                    type="button"
                    onClick={() => void retrySearchProvider(provider.id)}
                    disabled={checking}
                    aria-label={t('skills.retryProvider', { provider: provider.label })}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[10px] font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                  >
                    {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    {t('skills.retry')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
