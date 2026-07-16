import type { ChatMessage } from '../types/message'
import type { SubagentMessage } from '../stores/chat-store'
import type { MessageSearchMatch, SearchHighlightRange } from '../hooks/useMessageSearch'

/* ------------------------------------------------------------------ */
/*  Normalized renderable types                                         */
/* ------------------------------------------------------------------ */

export type RenderablePart =
  | { type: 'text'; text: string; timestamp?: number }
  | { type: 'thinking'; text: string; isStreaming: boolean; timestamp?: number }
  | {
      type: 'tool_use'
      toolUseId: string
      toolName: string
      input: unknown
      inputJsonStream?: string
      isStreaming: boolean
      timestamp?: number
      meta?: {
        displayName?: string
        iconUrl?: string
      }
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: string
      isError: boolean
      timestamp?: number
      toolUseResult?: unknown
    }

export interface RenderableMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  subType?: string
  timestamp?: number
  parts: RenderablePart[]
}

/* ------------------------------------------------------------------ */
/*  Adapter functions                                                   */
/* ------------------------------------------------------------------ */

export function adaptChatMessage(msg: ChatMessage & { sourceTimestamps?: number[] }): RenderableMessage {
  return {
    id: msg.id,
    role: msg.role,
    subType: msg.subType,
    timestamp: msg.timestamp,
    parts: msg.parts.map((part, index): RenderablePart | null => {
      if (!part) return null
      const sourceTimestamps = msg.sourceTimestamps
      const timestamp =
        sourceTimestamps != null && index < sourceTimestamps.length
          ? sourceTimestamps[index]
          : msg.timestamp
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text, timestamp }
        case 'thinking':
          return {
            type: 'thinking',
            text: part.text,
            isStreaming: part.state === 'streaming',
            timestamp,
          }
        case 'tool_use':
          return {
            type: 'tool_use',
            toolUseId: part.toolUseId,
            toolName: part.toolName,
            input: part.input,
            inputJsonStream: part.inputJsonStream,
            isStreaming: part.state === 'streaming',
            meta: part.meta,
            timestamp,
          }
        case 'tool_result':
          return {
            type: 'tool_result',
            toolUseId: part.toolUseId,
            output: part.output,
            isError: part.isError,
            timestamp,
            ...(part.toolUseResult !== undefined && { toolUseResult: part.toolUseResult }),
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
    | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean; toolUseResult?: unknown }
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
): 'input-streaming' | 'input-available' | 'output-error' | 'output-available' {
  if (toolUse.isStreaming) return 'input-streaming'
  if (!result) return 'input-available'
  return result.isError ? 'output-error' : 'output-available'
}

export function getPartSearchRanges(
  matches: MessageSearchMatch[] | undefined,
  currentMatch: MessageSearchMatch | null | undefined,
  messageId: string,
  partIndex: number,
): SearchHighlightRange[] {
  return (matches ?? [])
    .filter((m) => m.messageId === messageId && m.partIndex === partIndex)
    .map((m) => ({
      start: m.start,
      end: m.end,
      isActive:
        currentMatch?.messageId === messageId &&
        currentMatch?.partIndex === partIndex &&
        currentMatch?.start === m.start &&
        currentMatch?.end === m.end,
    }))
}
