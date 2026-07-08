import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Workflow } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { formatDuration } from '../lib/time'
import {
  getCurrentPhaseTitle,
  getSubagentCounts,
  getWorkflowPhaseIndex,
} from '../lib/workflow-utils'
import { workflowStatusConfig } from '../lib/workflow-status'
import { cn } from './ui/utils'
import SubagentBriefStatus from './SubagentBriefStatus'
import SubagentDrawer from './SubagentDrawer'
import type { WorkflowState } from '../types/message'

interface WorkflowDetailPanelProps {
  runId: string
  sessionId: string
  onClose: () => void
}

function formatWorkflowDuration(workflow: WorkflowState): string {
  const ms =
    workflow.durationMs ??
    (workflow.status === 'running' ? Date.now() - workflow.startTime : 0)
  return formatDuration(ms)
}

export default function WorkflowDetailPanel({
  runId,
  sessionId,
  onClose,
}: WorkflowDetailPanelProps) {
  const { t } = useTranslation('chat')
  const workflow = useChatStore((s) =>
    (s.workflows?.[sessionId] || []).find((w) => w.runId === runId),
  )
  const [openDrawerToolUseId, setOpenDrawerToolUseId] = useState<string | null>(null)
  const [drawerWidth, setDrawerWidth] = useState(360)

  const handleOpenDrawer = (parentToolUseId: string) => {
    setOpenDrawerToolUseId(parentToolUseId)
  }
  const handleCloseDrawer = () => {
    setOpenDrawerToolUseId(null)
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Let nested drawers/modals handle Escape first. If a child has already
      // handled the event, do not close the detail panel too.
      if (e.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!workflow) {
    return (
      <Modal onClose={onClose}>
        <div className="flex h-48 items-center justify-center text-sm text-text-secondary">
          {t('workflowNoData')}
        </div>
      </Modal>
    )
  }

  const config = workflowStatusConfig[workflow.status]
  const currentPhaseIndex = getWorkflowPhaseIndex(workflow)
  const { completed, running, total } = getSubagentCounts(workflow)

  return (
    <Modal onClose={onClose}>
      <div className="flex flex-1 min-w-0 flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-4 flex-shrink-0">
          <div className="flex min-w-0 items-center gap-3">
            <Workflow className="size-5 shrink-0 text-text-tertiary" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-text-primary">
                  {workflow.workflowName || t('workflow')}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                    config.badgeClass,
                  )}
                >
                  {t(config.labelKey)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
                <span>{formatWorkflowDuration(workflow)}</span>
                {total > 0 && (
                  <>
                    <span className="text-text-tertiary">•</span>
                    <span>
                      {running > 0
                        ? t('workflowSubagentCountWithRunning', { completed, running, total })
                        : t('workflowSubagentCount', { completed, total })}
                    </span>
                  </>
                )}
                {typeof workflow.totalTokens === 'number' && (
                  <>
                    <span className="text-text-tertiary">•</span>
                    <span>{t('workflowDetailTokens', { count: workflow.totalTokens })}</span>
                  </>
                )}
                {typeof workflow.totalToolCalls === 'number' && (
                  <>
                    <span className="text-text-tertiary">•</span>
                    <span>{t('workflowDetailToolCalls', { count: workflow.totalToolCalls })}</span>
                  </>
                )}
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {workflow.summary && (
            <div className="mb-4 text-sm text-text-secondary">{workflow.summary}</div>
          )}
          {workflow.error && (
            <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              {workflow.error}
            </div>
          )}

          <Section title={t('workflowDetailPhases')}>
            {workflow.phases.length === 0 ? (
              <div className="text-xs text-text-tertiary">{getCurrentPhaseTitle(workflow) || '-'}</div>
            ) : (
              <ol className="flex flex-col gap-2">
                {workflow.phases.map((phase, idx) => (
                  <li
                    key={idx}
                    className={cn(
                      'rounded-md border p-2 text-sm',
                      idx === currentPhaseIndex
                        ? 'border-warning/30 bg-warning/5 text-text-primary'
                        : idx < currentPhaseIndex
                          ? 'border-border/50 bg-surface-hover/30 text-text-secondary'
                          : 'border-border bg-surface text-text-secondary',
                    )}
                  >
                    <div className="font-medium">{phase.title}</div>
                    {phase.detail && (
                      <div className="mt-0.5 text-xs text-text-tertiary">{phase.detail}</div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title={t('workflowDetailSubagents')}>
            {workflow.subagents.length === 0 ? (
              <div className="text-xs text-text-tertiary">-</div>
            ) : (
              <div className="flex flex-col gap-2">
                {workflow.subagents.map((subagent) => (
                  <SubagentBriefStatus
                    key={subagent.parentToolUseId}
                    parentToolUseId={subagent.parentToolUseId}
                    sessionId={sessionId}
                    onOpenDrawer={handleOpenDrawer}
                  />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>

      {openDrawerToolUseId && (
        <SubagentDrawer
          parentToolUseId={openDrawerToolUseId}
          sessionId={sessionId}
          width={drawerWidth}
          onClose={handleCloseDrawer}
          onWidthChange={setDrawerWidth}
        />
      )}
    </Modal>
  )
}

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-overlay/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-4xl flex-row overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        {children}
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
        {title}
      </h3>
      {children}
    </div>
  )
}
