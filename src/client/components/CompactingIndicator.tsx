import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { useElapsed } from '../hooks/use-elapsed'
import { cn } from './ui/utils'

interface CompactingIndicatorProps {
  sessionId: string
  className?: string
}

export default function CompactingIndicator({
  sessionId,
  className,
}: CompactingIndicatorProps) {
  const { t } = useTranslation('chat')
  const isCompacting = useChatStore((s) => s.isCompacting[sessionId] || false)
  const compactingStartTime = useChatStore(
    (s) => s.compactingStartTime[sessionId] || 0,
  )
  const elapsed = useElapsed(compactingStartTime, undefined, isCompacting)

  if (!isCompacting) return null

  return (
    <div
      className={cn('my-2', className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-xs text-text-tertiary">
        <Sparkles className="size-3.5" />
        <span>{t('compactingConversation', 'Compacting conversation…')}</span>
        <span className="tabular-nums">{elapsed}</span>
      </div>
      <div className="mt-1.5 bg-surface rounded-full h-1.5 w-full overflow-hidden">
        <div className="h-full bg-accent rounded-full w-1/3 animate-indeterminate-progress" />
      </div>
    </div>
  )
}
