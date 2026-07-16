import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronLeft, Layers, Workflow as WorkflowIcon, X } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { formatDuration } from '../lib/time'
import { getWorkflowPhaseIndex, getCurrentPhaseTitle } from '../lib/workflow-utils'
import { cn } from './ui/utils'
import ChatMessageRenderer from './ChatMessageRenderer'
import SubagentConversation from './SubagentConversation'
import SubagentBriefStatus from './SubagentBriefStatus'
import { adaptChatMessage, buildResultMap, type RenderablePart, type RenderableMessage } from './chat-message-adapter'
import { groupMessageParts } from './message-grouping'
import { type DrawerView, topView, canGoBack } from './detail-drawer-view'
import type { ChatMessage } from '../types/message'

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

const MIN_WIDTH = 300
const MAX_WIDTH = 600
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

interface DetailDrawerProps {
  stack: DrawerView[]
  sessionId: string
  width: number
  onWidthChange: (width: number) => void
  onPop: () => void
  onClose: () => void
  onPush: (view: DrawerView) => void
}

export default function DetailDrawer({
  stack,
  sessionId,
  width,
  onWidthChange,
  onPop,
  onClose,
  onPush,
}: DetailDrawerProps) {
  const { t } = useTranslation('chat')
  const asideRef = useRef<HTMLElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const view = topView(stack)
  const showBack = canGoBack(stack)
  const drillSubagent = useCallback(
    (parentToolUseId: string) => onPush({ kind: 'subagent', parentToolUseId }),
    [onPush],
  )

  // Focus + Escape + Tab trap. Re-focuses on view swap (push/pop) per R9.
  useEffect(() => {
    if (!view) return
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null
    const aside = asideRef.current
    aside?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !aside) return
      const focusable = Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previouslyFocused.current?.focus?.()
    }
  }, [view, onClose])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)))
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

  if (!view) return null

  const title = viewTitle(view, t)

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      role="dialog"
      aria-label={title}
      className="relative flex h-full flex-shrink-0 flex-col border-l border-border bg-surface outline-none"
      style={{ width }}
    >
      <div
        className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-accent/50"
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-3 py-3">
        {showBack && (
          <button
            type="button"
            onClick={onPop}
            aria-label={t('back')}
            className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        <ViewIcon view={view} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {title}
        </span>
        <span aria-live="polite" className="sr-only">
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {view.kind === 'process' && (
          <ProcessBody
            messageId={view.messageId}
            regionIndex={view.regionIndex}
            sessionId={sessionId}
            onOpenDrawer={drillSubagent}
          />
        )}
        {view.kind === 'subagent' && (
          <SubagentBody
            parentToolUseId={view.parentToolUseId}
            sessionId={sessionId}
            onOpenDrawer={drillSubagent}
          />
        )}
        {view.kind === 'workflow' && (
          <WorkflowBody
            runId={view.runId}
            sessionId={sessionId}
            onOpenDrawer={drillSubagent}
          />
        )}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function viewTitle(view: DrawerView, t: ReturnType<typeof useTranslation>['t']): string {
  if (view.kind === 'process') return t('displayMode.processRegion')
  if (view.kind === 'subagent') return t('agent')
  return t('workflow')
}

function ViewIcon({ view }: { view: DrawerView }) {
  if (view.kind === 'process') return <Layers className="size-4 shrink-0 text-text-tertiary" />
  if (view.kind === 'subagent') return <Bot className="size-4 shrink-0 text-text-tertiary" />
  return <WorkflowIcon className="size-4 shrink-0 text-text-tertiary" />
}

/* ------------------------------------------------------------------ */
/*  Process body                                                       */
/* ------------------------------------------------------------------ */

function ProcessBody({
  messageId,
  regionIndex,
  sessionId,
  onOpenDrawer,
}: {
  messageId: string
  regionIndex: number
  sessionId: string
  onOpenDrawer: (parentToolUseId: string) => void
}) {
  const messages = useChatStore((s) => s.messages[sessionId] ?? [])
  const resultMap = useMemo(() => buildResultMap(messages), [messages])

  const region = useMemo(() => {
    const ids = messageId.split('|')
    const turnMessages = ids
      .map((id) => messages.find((m) => m.id === id))
      .filter((m): m is ChatMessage => Boolean(m))
    if (turnMessages.length === 0) return null
    const parts: RenderablePart[] = []
    for (const m of turnMessages) parts.push(...adaptChatMessage(m).parts)
    return groupMessageParts(parts)[regionIndex] ?? null
  }, [messages, messageId, regionIndex])

  if (!region || region.type !== 'process') {
    return <div className="p-4 text-sm text-text-secondary">No steps</div>
  }

  const detailMessage: RenderableMessage = {
    id: `${messageId}-r${regionIndex}`,
    role: 'assistant',
    timestamp: undefined,
    parts: region.parts,
  }

  return (
    <ChatMessageRenderer
      message={detailMessage}
      resultMap={resultMap}
      onOpenDrawer={onOpenDrawer}
      sessionId={sessionId}
      displayMode="linear"
      defaultToolExpanded={false}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Subagent body                                                      */
/* ------------------------------------------------------------------ */

function SubagentBody({
  parentToolUseId,
  sessionId,
  onOpenDrawer,
}: {
  parentToolUseId: string
  sessionId: string
  onOpenDrawer: (parentToolUseId: string) => void
}) {
  const { t } = useTranslation('chat')
  const subagent = useChatStore((s) =>
    (s.subagents[sessionId] || []).find((sa) => sa.parentToolUseId === parentToolUseId),
  )

  return (
    <div className="flex h-full flex-col">
      {subagent ? (
        <>
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
            <Bot className="size-4 shrink-0 text-text-tertiary" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
              {subagent.description || t('agent')}
            </span>
            <span className="flex-shrink-0 text-xs text-text-tertiary">
              {formatDuration((subagent.endTime || Date.now()) - subagent.startTime)}
            </span>
            <span className="flex-shrink-0 text-xs text-text-tertiary">
              {t('toolCount', { count: subagent.toolCount })}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SubagentConversation
              messages={subagent.messages}
              isRunning={subagent.state === 'running'}
              sessionId={sessionId}
              onOpenDrawer={onOpenDrawer}
            />
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center p-4 text-sm text-text-secondary">
          {t('subagentHint.asyncLaunched')}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Workflow body                                                      */
/* ------------------------------------------------------------------ */

function WorkflowBody({
  runId,
  sessionId,
  onOpenDrawer,
}: {
  runId: string
  sessionId: string
  onOpenDrawer: (parentToolUseId: string) => void
}) {
  const { t } = useTranslation('chat')
  const workflow = useChatStore((s) =>
    (s.workflows?.[sessionId] || []).find((w) => w.runId === runId),
  )

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-text-secondary">
        {t('workflowNoData')}
      </div>
    )
  }

  const currentPhaseIndex = getWorkflowPhaseIndex(workflow)

  return (
    <div className="h-full overflow-y-auto p-4">
      {workflow.summary && (
        <div className="mb-3 text-sm text-text-secondary">{workflow.summary}</div>
      )}
      {workflow.error && (
        <div className="mb-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {workflow.error}
        </div>
      )}

      {/* Phases */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
          {t('workflowDetailPhases')}
        </h3>
        {workflow.phases.length === 0 ? (
          <div className="text-xs text-text-tertiary">
            {getCurrentPhaseTitle(workflow) || '-'}
          </div>
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
      </div>

      {/* Subagents */}
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
          {t('workflowDetailSubagents')}
        </h3>
        {workflow.subagents.length === 0 ? (
          <div className="text-xs text-text-tertiary">-</div>
        ) : (
          <div className="flex flex-col gap-2">
            {workflow.subagents.map((subagent) => (
              <SubagentBriefStatus
                key={subagent.parentToolUseId}
                parentToolUseId={subagent.parentToolUseId}
                sessionId={sessionId}
                onOpenDrawer={onOpenDrawer}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
