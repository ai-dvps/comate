import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import { useBackendStore, type BackendId, type CodexModel } from '../stores/backend-store'
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

interface ProviderSelectorCommonProps {
  workspaceId: string
  disabled?: boolean
  hideNameBelowSm?: boolean
}

interface SessionProviderSelectorProps extends ProviderSelectorCommonProps {
  mode?: 'session'
  sessionId: string
}

interface NewChatProviderSelectorProps extends ProviderSelectorCommonProps {
  mode: 'new-chat'
  backendId?: BackendId | null
  providerId: string | null
  onProviderChange: (providerId: string | null) => void
  codexModel?: string | null
  codexEffort?: string | null
  codexSpeed?: string | null
  onCodexSettingsChange?: (settings: CodexSettingsSelection) => void
}

type ProviderSelectorProps = SessionProviderSelectorProps | NewChatProviderSelectorProps

interface CodexSettingsSelection {
  codexModel: string | null
  codexEffort: string | null
  codexSpeed: string | null
}

function CodexSettingsControls({
  models,
  selection,
  defaults,
  onChange,
}: {
  models: CodexModel[]
  selection: CodexSettingsSelection
  defaults: { model: string | null; effort: string | null; speed: string | null }
  onChange: (settings: CodexSettingsSelection) => void
}) {
  const { t } = useTranslation('chat')
  const effectiveModel = selection.codexModel ?? defaults.model
  const selectedModel = models.find((model) => model.model === effectiveModel)
    ?? models.find((model) => model.isDefault)
  const selectClass = 'h-8 w-full rounded-md border border-border bg-bg px-2 text-[11px] text-text-primary outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20'

  return (
    <div className="grid gap-2 border-t border-border/70 px-2.5 py-2.5">
      <label className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-[11px] text-text-tertiary">
        <span>{t('provider.codexModel')}</span>
        <select
          value={selection.codexModel ?? ''}
          onChange={(event) => onChange({
            codexModel: event.target.value || null,
            codexEffort: null,
            codexSpeed: null,
          })}
          className={selectClass}
        >
          <option value="">{t('provider.codexUseDefault')}</option>
          {models.map((model) => (
            <option key={model.id} value={model.model}>{model.displayName}</option>
          ))}
        </select>
      </label>
      <label className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-[11px] text-text-tertiary">
        <span>{t('provider.codexEffort')}</span>
        <select
          value={selection.codexEffort ?? ''}
          onChange={(event) => onChange({ ...selection, codexEffort: event.target.value || null })}
          className={selectClass}
        >
          <option value="">{t('provider.codexUseDefault')}</option>
          {selectedModel?.supportedReasoningEfforts.map((option) => (
            <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>
          ))}
        </select>
      </label>
      <label className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-[11px] text-text-tertiary">
        <span>{t('provider.codexSpeed')}</span>
        <select
          value={selection.codexSpeed ?? ''}
          onChange={(event) => onChange({ ...selection, codexSpeed: event.target.value || null })}
          className={selectClass}
        >
          <option value="">{t('provider.codexUseDefault')}</option>
          {selectedModel?.serviceTiers.map((tier) => (
            <option key={tier.id} value={tier.id}>{tier.name}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

function ProviderAvatar({ name, className = '' }: { name: string; className?: string }) {
  const initial = name.charAt(0).toUpperCase()
  return (
    <div
      className={`flex items-center justify-center rounded-full bg-surface-active text-text-secondary font-semibold ${className}`}
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

export default function ProviderSelector(props: ProviderSelectorProps) {
  const { workspaceId, disabled = false, hideNameBelowSm = false } = props
  const isNewChat = props.mode === 'new-chat'
  const sessionId = isNewChat ? null : props.sessionId
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  const session = useChatStore((s) =>
    sessionId ? s.sessions[workspaceId]?.find((ses) => ses.id === sessionId) : undefined,
  )
  const setSessionProvider = useChatStore((s) => s.setSessionProvider)
  const setSessionCodexSettings = useChatStore((s) => s.setSessionCodexSettings)

  const providers = useProviderStore((s) => s.providers)
  const defaultProvider = useProviderStore((s) => s.providers.find((p) => p.isDefault))
  const fetchProviders = useProviderStore((s) => s.fetchProviders)
  const fetchUsage = useProviderUsageStore((s) => s.fetchUsage)
  const defaultBackend = useBackendStore((s) => s.defaultBackend)
  const codexAccount = useBackendStore((s) => s.codexAccount)
  const codexModels = useBackendStore((s) => s.codexModels)
  const codexDefaultModel = useBackendStore((s) => s.codexDefaultModel)
  const codexDefaultEffort = useBackendStore((s) => s.codexDefaultEffort)
  const codexDefaultSpeed = useBackendStore((s) => s.codexDefaultSpeed)
  const fetchCodexAccount = useBackendStore((s) => s.fetchCodexAccount)
  const fetchCodexModels = useBackendStore((s) => s.fetchCodexModels)
  const activeBackend = (isNewChat ? props.backendId : session?.backend) ?? defaultBackend ?? 'claude'

  useEffect(() => {
    if (providers.length === 0) {
      fetchProviders()
    }
  }, [fetchProviders, providers.length])

  useEffect(() => {
    if (activeBackend !== 'codex') return
    void fetchCodexAccount()
  }, [activeBackend, fetchCodexAccount])

  useEffect(() => {
    if (activeBackend === 'codex' && codexAccount && codexModels.length === 0) {
      void fetchCodexModels()
    }
  }, [activeBackend, codexAccount, codexModels.length, fetchCodexModels])

  // On open, fetch usage for each Kimi coding-plan provider (on-demand; the
  // client throttle prevents over-fetching, and the server always fetches
  // live). Never auto-open the login modal — that only happens on explicit
  // click (R3).
  useEffect(() => {
    if (!open) return
    for (const provider of providers) {
      if (hasUsageSupport(provider.baseUrl)) {
        fetchUsage(provider.id)
      }
    }
  }, [open, providers, fetchUsage])

  const currentProviderId = isNewChat ? props.providerId : session?.providerId
  const availableProviders = activeBackend === 'codex'
    ? providers.filter((provider) => provider.protocol === 'openai-responses')
    : providers
  const currentProvider = availableProviders.find((p) => p.id === currentProviderId)
  const isRestarting = useChatStore((s) => sessionId ? s.isRestartingRuntime[sessionId] ?? false : false)

  const handleSelect = (providerId: string | null) => {
    if (isNewChat) {
      props.onProviderChange(providerId)
    } else {
      void setSessionProvider(workspaceId, props.sessionId, providerId)
    }
    setOpen(false)
  }

  const codexSelection: CodexSettingsSelection = isNewChat
    ? {
        codexModel: props.codexModel ?? null,
        codexEffort: props.codexEffort ?? null,
        codexSpeed: props.codexSpeed ?? null,
      }
    : {
        codexModel: session?.codexModel ?? null,
        codexEffort: session?.codexEffort ?? null,
        codexSpeed: session?.codexSpeed ?? null,
      }
  const handleCodexSettingsChange = (settings: CodexSettingsSelection) => {
    if (isNewChat) props.onCodexSettingsChange?.(settings)
    else void setSessionCodexSettings(workspaceId, props.sessionId, settings).catch(() => undefined)
  }

  const handleRowKey = (e: React.KeyboardEvent, providerId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleSelect(providerId)
    }
  }

  const nativeCodexActive = Boolean(activeBackend === 'codex' && codexAccount && !currentProviderId)
  const displayName = nativeCodexActive
    ? t('provider.codexAccount')
    : currentProvider?.name ?? (activeBackend === 'codex' ? t('provider.selectProvider') : defaultProvider?.name) ?? t('provider.default')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed text-text-secondary hover:bg-surface-hover hover:text-text-primary"
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
        {activeBackend === 'codex' && codexAccount && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => handleSelect(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleSelect(null)
              }
            }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors cursor-pointer ${
              nativeCodexActive ? 'bg-surface-active text-text-primary' : 'text-text-secondary hover:bg-surface-hover'
            }`}
          >
            <ProviderAvatar name="Codex" className="w-5 h-5 text-[10px] flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{t('provider.codexAccount')}</div>
              <div className="text-[10px] text-text-tertiary truncate">{t('provider.codexManagedByCodex')}</div>
            </div>
            <Check className={`w-3.5 h-3.5 flex-shrink-0 ${nativeCodexActive ? '' : 'opacity-0'}`} />
          </div>
        )}
        {availableProviders.map((provider) => {
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
                  ? 'bg-surface-active text-text-primary'
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
        {availableProviders.length === 0 && !(activeBackend === 'codex' && codexAccount) && (
          <div className="px-2.5 py-2 text-xs text-text-tertiary text-center">
            {t('provider.noProviders')}
          </div>
        )}
        {nativeCodexActive && codexModels.length > 0 && (
          <CodexSettingsControls
            models={codexModels}
            selection={codexSelection}
            defaults={{
              model: codexDefaultModel,
              effort: codexDefaultEffort,
              speed: codexDefaultSpeed,
            }}
            onChange={handleCodexSettingsChange}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
