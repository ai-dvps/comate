import { AlertCircle } from 'lucide-react'

import { summarizeToolInput } from '../lib/summarize-tool-input'
import type { MessageSearchMatch, SearchHighlightRange } from '../hooks/useMessageSearch'

import { Message, MessageContent } from './ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from './ai-elements/reasoning'
import CompactableText from './ai-elements/compactable-text'
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
import {
  type RenderableMessage,
  type RenderablePart,
  getPartSearchRanges,
  toToolState,
} from './chat-message-adapter'

export type { RenderableMessage, RenderablePart } from './chat-message-adapter'

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
}

export function HighlightText({
  text,
  ranges,
  className,
}: {
  text: string
  ranges: SearchHighlightRange[]
  className?: string
}) {
  if (ranges.length === 0) {
    return (
      <span className={className}>{text}</span>
    )
  }

  const segments: { start: number; end: number; isActive: boolean }[] = []
  let last = 0
  for (const range of ranges) {
    if (range.start > last) {
      segments.push({ start: last, end: range.start, isActive: false })
    }
    segments.push({ start: range.start, end: range.end, isActive: range.isActive })
    last = range.end
  }
  if (last < text.length) {
    segments.push({ start: last, end: text.length, isActive: false })
  }

  return (
    <span className={className}>
      {segments.map((segment, idx) => {
        const content = text.slice(segment.start, segment.end)
        if (segment.isActive) {
          return (
            <mark
              key={idx}
              className="rounded bg-accent/70 px-0.5 text-text-primary ring-1 ring-accent"
              data-search-active="true"
            >
              {content}
            </mark>
          )
        }
        if (ranges.some((r) => segment.start >= r.start && segment.end <= r.end)) {
          // Defensive: should have been handled by isActive branch for exact matches,
          // but mark any overlapping segment as a regular match.
          return (
            <mark
              key={idx}
              className="rounded bg-accent/40 px-0.5 text-text-primary"
              data-search-match="true"
            >
              {content}
            </mark>
          )
        }
        return <span key={idx}>{content}</span>
      })}
    </span>
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

export default function ChatMessageRenderer({
  message,
  resultMap,
  onOpenDrawer,
  onOpenWorkflow,
  sessionId,
  autoApprovedTools,
  searchMatches = [],
  currentMatch = null,
}: ChatMessageRendererProps) {
  const hasAnyMatch = searchMatches.some((m) => m.messageId === message.id)

  if (message.role === 'system') {
    // Compact boundary is handled externally; generic system messages
    // are rendered as a simple error-style banner. API retry notices are
    // rendered as subtle inline text instead.
    const text = message.parts.find((p) => p.type === 'text')?.text ?? ''
    const ranges = getPartSearchRanges(searchMatches, currentMatch, message.id, 0)
    if (message.subType === 'api_retry') {
      return (
        <div className="px-3 py-1 text-xs text-text-muted/70">
          {ranges.length > 0 ? (
            <HighlightText text={text} ranges={ranges} />
          ) : (
            text
          )}
        </div>
      )
    }
    return (
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
    )
  }

  return (
    <Message from={message.role}>
      <MessageContent
        className={cn(
          hasAnyMatch && message.role === 'assistant' &&
            'ring-1 ring-accent/30 rounded-lg',
        )}
      >
        {message.parts.map((part, idx) => {
          const partKey = `${message.id}-${idx}`
          const ranges = getPartSearchRanges(searchMatches, currentMatch, message.id, idx)
          const isCurrentInPart = ranges.some((r) => r.isActive)
          const hasMatchInPart = ranges.length > 0

          if (part.type === 'text') {
            if (message.role === 'user') {
              return (
                <p key={partKey} className="whitespace-pre-wrap">
                  <HighlightText text={part.text} ranges={ranges} />
                </p>
              )
            }
            return (
              <CompactableText
                key={partKey}
                forceExpanded={isCurrentInPart}
                hasSearchMatch={hasMatchInPart}
                isCurrentSearchMatch={isCurrentInPart}
              >
                {part.text}
              </CompactableText>
            )
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
                  result={
                    agentResult
                      ? {
                          type: 'tool_result',
                          toolUseId: agentResult.toolUseId,
                          output: agentResult.output,
                          isError: agentResult.isError,
                        }
                      : undefined
                  }
                />
              )
            }
            if (part.toolName === 'Workflow') {
              const result = resultMap.get(part.toolUseId)
              const runId = extractWorkflowRunId(result)
              if (!runId) {
                // Fall back to the generic tool card until the async-launched
                // result (with runId) has been delivered.
                const summary = summarizeToolInput(part.input)
                const state = toToolState(part, result)
                return (
                  <Tool key={partKey}>
                    <ToolHeader
                      state={state}
                      summary={summary}
                      type="tool-Workflow"
                      autoApproved={autoApprovedTools?.[part.toolUseId]}
                      meta={part.meta}
                    />
                    <ToolContent
                      forceExpanded={isCurrentInPart}
                      hasSearchMatch={hasMatchInPart}
                      isCurrentSearchMatch={isCurrentInPart}
                    >
                      <ToolInput
                        input={part.input}
                        toolName={part.toolName}
                        searchMatches={ranges}
                      />
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
                  forceExpanded={isCurrentInPart}
                  hasSearchMatch={hasMatchInPart}
                  isCurrentSearchMatch={isCurrentInPart}
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
  )
}

/* ------------------------------------------------------------------ */
/*  Re-export compact boundary for consumers that need it               */
/* ------------------------------------------------------------------ */

export { CompactBoundary }
