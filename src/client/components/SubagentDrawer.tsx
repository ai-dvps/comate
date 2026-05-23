import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  Bot,
  WrenchIcon,
} from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { formatDuration } from '../lib/time'
import { cn } from './ui/utils'
import SubagentConversation from './SubagentConversation'

interface SubagentDrawerProps {
  parentToolUseId: string
  sessionId: string
  onClose: () => void
}

const statusConfig = {
  running: {
    icon: <ClockIcon className="size-4 animate-pulse text-warning" />,
    labelKey: 'subagentStatus.running',
    badgeClass: 'bg-warning/10 text-warning border-warning/20',
  },
  completed: {
    icon: <CheckCircleIcon className="size-4 text-success" />,
    labelKey: 'subagentStatus.completed',
    badgeClass: 'bg-success/10 text-success border-success/20',
  },
  error: {
    icon: <XCircleIcon className="size-4 text-destructive" />,
    labelKey: 'subagentStatus.error',
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
  },
}

export default function SubagentDrawer({
  parentToolUseId,
  sessionId,
  onClose,
}: SubagentDrawerProps) {
  const { t } = useTranslation('chat')
  const subagent = useChatStore((s) =>
    (s.subagents[sessionId] || []).find(
      (sa) => sa.parentToolUseId === parentToolUseId,
    ),
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (parentToolUseId) {
      window.addEventListener('keydown', onKey)
    }
    return () => window.removeEventListener('keydown', onKey)
  }, [parentToolUseId, onClose])

  if (!subagent) return null

  const config = statusConfig[subagent.state]
  const duration = formatDuration(
    (subagent.endTime || Date.now()) - subagent.startTime,
  )

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 bg-overlay/40"
        style={{ top: '3rem' }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-surface shadow-2xl',
          'h-[50vh] max-h-[600px] min-h-[300px]',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-3 flex-shrink-0">
          <div className="flex min-w-0 items-center gap-3">
            <Bot className="size-5 shrink-0 text-text-tertiary" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-text-primary">
                  {subagent.description}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                    config.badgeClass,
                  )}
                >
                  {config.icon}
                  {t(config.labelKey)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
                <span>{duration}</span>
                <span className="text-text-tertiary">•</span>
                <span className="flex items-center gap-1">
                  <WrenchIcon className="size-3" />
                  {t('toolCount', { count: subagent.toolCount })}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title={t('close')}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Conversation */}
        <SubagentConversation
          messages={subagent.messages}
          isRunning={subagent.state === 'running'}
        />
      </div>
    </>
  )
}
