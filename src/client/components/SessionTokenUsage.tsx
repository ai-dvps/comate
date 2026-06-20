import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chat-store'
import { useProviderStore } from '../stores/provider-store'
import { getContextWindowForModel } from '../utils/model-context'

interface SessionTokenUsageProps {
  sessionId: string
  workspaceId: string
  modelUsage?: Record<string, unknown>
}

export default function SessionTokenUsage({
  sessionId,
  workspaceId,
  modelUsage,
}: SessionTokenUsageProps) {
  const { t } = useTranslation('chat')
  const cumulative = useChatStore((s) => s.sessionUsage[sessionId])
  const contextUsage = useChatStore((s) => s.contextUsage[sessionId])
  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const providers = useProviderStore((s) => s.providers)
  const activeProvider = providers.find((p) => p.id === session?.providerId)
  const modelName =
    activeProvider?.model || activeProvider?.name || 'claude-sonnet-4-6'

  const contextWindow = getContextWindowForModel(modelName, modelUsage)
  const hasSessionData = !!cumulative
  const hasContextUsage = !!contextUsage

  const fillPercentage = hasContextUsage
    ? contextUsage.percentage
    : hasSessionData
      ? Math.min(
          Math.round((cumulative.cumulativeInput / contextWindow) * 100),
          100,
        )
      : undefined

  if (fillPercentage === undefined) {
    return (
      <span className="text-[11px] text-text-tertiary">—</span>
    )
  }

  return (
    <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
      {t('tokenUsage.context')}: {fillPercentage}%
    </span>
  )
}
