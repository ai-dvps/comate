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
  const resultMeta = useChatStore((s) => s.resultMeta[sessionId])
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

  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const metaLabel = [
    resultMeta?.stopReason,
    resultMeta?.terminalReason,
    resultMeta?.origin,
  ]
    .filter(Boolean)
    .join(' · ')

  if (fillPercentage === undefined) {
    return (
      <span className="text-[11px] text-text-tertiary">—</span>
    )
  }

  return (
    <>
      {hasSessionData && (
        <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
          {t('tokenUsage.session')}: in {fmt(cumulative.cumulativeInput)} / out{' '}
          {fmt(cumulative.cumulativeOutput)}
        </span>
      )}

      <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
        {t('tokenUsage.context')}: {fillPercentage}%
      </span>

      {metaLabel && (
        <span
          className="text-[11px] text-text-tertiary/60 whitespace-nowrap shrink-0"
          title={metaLabel}
        >
          {metaLabel}
        </span>
      )}
    </>
  )
}
