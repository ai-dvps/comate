import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { getCurrentPhaseTitle, getSubagentCounts } from '../lib/workflow-utils'
import { workflowStatusConfig } from '../lib/workflow-status'
import { cn } from './ui/utils'

interface WorkflowToolCardProps {
  runId: string
  sessionId: string
  workflowName?: string
  onOpenWorkflow?: (runId: string) => void
}

export default function WorkflowToolCard({
  runId,
  sessionId,
  workflowName,
  onOpenWorkflow,
}: WorkflowToolCardProps) {
  const { t } = useTranslation('chat')
  const workflow = useChatStore((s) =>
    (s.workflows?.[sessionId] || []).find((w) => w.runId === runId),
  )

  const status = workflow?.status ?? 'running'
  const config = workflowStatusConfig[status]
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
