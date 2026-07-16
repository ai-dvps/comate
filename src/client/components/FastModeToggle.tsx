import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'

interface FastModeToggleProps {
  workspaceId: string
  sessionId: string
  disabled?: boolean
}

export default function FastModeToggle({ workspaceId, sessionId, disabled = false }: FastModeToggleProps) {
  const { t } = useTranslation('chat')

  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const setSessionFastMode = useChatStore((s) => s.setSessionFastMode)

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
  const activeProvider = currentProvider ?? defaultProvider

  // Default to enabled when no provider has loaded yet; the actual capability
  // gate is applied once provider data arrives.
  const supportsFastMode = activeProvider?.supportsFastMode !== false
  const isFastMode = session?.fastMode === true
  const isDisabled = disabled || !supportsFastMode

  const handleToggle = () => {
    if (isDisabled) return
    setSessionFastMode(workspaceId, sessionId, !isFastMode)
  }

  const tooltipText = supportsFastMode
    ? t('fastMode.title')
    : t('fastMode.unsupportedTooltip')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={isDisabled}
          aria-pressed={isFastMode}
          aria-label={t('fastMode.title')}
          onClick={handleToggle}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            isFastMode
              ? 'text-accent hover:bg-surface-hover'
              : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
          }`}
        >
          <Zap className={`w-3 h-3 ${isFastMode ? 'fill-current' : ''}`} />
          <span className="hidden sm:inline">{isFastMode ? t('fastMode.on') : t('fastMode.off')}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" sideOffset={6}>
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  )
}
