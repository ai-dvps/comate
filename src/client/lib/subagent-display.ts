import type { SubagentState } from '../stores/chat-store'
import type { MessagePart } from '../types/message'

type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

export type SubagentDisplayState =
  | 'async_launched'
  | 'running_in_background'
  | 'running'
  | 'completed'
  | 'error'

export function isAsyncPlaceholder(result?: ToolResultPart): boolean {
  if (!result?.toolUseResult) return false
  if (typeof result.toolUseResult !== 'object') return false
  return (
    (result.toolUseResult as Record<string, unknown>).status === 'async_launched'
  )
}

export function getSubagentDisplayState(
  subagent: SubagentState | undefined,
  result: ToolResultPart | undefined,
): SubagentDisplayState {
  const async = isAsyncPlaceholder(result)

  if (async) {
    if (
      !subagent ||
      (subagent.state === 'running' && subagent.messages.length === 0)
    ) {
      return 'async_launched'
    }
    if (subagent.state === 'running') {
      return 'running_in_background'
    }
  }

  if (subagent) {
    return subagent.state
  }

  if (result) {
    return result.isError ? 'error' : 'completed'
  }

  return 'async_launched'
}
