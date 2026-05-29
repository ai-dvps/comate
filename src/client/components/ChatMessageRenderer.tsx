import { AlertCircle } from 'lucide-react'

import { summarizeToolInput } from '../lib/summarize-tool-input'
import type { ChatMessage } from '../types/message'
import type { SubagentMessage } from '../stores/chat-store'

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
  type ToolState,
} from './ai-elements/tool'
import CompactBoundary from './CompactBoundary'
import SubagentBriefStatus from './SubagentBriefStatus'
import StreamingToolInputPreview from './StreamingToolInputPreview'

/* ------------------------------------------------------------------ */
/*  Normalized renderable types                                         */
/* ------------------------------------------------------------------ */

export type RenderablePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; isStreaming: boolean }
  | {
      type: 'tool_use'
      toolUseId: string
      toolName: string
      input: unknown
      inputJsonStream?: string
      isStreaming: boolean
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: string
      isError: boolean
    }

export interface RenderableMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: RenderablePart[]
}

/* ------------------------------------------------------------------ */
/*  Adapter functions                                                   */
/* ------------------------------------------------------------------ */

export function adaptChatMessage(msg: ChatMessage): RenderableMessage {
  return {
    id: msg.id,
    role: msg.role,
    parts: msg.parts.map((part): RenderablePart | null => {
      if (!part) return null
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text }
        case 'thinking':
          return {
            type: 'thinking',
            text: part.text,
            isStreaming: part.state === 'streaming',
          }
        case 'tool_use':
          return {
            type: 'tool_use',
            toolUseId: part.toolUseId,
            toolName: part.toolName,
            input: part.input,
            inputJsonStream: part.inputJsonStream,
            isStreaming: part.state === 'streaming',
          }
        case 'tool_result':
          return {
            type: 'tool_result',
            toolUseId: part.toolUseId,
            output: part.output,
            isError: part.isError,
          }
        default:
          return null
      }
    }).filter((p): p is RenderablePart => p !== null),
  }
}

export function adaptSubagentMessage(
  msg: SubagentMessage,
  isRunning: boolean,
): RenderableMessage {
  return {
    id: msg.id,
    role: msg.role,
    parts: msg.parts.map((part): RenderablePart | null => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text }
        case 'thinking':
          return {
            type: 'thinking',
            text: part.text,
            isStreaming: isRunning,
          }
        case 'tool_use':
          return {
            type: 'tool_use',
            toolUseId: part.toolUseId,
            toolName: part.toolName,
            input: part.input,
            isStreaming: false,
          }
        case 'tool_result':
          return {
            type: 'tool_result',
            toolUseId: part.toolUseId,
            output: part.output,
            isError: part.isError,
          }
        default:
          return null
      }
    }).filter((p): p is RenderablePart => p !== null),
  }
}

/* ------------------------------------------------------------------ */
/*  Result map + tool state helpers                                     */
/* ------------------------------------------------------------------ */

export interface ResultMappableMessage {
  parts: Array<
    | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }
    | { type: string }
  >
}

export function buildResultMap<
  T extends ResultMappableMessage,
>(
  messages: T[],
): Map<string, Extract<RenderablePart, { type: 'tool_result' }>> {
  const map = new Map<string, Extract<RenderablePart, { type: 'tool_result' }>>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        const toolResult = p as Extract<RenderablePart, { type: 'tool_result' }>
        map.set(toolResult.toolUseId, toolResult)
      }
    }
  }
  return map
}

export function toToolState(
  toolUse: Extract<RenderablePart, { type: 'tool_use' }>,
  result?: Extract<RenderablePart, { type: 'tool_result' }>,
): ToolState {
  if (toolUse.isStreaming) return 'input-streaming'
  if (!result) return 'input-available'
  return result.isError ? 'output-error' : 'output-available'
}

/* ------------------------------------------------------------------ */
/*  Component props                                                     */
/* ------------------------------------------------------------------ */

export interface ChatMessageRendererProps {
  message: RenderableMessage
  resultMap: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>
  onOpenDrawer: (parentToolUseId: string) => void
  sessionId: string
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export default function ChatMessageRenderer({
  message,
  resultMap,
  onOpenDrawer,
  sessionId,
}: ChatMessageRendererProps) {
  if (message.role === 'system') {
    // Compact boundary is handled externally; generic system messages
    // are rendered as a simple error-style banner.
    const text = message.parts.find((p) => p.type === 'text')?.text ?? ''
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-destructive">
        <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
        <span>{text}</span>
      </div>
    )
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, idx) => {
          const partKey = `${message.id}-${idx}`
          if (part.type === 'text') {
            if (message.role === 'user') {
              return (
                <p key={partKey} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              )
            }
            return (
              <CompactableText key={partKey}>{part.text}</CompactableText>
            )
          }
          if (part.type === 'thinking') {
            return (
              <Reasoning
                defaultOpen={false}
                disableAutoBehavior
                isStreaming={part.isStreaming}
                key={partKey}
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
            const result = resultMap.get(part.toolUseId)
            const state = toToolState(part, result)
            const isStreaming = state === 'input-streaming'
            const streamingJson = part.inputJsonStream ?? ''
            const summary = summarizeToolInput(part.input)
            return (
              <Tool key={partKey}>
                <ToolHeader
                  state={state}
                  summary={summary}
                  type={`tool-${part.toolName}`}
                />
                <ToolContent>
                  {isStreaming && streamingJson.length > 0 ? (
                    <StreamingToolInputPreview partialJson={streamingJson} />
                  ) : (
                    <ToolInput input={part.input} toolName={part.toolName} />
                  )}
                  {result && (
                    <div className="pt-2">
                      <ToolOutput
                        errorText={result.isError ? result.output : undefined}
                        output={result.isError ? undefined : result.output}
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
