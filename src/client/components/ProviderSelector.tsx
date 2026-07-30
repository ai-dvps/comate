import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import {
  useProviderUsageStore,
  hasUsageSupport,
  formatRemaining,
  usagePercentage,
  usageBarColor,
} from '../stores/provider-usage-store'
import { ChevronDown, Check, Loader2 } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { cn } from './ui/utils'

interface ProviderSelectorProps {
  workspaceId: string
  sessionId: string
  disabled?: boolean
  hideNameBelowSm?: boolean
}

function ProviderAvatar({ name, className = '' }: { name: string; className?: string }) {
  const initial = name.charAt(0).toUpperCase()
  return (
    <div
      className={`flex items-center justify-center rounded-full bg-accent/15 text-accent font-semibold ${className}`}
    >
      {initial}
    </div>
  )
}

/** Minimal glanceable usage line + login affordance for a Kimi coding-plan provider. */
function ProviderUsageLine({
  providerId,
  onLogin,
}: {
  providerId: string
  onLogin: () => void
}) {
  const { t } = useTranslation('chat')
  const entry = useProviderUsageStore((s) => s.usageByProvider[providerId])
  const startLogin = useProviderUsageStore((s) => s.startUsageLogin)
  const loginOpen = useProviderUsageStore((s) => s.login !== null)
  const status = entry?.status ?? 'idle'

  if (status === 'fetching') {
    return <span className="text-[10px] text-text-tertiary">…</span>
  }
  if (status === 'ready' && entry?.summary) {
    const text = formatRemaining(entry.summary.remaining)
    if (!text) return null
    const pct = usagePercentage(entry.summary)
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-1 w-12 rounded-full bg-border overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-300', usageBarColor(pct))}
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
        <span className="text-[10px] text-text-tertiary whitespace-nowrap">{text}</span>
      </div>
    )
  }
  if (status === 'relogin' || status === 'idle') {
    return (
      <button
        type="button"
        disabled={loginOpen}
        onClick={(e) => {
          e.stopPropagation()
          startLogin(providerId)
          onLogin()
        }}
        className="text-[10px] text-accent hover:underline disabled:opacity-50"
      >
        {status === 'idle'
          ? t('provider.usage.connect', 'Connect')
          : t('provider.usage.reconnect', 'Reconnect')}
      </button>
    )
  }
  if (status === 'no-plan') {
    return <span className="text-[10px] text-text-tertiary">{t('provider.usage.noPlan', 'No coding plan')}</span>
  }
  // error / unsupported → nothing
  return null
}

export default function ProviderSelector({ workspaceId, sessionId, disabled = false, hideNameBelowSm = false }: ProviderSelectorProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const setSessionProvider = useChatStore((s) => s.setSessionProvider)

  const providers = useProviderStore((s) => s.providers)
  const defaultProvider = useProviderStore((s) => s.providers.find((p) => p.isDefault))
  const fetchProviders = useProviderStore((s) => s.fetchProviders)
  const fetchUsage = useProviderUsageStore((s) => s.fetchUsage)

  useEffect(() => {
    if (providers.length === 0) {
      fetchProviders()
    }
  }, [fetchProviders, providers.length])

  // On open, fetch usage for each Kimi coding-plan provider (on-demand; the
  // client throttle + server 24h cache prevent over-fetching). Never auto-open
  // the login modal — that only happens on explicit click (R3).
  useEffect(() => {
    if (!open) return
    for (const provider of providers) {
      if (hasUsageSupport(provider.baseUrl)) {
        fetchUsage(provider.id)
      }
    }
  }, [open, providers, fetchUsage])

  const currentProviderId = session?.providerId
  const currentProvider = providers.find((p) => p.id === currentProviderId)
  const isRestarting = useChatStore((s) => s.isRestartingRuntime[sessionId] ?? false)

  const handleSelect = (providerId: string | null) => {
    setSessionProvider(workspaceId, sessionId, providerId)
    setOpen(false)
  }

  const handleRowKey = (e: React.KeyboardEvent, providerId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleSelect(providerId)
    }
  }

  const displayName = currentProvider?.name ?? defaultProvider?.name ?? t('provider.default')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed text-accent hover:bg-surface-hover"
          title={t('provider.selectorTitle')}
        >
          <ProviderAvatar name={displayName} className="w-4 h-4 text-[9px]" />
          <span className={`max-w-[120px] truncate ${hideNameBelowSm ? 'hidden sm:inline' : ''}`}>{displayName}</span>
          {isRestarting ? (
            <Loader2 className="w-3 h-3 animate-spin opacity-60" />
          ) : (
            <ChevronDown className="w-3 h-3 opacity-60" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="bg-surface-active border border-border rounded-lg shadow-lg p-1 z-50 min-w-[200px]"
      >
        <div className="px-2 py-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
          {t('provider.selectProvider')}
        </div>
        {providers.map((provider) => {
          const isActive = provider.id === currentProviderId
          const showUsage = hasUsageSupport(provider.baseUrl)
          return (
            <div
              key={provider.id}
              role="button"
              tabIndex={0}
              onClick={() => handleSelect(provider.id)}
              onKeyDown={(e) => handleRowKey(e, provider.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors cursor-pointer ${
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <ProviderAvatar name={provider.name} className="w-5 h-5 text-[10px] flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{provider.name}</div>
                <div className="text-[10px] text-text-tertiary truncate">{provider.baseUrl}</div>
                {showUsage && (
                  <div className="mt-0.5">
                    <ProviderUsageLine providerId={provider.id} onLogin={() => setOpen(false)} />
                  </div>
                )}
              </div>
              <Check className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? '' : 'opacity-0'}`} />
            </div>
          )
        })}
        {providers.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-text-tertiary text-center">
            {t('provider.noProviders')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
