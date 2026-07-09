import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CheckCircleIcon,
  ClockIcon,
  PanelRightOpen,
  Rocket,
  XCircleIcon,
} from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import type { SubagentState } from '../stores/chat-store'
import type { MessagePart } from '../types/message'
import {
  getSubagentDisplayState,
  isAsyncPlaceholder,
  type SubagentDisplayState,
} from '../lib/subagent-display'

import { formatDuration } from '../lib/time'
import { cn } from './ui/utils'
import { CompactableContainer } from './ai-elements/compactable-container'

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

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
  const subagent = useChatStore((s) =>
    (s.subagents[sessionId] || []).find(
      (sa) => sa.parentToolUseId === parentToolUseId,
    ),
  )
  const subagentType = getSubagentType(input)
  const prompt = getAgentPrompt(input)
  const displayState = getSubagentDisplayState(subagent, result)

  if (!subagent) {
    return (
      <NoStateCard
        displayState={displayState}
        subagentType={subagentType}
        prompt={prompt}
        onClick={() => onOpenDrawer(parentToolUseId)}
      />
    )
  }

  return (
    <StatusCard
      subagent={subagent}
      displayState={displayState}
      subagentType={subagentType}
      prompt={prompt}
      result={result}
      onClick={() => onOpenDrawer(parentToolUseId)}
    />
  )
}

const statusConfig: Record<
  SubagentDisplayState,
  {
    icon: React.ReactNode
    labelKey: string
    badgeClass: string
    borderClass: string
  }
> = {
  async_launched: {
    icon: <Rocket className="size-3.5 text-accent" />,
    labelKey: 'subagentStatus.asyncLaunched',
    badgeClass: 'bg-accent/10 text-accent border-accent/20',
    borderClass: 'border-l-2 border-l-accent',
  },
  running_in_background: {
    icon: <ClockIcon className="size-3.5 animate-pulse text-warning" />,
    labelKey: 'subagentStatus.runningInBackground',
    badgeClass: 'bg-warning/10 text-warning border-warning/20',
    borderClass: 'border-l-2 border-l-warning',
  },
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

function NoStateCard({
  displayState,
  subagentType,
  prompt,
  onClick,
}: {
  displayState: SubagentDisplayState
  subagentType?: string
  prompt?: string
  onClick: () => void
}) {
  const { t } = useTranslation('chat')
  const config = statusConfig[displayState]
  const showAsyncMetadata = displayState === 'async_launched'

  return (
    <div
      className={cn(
        'mb-4 w-full rounded-md border border-border bg-surface text-left',
        config.borderClass,
      )}
    >
      <div className="flex w-full items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0 text-text-tertiary" />
            <span className="truncate text-sm font-medium text-text-primary">
              {t('agentLabel', { type: subagentType || t('agent') })}
            </span>
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
          <OpenPanelButton onClick={onClick} />
        </div>
      </div>

      {(prompt || showAsyncMetadata) && (
        <CompactableContainer compactHeight={0} alwaysShowToggle>
          <div className="px-3 pb-3">
            {prompt && (
              <CompactableContainer>
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
            {showAsyncMetadata && (
              <div className="mt-1.5 text-xs text-text-secondary">
                {t('subagentHint.asyncLaunched')}
              </div>
            )}
          </div>
        </CompactableContainer>
      )}

      <span aria-live="polite" className="sr-only">
        {t(config.labelKey)}
      </span>
    </div>
  )
}

function StatusCard({
  subagent,
  displayState,
  subagentType,
  prompt,
  result,
  onClick,
}: {
  subagent: SubagentState
  displayState: SubagentDisplayState
  subagentType?: string
  prompt?: string
  result?: ToolResultPart
  onClick: () => void
}) {
  const { t } = useTranslation('chat')
  const isRunning =
    displayState === 'running' ||
    displayState === 'running_in_background' ||
    displayState === 'async_launched'
  const elapsed = useElapsed(subagent.startTime, subagent.endTime, isRunning)

  const config = statusConfig[displayState]
  const showAggregatingHint =
    displayState === 'completed' && isAsyncPlaceholder(result)
  const hasBodyContent =
    subagent.description ||
    prompt ||
    displayState === 'async_launched' ||
    displayState === 'running_in_background' ||
    showAggregatingHint ||
    subagent.progressHint

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
          <OpenPanelButton onClick={onClick} />
        </div>
      </div>

      {/* Collapsible body */}
      {hasBodyContent && (
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

            {displayState === 'async_launched' && (
              <div className="mt-1.5 text-xs text-text-secondary">
                {t('subagentHint.asyncLaunched')}
              </div>
            )}

            {displayState === 'running_in_background' && (
              <div className="mt-1.5 text-xs text-text-secondary">
                {t('subagentHint.runningInBackground')}
              </div>
            )}

            {showAggregatingHint && (
              <div className="mt-1.5 text-xs text-text-secondary">
                {t('subagentHint.aggregatingResult')}
              </div>
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

      <span aria-live="polite" className="sr-only">
        {t(config.labelKey)}
      </span>
    </div>
  )
}

function OpenPanelButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('chat')
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('openSubagentPanel')}
      aria-expanded={false}
      title={t('openSubagentPanel')}
      className="inline-flex items-center justify-center rounded-md border border-border bg-surface p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
    >
      <PanelRightOpen className="size-4" />
    </button>
  )
}
