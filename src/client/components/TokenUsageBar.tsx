import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, GitBranch } from 'lucide-react'
import { useChatStore } from '../stores/chat-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useProviderStore } from '../stores/provider-store'
import { getContextWindowForModel } from '../utils/model-context'

interface TokenUsageBarProps {
  sessionId: string
  workspaceId: string
  modelUsage?: Record<string, unknown>
}

export default function TokenUsageBar({
  sessionId,
  workspaceId,
  modelUsage,
}: TokenUsageBarProps) {
  const { t } = useTranslation('chat')
  const lastTurn = useChatStore((s) => s.lastTurnUsage[sessionId])
  const cumulative = useChatStore((s) => s.sessionUsage[sessionId])

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId),
  )
  const session = useChatStore((s) =>
    s.sessions[workspaceId]?.find((ses) => ses.id === sessionId),
  )
  const providers = useProviderStore((s) => s.providers)
  const activeProvider = providers.find((p) => p.id === session?.providerId)
  const modelName = activeProvider?.model || activeProvider?.name || 'claude-sonnet-4-6'

  const contextWindow = getContextWindowForModel(modelName, modelUsage)

  const hasData = !!cumulative

  const totalTokens = hasData
    ? cumulative.cumulativeInput +
      cumulative.cumulativeCacheRead +
      cumulative.cumulativeCacheWrite
    : 0

  const fillPercentage = Math.min(
    Math.round((totalTokens / contextWindow) * 100),
    100,
  )

  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const [gitRef, setGitRef] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setGitRef(null)
      return
    }

    const fetchGitRef = () => {
      fetch(`/api/workspaces/${workspaceId}/git-ref`)
        .then((res) => res.json())
        .then((data: { ref?: string | null }) => setGitRef(data.ref ?? null))
        .catch(() => setGitRef(null))
    }

    fetchGitRef()
    const interval = setInterval(fetchGitRef, 10000)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchGitRef()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const handleFocus = () => {
      fetchGitRef()
    }
    window.addEventListener('focus', handleFocus)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [workspaceId])

  const folderPath = workspace?.folderPath

  return (
    <div className="flex items-center justify-between px-4 py-1.5 border-t border-border/20 gap-3">
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        {/* Workspace path and git ref */}
        {folderPath && (
          <span className="flex items-center gap-1 min-w-0">
            <Folder className="w-3 h-3 text-text-tertiary shrink-0" />
            <span
              className="text-[11px] text-text-tertiary truncate max-w-[200px]"
              title={folderPath}
            >
              {folderPath}
            </span>
          </span>
        )}
        {gitRef && (
          <span className="flex items-center gap-1 text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
            <GitBranch className="w-3 h-3" />
            {gitRef}
          </span>
        )}
        {hasData && lastTurn && (
          <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
            {t('tokenUsage.turn')}: {fmt(lastTurn.inputTokens)} /{' '}
            {fmt(lastTurn.outputTokens)}
            {lastTurn.cacheReadTokens > 0 &&
              ` / ${fmt(lastTurn.cacheReadTokens)}`}
            {lastTurn.cacheWriteTokens > 0 &&
              ` / ${fmt(lastTurn.cacheWriteTokens)}`}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        {!hasData ? (
          <span className="text-[11px] text-text-tertiary">—</span>
        ) : (
          <>
            {/* Cumulative */}
            <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
              {t('tokenUsage.session')}: {fmt(cumulative.cumulativeInput)} /{' '}
              {fmt(cumulative.cumulativeOutput)}
              {cumulative.cumulativeCacheRead > 0 &&
                ` / ${fmt(cumulative.cumulativeCacheRead)}`}
              {cumulative.cumulativeCacheWrite > 0 &&
                ` / ${fmt(cumulative.cumulativeCacheWrite)}`}
            </span>

            {/* Context fill */}
            <span className="text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
              {t('tokenUsage.context')}: {fillPercentage}%
            </span>
          </>
        )}
      </div>
    </div>
  )
}
