import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, type ContextUsage } from '../stores/chat-store'
import { BarChart3, Loader2, X } from 'lucide-react'
import { cn } from './ui/utils'

interface ContextUsagePanelProps {
  sessionId: string
  workspaceId: string
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export default function ContextUsagePanel({ sessionId, workspaceId }: ContextUsagePanelProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchContextUsage = useChatStore((s) => s.fetchContextUsage)
  const usage = useChatStore((s) => s.contextUsage[sessionId])

  useEffect(() => {
    if (!isOpen) return
    setIsLoading(true)
    setError(null)
    fetchContextUsage(workspaceId, sessionId)
      .then((result) => {
        if (!result.ok) {
          setError(result.error ?? t('contextUsageFailed'))
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setIsLoading(false))
  }, [isOpen, sessionId, workspaceId, fetchContextUsage, t])

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        title={t('contextUsage')}
        className={cn(
          'flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors',
          isOpen && 'text-accent',
        )}
      >
        <BarChart3 className="w-3.5 h-3.5" />
        {usage ? `${usage.percentage}%` : t('contextUsage')}
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-surface-active border border-border rounded-lg shadow-lg p-3 z-50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-primary">{t('contextUsage')}</span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-text-tertiary hover:text-text-secondary"
              aria-label={t('close')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {isLoading && (
            <div className="flex items-center justify-center py-4 text-text-tertiary">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              <span className="text-xs">{t('loadingContextUsage')}</span>
            </div>
          )}

          {!isLoading && error && (
            <div className="text-xs text-text-tertiary py-2">{error}</div>
          )}

          {!isLoading && !error && usage && (
            <UsageBreakdown usage={usage} />
          )}
        </div>
      )}
    </div>
  )
}

function UsageBreakdown({ usage }: { usage: ContextUsage }) {
  const { t } = useTranslation('chat')
  const clampedPercentage = Math.min(Math.max(usage.percentage, 0), 100)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-text-secondary">
        <span>
          {fmtTokens(usage.totalTokens)} / {fmtTokens(usage.maxTokens)} {t('tokens')}
        </span>
        <span>{usage.percentage}%</span>
      </div>

      <div className="h-2 w-full bg-surface-hover rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            clampedPercentage > 90 ? 'bg-red-500' : clampedPercentage > 70 ? 'bg-amber-500' : 'bg-accent',
          )}
          style={{ width: `${clampedPercentage}%` }}
        />
      </div>

      {usage.categories.length > 0 && (
        <ul className="space-y-1 pt-1 max-h-48 overflow-y-auto">
          {usage.categories.map((category) => (
            <li key={category.name} className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 min-w-0">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: category.color || 'var(--color-text-tertiary)' }}
                />
                <span className="truncate text-text-secondary">{category.name}</span>
              </span>
              <span className="text-text-tertiary whitespace-nowrap ml-2">{fmtTokens(category.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
