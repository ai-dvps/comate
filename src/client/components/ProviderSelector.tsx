import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import { ChevronDown, Check, Loader2 } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

interface ProviderSelectorProps {
  workspaceId: string
  sessionId: string
  disabled?: boolean
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

export default function ProviderSelector({ workspaceId, sessionId, disabled = false }: ProviderSelectorProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const setSessionProvider = useChatStore((s) => s.setSessionProvider)

  const providers = useProviderStore((s) => s.providers)
  const defaultProvider = useProviderStore((s) => s.providers.find((p) => p.isDefault))
  const fetchProviders = useProviderStore((s) => s.fetchProviders)

  useEffect(() => {
    if (providers.length === 0) {
      fetchProviders()
    }
  }, [fetchProviders, providers.length])

  const currentProviderId = session?.providerId
  const currentProvider = providers.find((p) => p.id === currentProviderId)
  const isRestarting = useChatStore((s) => s.isRestartingRuntime[sessionId] ?? false)

  const handleSelect = (providerId: string | null) => {
    setSessionProvider(workspaceId, sessionId, providerId)
    setOpen(false)
  }

  const displayName = currentProvider?.name ?? defaultProvider?.name ?? t('provider.default')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-accent/10 border-accent/25 text-accent hover:bg-accent/20"
          title={t('provider.selectorTitle')}
        >
          <ProviderAvatar name={displayName} className="w-4 h-4 text-[9px]" />
          <span className="max-w-[120px] truncate">{displayName}</span>
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
          return (
            <button
              key={provider.id}
              onClick={() => handleSelect(provider.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
            >
              <ProviderAvatar name={provider.name} className="w-5 h-5 text-[10px] flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{provider.name}</div>
                <div className="text-[10px] text-text-tertiary truncate">{provider.baseUrl}</div>
              </div>
              <Check className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? '' : 'opacity-0'}`} />
            </button>
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
