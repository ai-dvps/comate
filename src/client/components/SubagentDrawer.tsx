import { useEffect } from 'react'
import {
  X,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  Bot,
  WrenchIcon,
} from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { cn } from './ui/utils'
import SubagentConversation from './SubagentConversation'

interface SubagentDrawerProps {
  parentToolUseId: string | null
  sessionId: string
  onClose: () => void
}

export default function SubagentDrawer({
  parentToolUseId,
  sessionId,
  onClose,
}: SubagentDrawerProps) {
  const subagent = useChatStore((s) =>
    parentToolUseId
      ? (s.subagents[sessionId] || []).find(
          (sa) => sa.parentToolUseId === parentToolUseId,
        )
      : undefined,
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

  if (!parentToolUseId || !subagent) return null

  const statusConfig = {
    running: {
      icon: <ClockIcon className="size-4 animate-pulse text-amber-500" />,
      label: 'Running',
      badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    },
    completed: {
      icon: <CheckCircleIcon className="size-4 text-green-600" />,
      label: 'Completed',
      badgeClass: 'bg-green-500/10 text-green-600 border-green-500/20',
    },
    error: {
      icon: <XCircleIcon className="size-4 text-red-600" />,
      label: 'Error',
      badgeClass: 'bg-red-500/10 text-red-600 border-red-500/20',
    },
  }

  const config = statusConfig[subagent.state]
  const duration = formatDuration(
    (subagent.endTime || Date.now()) - subagent.startTime,
  )

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 bg-black/40"
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
                  {config.label}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
                <span>{duration}</span>
                <span className="text-text-tertiary">•</span>
                <span className="flex items-center gap-1">
                  <WrenchIcon className="size-3" />
                  {subagent.toolCount} tool
                  {subagent.toolCount !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Close"
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = seconds % 60
  return `${minutes}m ${remSeconds}s`
}
