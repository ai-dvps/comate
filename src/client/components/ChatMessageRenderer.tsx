import { memo, useMemo } from 'react'
import { AlertCircle } from 'lucide-react'

import { summarizeToolInput } from '../lib/summarize-tool-input'
import { detectStructuredReport } from '../lib/structured-report'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'

import { Message, MessageContent } from './ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from './ai-elements/reasoning'
import CompactableText from './ai-elements/compactable-text'
import { StructuredReport } from './ai-elements/structured-report'
import HighlightText from './HighlightText'
import LinkifiedText from './LinkifiedText'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from './ai-elements/tool'
import CompactBoundary from './CompactBoundary'
import SubagentBriefStatus from './SubagentBriefStatus'
import StreamingToolInputPreview from './StreamingToolInputPreview'
import WorkflowToolCard from './WorkflowToolCard'
import { cn } from './ui/utils'
import { formatMessageTimestamp } from '../lib/format-message-timestamp'
import {
  type RenderableMessage,
  type RenderablePart,
  getPartSearchRanges,
  toToolState,
} from './chat-message-adapter'

export type { RenderableMessage, RenderablePart } from './chat-message-adapter'

import { groupMessageParts } from './message-grouping'
import ProcessRegionGhost from './ProcessRegionGhost'
import type { DisplayMode } from '../hooks/use-app-settings'

/* ------------------------------------------------------------------ */
/*  Component props                                                     */
/* ------------------------------------------------------------------ */

export interface ChatMessageRendererProps {
  message: RenderableMessage
  resultMap: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>
  onOpenDrawer: (parentToolUseId: string) => void
  onOpenWorkflow?: (runId: string) => void
  sessionId: string
  autoApprovedTools?: Record<string, 'auto' | 'readonly'>
  searchMatches?: MessageSearchMatch[]
  currentMatch?: MessageSearchMatch | null
  /** 'result' collapses thinking + tool-use runs into a ghost; 'linear' (default) renders parts inline. */
  displayMode?: DisplayMode
  /** Open the per-region drawer (U4). Keyed by message id + region index. */
  onOpenProcessRegion?: (messageId: string, regionIndex: number) => void
  /** When false, tool cards inside this renderer start collapsed. Defaults to true. */
  defaultToolExpanded?: boolean
}

/* ------------------------------------------------------------------ */
/*  Timestamp helper                                                  */
/* ------------------------------------------------------------------ */

