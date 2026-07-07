import { useTranslation } from 'react-i18next'
import {
  CheckCircleIcon,
  ClockIcon,
  XCircleIcon,
  Workflow,
} from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import type { WorkflowState, WorkflowStatus } from '../types/message'
import { cn } from './ui/utils'

interface WorkflowToolCardProps {
  runId: string
  sessionId: string
  workflowName?: string
  onOpenWorkflow?: (runId: string) => void
}

const statusConfig: Record<
  WorkflowStatus,
  { labelKey: string; icon: React.ReactNode; badgeClass: string; borderClass: string }
> = {
  running: {
    labelKey: 'workflowStatus.running',
    icon: <ClockIcon className="size-3.5 animate-pulse text-warning" />,
    badgeClass: 'bg-warning/10 text-warning border-warning/20',
    borderClass: 'border-l-2 border-l-warning',
  },
  completed: {
    labelKey: 'workflowStatus.completed',
    icon: <CheckCircleIcon className="size-3.5 text-success" />,
    badgeClass: 'bg-success/10 text-success border-success/20',
    borderClass: 'border-l-2 border-l-success',
  },
  error: {
    labelKey: 'workflowStatus.error',
    icon: <XCircleIcon className="size-3.5 text-destructive" />,
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
    borderClass: 'border-l-2 border-l-destructive',
  },
  killed: {
    labelKey: 'workflowStatus.killed',
    icon: <XCircleIcon className="size-3.5 text-destructive" />,
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
    borderClass: 'border-l-2 border-l-destructive',
  },
}

function getCurrentPhaseTitle(workflow: WorkflowState): string | undefined {
  if (workflow.phases.length > 0) {
    return workflow.phases[workflow.phases.length - 1]?.title
  }
  const phaseProgress = workflow.progress.filter(
    (p): p is { type: 'workflow_phase'; index: number; title: string } =>
      p.type === 'workflow_phase',
  )
  if (phaseProgress.length > 0) {
    return phaseProgress[phaseProgress.length - 1]?.title
  }
  return undefined
}

function getSubagentCounts(workflow: WorkflowState): {
  completed: number
  running: number
  total: number
} {
  const agentProgress = workflow.progress.filter(
    (p): p is {
      type: 'workflow_agent'
      index: number
      agentId: string
      state?: 'running' | 'done'
    } => p.type === 'workflow_agent',
  )
  if (agentProgress.length > 0) {
    const completed = agentProgress.filter((p) => p.state === 'done').length
    const running = agentProgress.filter((p) => p.state === 'running').length
    return { completed, running, total: agentProgress.length }
  }

  const total = workflow.agentCount ?? workflow.subagents.length
  const completed = workflow.subagents.filter((s) => s.state === 'completed').length
  const running = workflow.subagents.filter((s) => s.state === 'running').length
  return { completed, running, total }
}

export default function WorkflowToolCard({
  runId,
  sessionId,
  workflowName,
  onOpenWorkflow,
}: WorkflowToolCardProps) {
  const { t } = useTranslation('chat')
  const workflow = useChatStore((s) =>
    (s.workflows[sessionId] || []).find((w) => w.runId === runId),
  )

  const status = workflow?.status ?? 'running'
  const config = statusConfig[status]
  const phaseTitle = workflow ? getCurrentPhaseTitle(workflow) : undefined
  const { completed, running, total } = workflow
    ? getSubagentCounts(workflow)
    : { completed: 0, running: 0, total: 0 }

  const title = workflowName || workflow?.workflowName || t('workflow')

  return (
    <button
      type="button"
      onClick={() => onOpenWorkflow?.(runId)}
      className={cn(
        'mb-4 w-full rounded-md border border-border bg-surface text-left',
        config.borderClass,
      )}
    >
      <div className="flex w-full items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Workflow className="size-4 shrink-0 text-text-tertiary" />
            <span className="truncate text-sm font-medium text-text-primary">
              {title}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            {phaseTitle ? (
              <>
                <span className="truncate">{phaseTitle}</span>
                <span className="text-text-tertiary">•</span>
              </>
            ) : null}
            <span>
              {running > 0
                ? t('workflowSubagentCountWithRunning', { completed, running, total })
                : t('workflowSubagentCount', { completed, total })}
            </span>
          </div>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium shrink-0',
            config.badgeClass,
          )}
        >
          {config.icon}
          {t(config.labelKey)}
        </span>
      </div>
    </button>
  )
}
