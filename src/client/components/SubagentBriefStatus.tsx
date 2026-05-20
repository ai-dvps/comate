import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  XCircleIcon,
} from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import type { SubagentState } from '../stores/chat-store'
import type { MessagePart } from '../types/message'

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>
import { formatDuration } from '../lib/time'
import { cn } from './ui/utils'
import { CompactableContainer } from './ai-elements/compactable-container'

interface SubagentBriefStatusProps {
  parentToolUseId: string
  sessionId: string
  onOpenDrawer: (parentToolUseId: string) => void
  input?: unknown
  result?: ToolResultPart
}

function getSubagentType(input: unknown): string | undefined {
  if (input && typeof input === 'object') {
    const type = (input as Record<string, unknown>).subagent_type
    if (typeof type === 'string' && type.length > 0) {
      return type
    }
  }
  return undefined
}

function getAgentPrompt(input: unknown): string | undefined {
  if (input && typeof input === 'object') {
    const prompt = (input as Record<string, unknown>).prompt
    if (typeof prompt === 'string' && prompt.length > 0) {
      return prompt
    }
  }
  return undefined
}

function useElapsed(startTime: number, isRunning: boolean): string {
  const [elapsed, setElapsed] = useState(() => Date.now() - startTime)
  const startRef = useRef(startTime)

  useEffect(() => {
    startRef.current = startTime
    if (!isRunning) {
      setElapsed(Date.now() - startRef.current)
      return
    }
    const id = setInterval(() => {
      setElapsed(Date.now() - startRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [startTime, isRunning])

  return formatDuration(elapsed)
}

export default function SubagentBriefStatus({
  parentToolUseId,
  sessionId,
  onOpenDrawer,
  input,
  result,
}: SubagentBriefStatusProps) {
  const subagent = useChatStore((s) =>
    (s.subagents[sessionId] || []).find(
      (sa) => sa.parentToolUseId === parentToolUseId,
    ),
  )
  const subagentType = getSubagentType(input)
  const prompt = getAgentPrompt(input)

  if (!subagent) {
    return (
      <div className="mb-4 w-full rounded-md border border-border bg-surface p-3 text-sm text-text-secondary">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-text-tertiary" />
          <span>Agent: {subagentType || 'Agent'}</span>
        </div>
        {prompt && (
          <CompactableContainer className="mt-2">
            <div className="text-xs text-text-secondary whitespace-pre-wrap">
              {prompt}
            </div>
          </CompactableContainer>
        )}
        {result && (
          <CompactableContainer className="mt-2">
            <div>
              <h4 className="font-medium text-text-tertiary text-[10px] uppercase tracking-wide">
                {result.isError ? 'Error' : 'Result'}
              </h4>
              {prompt && <hr className="border-border/50 my-1" />}
              <div className={cn('text-xs whitespace-pre-wrap', result.isError ? 'text-red-400' : 'text-text-secondary')}>
                {result.output}
              </div>
            </div>
          </CompactableContainer>
        )}
      </div>
    )
  }

  return (
    <StatusCard
      subagent={subagent}
      subagentType={subagentType}
      prompt={prompt}
      result={result}
      onClick={() => onOpenDrawer(parentToolUseId)}
    />
  )
}

const statusConfig = {
  running: {
    icon: <ClockIcon className="size-3.5 animate-pulse text-amber-500" />,
    label: 'Running',
    badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    borderClass: 'border-l-2 border-l-amber-500',
  },
  completed: {
    icon: <CheckCircleIcon className="size-3.5 text-green-600" />,
    label: 'Completed',
    badgeClass: 'bg-green-500/10 text-green-600 border-green-500/20',
    borderClass: 'border-l-2 border-l-green-500',
  },
  error: {
    icon: <XCircleIcon className="size-3.5 text-red-600" />,
    label: 'Error',
    badgeClass: 'bg-red-500/10 text-red-600 border-red-500/20',
    borderClass: 'border-l-2 border-l-red-500',
  },
}

function StatusCard({
  subagent,
  subagentType,
  prompt,
  result,
  onClick,
}: {
  subagent: SubagentState
  subagentType?: string
  prompt?: string
  result?: ToolResultPart
  onClick: () => void
}) {
  const isRunning = subagent.state === 'running'
  const elapsed = useElapsed(subagent.startTime, isRunning)

  const config = statusConfig[subagent.state]

  return (
    <button
      onClick={onClick}
      className={cn(
        'group mb-4 w-full rounded-md border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-hover/50',
        config.borderClass,
      )}
    >
      {/* Line 1: Agent type + status */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Bot className="size-4 shrink-0 text-text-tertiary" />
          <span className="truncate text-sm font-medium text-text-primary">
            Agent: {subagentType || 'Agent'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
              config.badgeClass,
            )}
          >
            {config.icon}
            {config.label}
          </span>
          <ChevronRightIcon className="size-4 text-text-tertiary transition-colors group-hover:text-text-secondary" />
        </div>
      </div>

      {/* Line 2: Description */}
      {subagent.description && (
        <div className="mt-1.5 text-sm text-text-secondary truncate">
          {subagent.description}
        </div>
      )}

      {/* Line 3: Prompt */}
      {prompt && (
        <CompactableContainer className="mt-2">
          <div className="space-y-1">
            <h4 className="font-medium text-text-tertiary text-[10px] uppercase tracking-wide">
              Prompt
            </h4>
            <div className="text-xs text-text-secondary whitespace-pre-wrap">
              {prompt}
            </div>
          </div>
        </CompactableContainer>
      )}

      {/* Line 4: Result */}
      {result && (
        <CompactableContainer className="mt-2">
          <div>
            <h4 className="font-medium text-text-tertiary text-[10px] uppercase tracking-wide">
              {result.isError ? 'Error' : 'Result'}
            </h4>
            {prompt && <hr className="border-border/50 my-1" />}
            <div
              className={cn(
                'text-xs whitespace-pre-wrap',
                result.isError ? 'text-red-400' : 'text-text-secondary',
              )}
            >
              {result.output}
            </div>
          </div>
        </CompactableContainer>
      )}

      {/* Meta row: elapsed + tools */}
      <div className="mt-1.5 flex items-center gap-2 text-xs text-text-secondary">
        <span>{elapsed}</span>
        <span className="text-text-tertiary">•</span>
        <span>
          {subagent.toolCount} tool{subagent.toolCount !== 1 ? 's' : ''}
        </span>
        {subagent.progressHint && (
          <>
            <span className="text-text-tertiary">•</span>
            <span className="truncate max-w-[200px]" title={subagent.progressHint}>
              {subagent.progressHint}
            </span>
          </>
        )}
      </div>
    </button>
  )
}