function MessageTimestamp({
  timestamp,
  align,
}: {
  timestamp?: number
  align: 'left' | 'right'
}) {
  const label = formatMessageTimestamp(timestamp)
  if (!label) return null

  return (
    <div
      className={cn(
        'mt-1 text-xs text-text-tertiary opacity-0 transition-opacity duration-200 group-hover:opacity-100',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {label}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function extractWorkflowRunId(
  result: Extract<RenderablePart, { type: 'tool_result' }> | undefined,
): string | undefined {
  if (!result) return undefined
  if (
    result.toolUseResult &&
    typeof result.toolUseResult === 'object'
  ) {
    const runId = (result.toolUseResult as Record<string, unknown>).runId
    if (typeof runId === 'string' && runId) return runId
  }
  try {
    const parsed = JSON.parse(result.output) as Record<string, unknown> | undefined
    const runId = parsed?.runId
    if (typeof runId === 'string' && runId) return runId
  } catch {
    // ignore parse errors
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

function ChatMessageRenderer({
  message,
  resultMap,
  onOpenDrawer,
  onOpenWorkflow,
  sessionId,
  autoApprovedTools,
  searchMatches = [],
  currentMatch = null,
  displayMode = 'linear',
  onOpenProcessRegion,
  defaultToolExpanded = true,
}: ChatMessageRendererProps) {
  const hasAnyMatch = searchMatches.some((m) => m.messageId === message.id)
  const isResultMode = displayMode === 'result' && message.role === 'assistant'
  const regions = useMemo(
    () => (isResultMode ? groupMessageParts(message.parts) : []),
    [isResultMode, message.parts],
  )

  if (message.role === 'system') {
    // Compact boundary is handled externally; generic system messages
    // are rendered as a simple error-style banner. API retry notices are
    // rendered as subtle inline text instead.
    const text = message.parts.find((p) => p.type === 'text')?.text ?? ''
    const ranges = getPartSearchRanges(searchMatches, currentMatch, message.id, 0)
    const showTimestamp = message.subType === 'Interrupt'
    if (message.subType === 'api_retry') {
      return (
        <div className="group flex flex-col items-start">
          <div className="px-3 py-1 text-xs text-text-muted/70">
            {ranges.length > 0 ? (
              <HighlightText text={text} ranges={ranges} />
            ) : (
              text
            )}
          </div>
          {showTimestamp && (
            <MessageTimestamp timestamp={message.timestamp} align="left" />
          )}
        </div>
      )
    }
    return (
      <div className="group flex flex-col items-start">
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2',
            hasAnyMatch
              ? 'border-accent/50 bg-accent/10'
              : 'border-destructive/20 bg-destructive/10 text-destructive',
          )}
        >
          <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
          <span className={hasAnyMatch ? 'text-text-primary' : undefined}>
            {ranges.length > 0 ? (
              <HighlightText text={text} ranges={ranges} />
            ) : (
              text
            )}
          </span>
        </div>
        {showTimestamp && (
          <MessageTimestamp timestamp={message.timestamp} align="left" />
        )}
      </div>
    )
  }

  const showTimestamp =
    message.role === 'user' ||
    (message.role === 'assistant' &&
      message.parts.every((p) => p.type === 'text'))

  // Assistant text rendering, shared by the linear path and the result-mode
  // text regions (preserves structured-report detection + search highlights).
  const renderAssistantText = (
    part: Extract<RenderablePart, { type: 'text' }>,
    partIndex: number,
  ) => {
    const ranges = getPartSearchRanges(searchMatches, currentMatch, message.id, partIndex)
    const isCurrentInPart = ranges.some((r) => r.isActive)
    const hasMatchInPart = ranges.length > 0
    const partKey = `${message.id}-${partIndex}`
    const report = detectStructuredReport(part.text)
    if (report) {
      return (
        <StructuredReport
          key={partKey}
          {...report}
          raw={part.text}
          forceExpanded={isCurrentInPart}
          hasSearchMatch={hasMatchInPart}
          isCurrentSearchMatch={isCurrentInPart}
        />
      )
    }
    return (
      <CompactableText
        key={partKey}
        hasSearchMatch={hasMatchInPart}
        isCurrentSearchMatch={isCurrentInPart}
      >
        {part.text}
      </CompactableText>
    )
  }

  return (
    <div
      className={cn(
        'group flex w-full max-w-[95%] flex-col',
        message.role === 'user' ? 'ml-auto items-end' : 'items-start',
      )}
    >
      <Message from={message.role}>
        <MessageContent
          className={cn(
            hasAnyMatch && message.role === 'assistant' &&
              'ring-1 ring-accent/30 rounded-lg',
          )}
        >
          {isResultMode
            ? regions.map((region, regionIndex) =>
                region.type === 'text' ? (
                  renderAssistantText(region.part, region.partIndex)
                ) : (
                  <ProcessRegionGhost
                    key={`ghost-${message.id}-${regionIndex}`}
                    region={region}
                    hasError={region.parts.some(
                      (p) => p.type === 'tool_use' && resultMap.get(p.toolUseId)?.isError,
                    )}
                    onOpen={() => onOpenProcessRegion?.(message.id, regionIndex)}
                  />
                ),
              )
            : message.parts.map((part, idx) => {
            const partKey = `${message.id}-${idx}`
            const ranges = getPartSearchRanges(searchMatches, currentMatch, message.id, idx)
            const isCurrentInPart = ranges.some((r) => r.isActive)
            const hasMatchInPart = ranges.length > 0

            if (part.type === 'text') {
              if (message.role === 'user') {
                return (
                  <p key={partKey} className="whitespace-pre-wrap">
                    <LinkifiedText text={part.text} ranges={ranges} />
                  </p>
                )
              }
              return renderAssistantText(part, idx)
            }
            if (part.type === 'thinking') {
              return (
                <Reasoning
                  defaultOpen={false}
                  disableAutoBehavior
                  isStreaming={part.isStreaming}
                  key={partKey}
                  forceOpen={isCurrentInPart}
                  hasSearchMatch={hasMatchInPart}
                  isCurrentSearchMatch={isCurrentInPart}
                >
                  <ReasoningTrigger />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              )
            }
            if (part.type === 'tool_use') {
              if (
                part.toolName === 'TaskCreate' ||
                part.toolName === 'TaskUpdate'
              ) {
                return null
              }
              if (part.toolName === 'Agent') {
                const agentResult = resultMap.get(part.toolUseId)
                return (
                  <SubagentBriefStatus
                    key={partKey}
                    parentToolUseId={part.toolUseId}
                    sessionId={sessionId}
                    onOpenDrawer={onOpenDrawer}
                    input={part.input}
                    result={agentResult}
                  />
                )
              }
              if (part.toolName === 'Workflow') {
                const result = resultMap.get(part.toolUseId)
                const runId = extractWorkflowRunId(result)
                if (runId) {
                  const workflowName =
                    part.input &&
                    typeof part.input === 'object' &&
                    typeof (part.input as Record<string, unknown>).name === 'string'
                      ? ((part.input as Record<string, unknown>).name as string)
                      : undefined
                  return (
                    <WorkflowToolCard
                      key={partKey}
                      runId={runId}
                      sessionId={sessionId}
                      workflowName={workflowName}
                      onOpenWorkflow={onOpenWorkflow}
                    />
                  )
                }
                // Fall through to the generic tool card while waiting for the
                // async-launched result (with runId) to arrive.
              }
              const result = resultMap.get(part.toolUseId)
              const state = toToolState(part, result)
              const isStreaming = state === 'input-streaming'
              const streamingJson = part.inputJsonStream ?? ''
              const summary = summarizeToolInput(part.input)
              const autoApproved = autoApprovedTools?.[part.toolUseId]
              return (
                <Tool key={partKey}>
                  <ToolHeader
                    state={state}
                    summary={summary}
                    type={`tool-${part.toolName}`}
                    autoApproved={autoApproved}
                    meta={part.meta}
                  />
                  <ToolContent
                    hasSearchMatch={hasMatchInPart}
                    isCurrentSearchMatch={isCurrentInPart}
                    alwaysExpanded={defaultToolExpanded}
                  >
                    {isStreaming && streamingJson.length > 0 ? (
                      <StreamingToolInputPreview partialJson={streamingJson} />
                    ) : (
                      <ToolInput
                        input={part.input}
                        toolName={part.toolName}
                        searchMatches={ranges}
                      />
                    )}
                    {result && (
                      <div className="pt-2">
                        <ToolOutput
                          errorText={result.isError ? result.output : undefined}
                          output={result.isError ? undefined : result.output}
                          searchMatches={ranges}
                        />
                      </div>
                    )}
                  </ToolContent>
                </Tool>
              )
            }
            return null
          })}
        </MessageContent>
      </Message>
      {showTimestamp && (
        <MessageTimestamp
          timestamp={message.timestamp}
          align={message.role === 'user' ? 'right' : 'left'}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Memoized export                                                   */
/* ------------------------------------------------------------------ */

function messageHasToolUse(message: RenderableMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.parts.some((p) => p.type === 'tool_use')
  )
}

function resultMapAffectsMessage(
  prevResultMap: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>,
  nextResultMap: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>,
  message: RenderableMessage,
): boolean {
  if (!messageHasToolUse(message)) return false
  for (const part of message.parts) {
    if (part.type === 'tool_use') {
      const prevResult = prevResultMap.get(part.toolUseId)
      const nextResult = nextResultMap.get(part.toolUseId)
      if (prevResult !== nextResult) return true
    }
  }
  return false
}

function searchPropsAffectMessage(
  searchMatches: MessageSearchMatch[] | undefined,
  currentMatch: MessageSearchMatch | null | undefined,
  messageId: string,
): boolean {
  if (searchMatches?.some((m) => m.messageId === messageId)) return true
  if (currentMatch?.messageId === messageId) return true
  return false
}

function areEqual(
  prevProps: ChatMessageRendererProps,
  nextProps: ChatMessageRendererProps,
): boolean {
  if (prevProps.message !== nextProps.message) return false
  if (prevProps.displayMode !== nextProps.displayMode) return false
  if (prevProps.sessionId !== nextProps.sessionId) return false
  if (prevProps.onOpenDrawer !== nextProps.onOpenDrawer) return false
  if (prevProps.onOpenWorkflow !== nextProps.onOpenWorkflow) return false
  if (prevProps.onOpenProcessRegion !== nextProps.onOpenProcessRegion) return false
  if (prevProps.autoApprovedTools !== nextProps.autoApprovedTools) return false
  if (prevProps.defaultToolExpanded !== nextProps.defaultToolExpanded) return false

  if (
    searchPropsAffectMessage(
      nextProps.searchMatches,
      nextProps.currentMatch,
      nextProps.message.id,
    ) ||
    searchPropsAffectMessage(
      prevProps.searchMatches,
      prevProps.currentMatch,
      prevProps.message.id,
    )
  ) {
    if (prevProps.searchMatches !== nextProps.searchMatches) return false
    if (prevProps.currentMatch !== nextProps.currentMatch) return false
  }

  if (
    resultMapAffectsMessage(
      prevProps.resultMap,
      nextProps.resultMap,
      nextProps.message,
    )
  ) {
    return false
  }

  return true
}

const MemoizedChatMessageRenderer = memo(ChatMessageRenderer, areEqual)
export default MemoizedChatMessageRenderer

/* ------------------------------------------------------------------ */
/*  Re-export compact boundary for consumers that need it               */
/* ------------------------------------------------------------------ */

export { CompactBoundary }
