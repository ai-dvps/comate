import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import {
  getCurrentPhaseTitle,
  getSubagentCounts,
  getWorkflowPhaseIndex,
} from '../lib/workflow-utils'
import { workflowStatusConfig } from '../lib/workflow-status'
import { cn } from './ui/utils'
import type { WorkflowState } from '../types/message'

interface WorkflowFloatingPanelProps {
  sessionId: string
  onOpenWorkflow: (runId: string) => void
}

function getPhaseProgress(workflow: WorkflowState): number {
  if (workflow.phases.length === 0) {
    const { completed, total } = getSubagentCounts(workflow)
    return total > 0 ? completed / total : 0
  }
  if (
    workflow.status === 'completed' ||
    workflow.status === 'error' ||
    workflow.status === 'killed'
  ) {
    return 1
  }
  const index = getWorkflowPhaseIndex(workflow)
  if (index < 0) return 0
  return Math.min((index + 1) / workflow.phases.length, 1)
}

export default function WorkflowFloatingPanel({
  sessionId,
  onOpenWorkflow,
}: WorkflowFloatingPanelProps) {
  const { t } = useTranslation('chat')
  const workflows = useChatStore((s) => s.workflows?.[sessionId] || [])

  if (workflows.length === 0) return null

  return (
    <div className="pointer-events-auto rounded-lg border border-border bg-surface p-3 shadow-lg max-w-xs">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
        <Workflow className="size-3.5" />
        {t('workflowPanelTitle')}
      </div>
      <div className="flex flex-col gap-2">
        {workflows.map((workflow) => (
          <WorkflowPanelItem
            key={workflow.runId}
            workflow={workflow}
            onClick={() => onOpenWorkflow(workflow.runId)}
          />
        ))}
      </div>
    </div>
  )
}

function WorkflowPanelItem({
  workflow,
  onClick,
}: {
  workflow: WorkflowState
  onClick: () => void
}) {
  const { t } = useTranslation('chat')
  const config = workflowStatusConfig[workflow.status]
  const phaseTitle = getCurrentPhaseTitle(workflow)
  const { completed, running, total } = getSubagentCounts(workflow)
  const phaseProgress = getPhaseProgress(workflow)

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border border-border bg-bg p-2 text-left transition-colors hover:bg-surface-hover"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-text-primary">
          {workflow.workflowName || t('workflow')}
        </span>
        <span
          className={cn(
            'inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
            config.badgeClass,
          )}
        >
          {t(config.labelKey)}
        </span>
      </div>

      {phaseTitle && (
        <div className="mt-1 truncate text-[10px] text-text-secondary">
          {phaseTitle}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              workflow.status === 'running'
                ? 'bg-warning'
                : workflow.status === 'completed'
                  ? 'bg-success'
                  : 'bg-destructive',
            )}
            style={{ width: `${Math.round(phaseProgress * 100)}%` }}
          />
        </div>
        <span className="shrink-0 text-[10px] text-text-tertiary">
          {running > 0
            ? t('workflowSubagentCountWithRunning', { completed, running, total })
            : t('workflowSubagentCount', { completed, total })}
        </span>
      </div>
    </button>
  )
}
