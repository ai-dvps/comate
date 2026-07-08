import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  Bot,
  WrenchIcon,
  Rocket,
} from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { formatDuration } from '../lib/time'
import { cn } from './ui/utils'
import SubagentConversation from './SubagentConversation'
import {
  getSubagentDisplayState,
  type SubagentDisplayState,
} from '../lib/subagent-display'
import type { MessagePart } from '../types/message'

interface SubagentDrawerProps {
  parentToolUseId: string
  sessionId: string
  width: number
  onClose: () => void
  onWidthChange: (width: number) => void
}

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

const MIN_WIDTH = 300
const MAX_WIDTH = 600

const statusConfig: Record<
  SubagentDisplayState,
  {
    icon: React.ReactNode
    labelKey: string
    badgeClass: string
  }
> = {
  async_launched: {
    icon: <Rocket className="size-4 text-accent" />,
    labelKey: 'subagentStatus.asyncLaunched',
    badgeClass: 'bg-accent/10 text-accent border-accent/20',
  },
  running_in_background: {
    icon: <ClockIcon className="size-4 animate-pulse text-warning" />,
    labelKey: 'subagentStatus.runningInBackground',
    badgeClass: 'bg-warning/10 text-warning border-warning/20',
  },
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
  width,
  onClose,
  onWidthChange,
}: SubagentDrawerProps) {
  const { t } = useTranslation('chat')
  const subagent = useChatStore((s) =>
    (s.subagents[sessionId] || []).find(
      (sa) => sa.parentToolUseId === parentToolUseId,
    ),
  )
  const result = useChatStore((s) => {
    const messages = s.messages[sessionId] || []
    for (const m of messages) {
      const part = m.parts.find(
        (p): p is ToolResultPart =>
          p?.type === 'tool_result' && p.toolUseId === parentToolUseId,
      )
      if (part) return part
    }
    return undefined
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    if (parentToolUseId) {
      window.addEventListener('keydown', onKey)
    }
    return () => window.removeEventListener('keydown', onKey)
  }, [parentToolUseId, onClose])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        const newWidth = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, startWidth + delta),
        )
        onWidthChange(newWidth)
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [width, onWidthChange],
  )

  const displayState = useMemo(
    () => getSubagentDisplayState(subagent ?? undefined, result),
    [subagent, result],
  )
  const config = statusConfig[displayState]

  return (
    <aside
      className="relative bg-surface border-l border-border flex flex-col flex-shrink-0 h-full"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3 flex-shrink-0">
        <div className="flex min-w-0 items-center gap-3">
          <Bot className="size-5 shrink-0 text-text-tertiary" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-text-primary">
                {subagent?.description || t('agent')}
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
            {subagent && (
              <div className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
                <span>
                  {formatDuration(
                    (subagent.endTime || Date.now()) - subagent.startTime,
                  )}
                </span>
                <span className="text-text-tertiary">•</span>
                <span className="flex items-center gap-1">
                  <WrenchIcon className="size-3" />
                  {t('toolCount', { count: subagent.toolCount })}
                </span>
              </div>
            )}
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

      {/* Conversation or placeholder */}
      {subagent ? (
        <SubagentConversation
          messages={subagent.messages}
          isRunning={subagent.state === 'running'}
          sessionId={sessionId}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-text-secondary">
          {t('subagentHint.asyncLaunched')}
        </div>
      )}
    </aside>
  )
}
