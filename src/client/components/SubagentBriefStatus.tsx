import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CheckCircleIcon,
  ClockIcon,
  PanelRightOpen,
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

function useElapsed(
  startTime: number,
  endTime: number | undefined,
  isRunning: boolean,
): string {
  const base = isRunning ? Date.now() : (endTime ?? Date.now())
  const [elapsed, setElapsed] = useState(base - startTime)

  useEffect(() => {
    const newElapsed = (isRunning ? Date.now() : (endTime ?? Date.now())) - startTime
    setElapsed(newElapsed)
    if (!isRunning) {
      return
    }
    const id = setInterval(() => {
      setElapsed(Date.now() - startTime)
    }, 1000)
    return () => clearInterval(id)
  }, [startTime, endTime, isRunning])

  return formatDuration(elapsed)
}

export default function SubagentBriefStatus({
  parentToolUseId,
  sessionId,
  onOpenDrawer,
  input,
  result,
}: SubagentBriefStatusProps) {
  const { t } = useTranslation('chat')
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
          <span>{t('agentLabel', { type: subagentType || t('agent') })}</span>
        </div>
        {(prompt || result) && (
          <CompactableContainer compactHeight={0} alwaysShowToggle className="mt-2">
            {prompt && (
              <div className="text-xs text-text-secondary whitespace-pre-wrap">
                {prompt}
              </div>
            )}
            {result && (
              <div className="mt-2">
                <h4 className="font-medium text-text-tertiary text-[10px] uppercase tracking-wide">
                  {result.isError ? t('subagentStatus.error') : t('result')}
                </h4>
                {prompt && <hr className="border-border/50 my-1" />}
                <div className={cn('text-xs whitespace-pre-wrap', result.isError ? 'text-destructive' : 'text-text-secondary')}>
                  {result.output}
                </div>
              </div>
            )}
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
    icon: <ClockIcon className="size-3.5 animate-pulse text-warning" />,
    labelKey: 'subagentStatus.running',
    badgeClass: 'bg-warning/10 text-warning border-warning/20',
    borderClass: 'border-l-2 border-l-warning',
  },
  completed: {
    icon: <CheckCircleIcon className="size-3.5 text-success" />,
    labelKey: 'subagentStatus.completed',
    badgeClass: 'bg-success/10 text-success border-success/20',
    borderClass: 'border-l-2 border-l-success',
  },
  error: {
    icon: <XCircleIcon className="size-3.5 text-destructive" />,
    labelKey: 'subagentStatus.error',
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
    borderClass: 'border-l-2 border-l-destructive',
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
  const { t } = useTranslation('chat')
  const isRunning = subagent.state === 'running'
  const elapsed = useElapsed(subagent.startTime, subagent.endTime, isRunning)

  const config = statusConfig[subagent.state]
  const hasContent = subagent.description || prompt || result

  return (
    <div
      className={cn(
        'mb-4 w-full rounded-md border border-border bg-surface text-left',
        config.borderClass,
      )}
    >
      {/* Header: left info (non-clickable), right open button */}
      <div className="flex w-full items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0 text-text-tertiary" />
            <span className="truncate text-sm font-medium text-text-primary">
              {t('agentLabel', { type: subagentType || t('agent') })}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span>{elapsed}</span>
            <span className="text-text-tertiary">•</span>
            <span>{t('toolCount', { count: subagent.toolCount })}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
              config.badgeClass,
            )}
          >
            {config.icon}
            {t(config.labelKey)}
          </span>
          <button
            onClick={onClick}
            title={t('openSubagentPanel')}
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <PanelRightOpen className="size-4" />
          </button>
        </div>
      </div>

      {/* Collapsible body */}
      {hasContent && (
        <CompactableContainer compactHeight={0} alwaysShowToggle>
          <div className="px-3 pb-3">
            {/* Description */}
            {subagent.description && (
              <div className="text-sm text-text-secondary truncate">
                {subagent.description}
              </div>
            )}

            {/* Prompt */}
            {prompt && (
              <CompactableContainer className="mt-2">
                <div className="space-y-1">
                  <h4 className="font-medium text-text-tertiary text-[10px] uppercase tracking-wide">
                    {t('prompt')}
                  </h4>
                  <div className="text-xs text-text-secondary whitespace-pre-wrap">
                    {prompt}
                  </div>
                </div>
              </CompactableContainer>
            )}

            {/* Result */}
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
                      result.isError ? 'text-destructive' : 'text-text-secondary',
                    )}
                  >
                    {result.output}
                  </div>
                </div>
              </CompactableContainer>
            )}

            {subagent.progressHint && (
              <div className="mt-1.5 flex items-center gap-2 text-xs text-text-secondary">
                <span className="truncate max-w-[200px]" title={subagent.progressHint}>
                  {subagent.progressHint}
                </span>
              </div>
            )}
          </div>
        </CompactableContainer>
      )}
    </div>
  )
}
