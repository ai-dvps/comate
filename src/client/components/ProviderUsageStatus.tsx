import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import {
  hasUsageSupport,
  isBackendId,
  providerUsageAgent,
  useProviderUsageStore,
} from '../stores/provider-usage-store'

interface ProviderUsageStatusProps {
  sessionId: string
  workspaceId: string
}

export default function ProviderUsageStatus({
  sessionId,
  workspaceId,
}: ProviderUsageStatusProps) {
  const { t } = useTranslation('chat')
  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((item) => item.id === sessionId),
  )
  const providers = useProviderStore((s) => s.providers)
  const selectedProvider = providers.find((provider) => provider.id === session?.providerId)
  const defaultProvider = providers.find((provider) => provider.isDefault)
  const activeProvider = selectedProvider ?? defaultProvider
  const supportsUsage = activeProvider
    ? hasUsageSupport(activeProvider)
    : false
  const usage = useProviderUsageStore((s) =>
    activeProvider ? s.usageByProvider[activeProvider.id] : undefined,
  )
  const fetchUsage = useProviderUsageStore((s) => s.fetchUsage)
  const sessionAgent = isBackendId(session?.backend)
    ? session.backend
    : activeProvider ? providerUsageAgent(activeProvider) : 'claude'

  useEffect(() => {
    if (activeProvider && supportsUsage) {
      fetchUsage(activeProvider.id, { agent: sessionAgent })
    }
  }, [activeProvider, fetchUsage, sessionAgent, supportsUsage])

  if (!supportsUsage || usage?.status !== 'ready' || !usage.summary) {
    return null
  }

  const { used, total, remaining } = usage.summary
  const value =
    used !== null && total !== null
      ? `${used} / ${total}`
      : remaining !== null
        ? String(remaining)
        : null

  if (value === null) return null

  return (
    <span
      className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0"
      title={activeProvider?.name}
    >
      {t('provider.usage.label')}: {value}
    </span>
  )
}
