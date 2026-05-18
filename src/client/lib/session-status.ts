export type SessionStatusState =
  | 'needs-me'
  | 'finished-unread'
  | 'streaming'
  | 'idle'

export interface SessionStatusInput {
  isStreaming: boolean
  pendingCount: number
  unread: boolean
  isActive: boolean
}

export function deriveSessionState(input: SessionStatusInput): SessionStatusState {
  if (input.pendingCount > 0) return 'needs-me'
  if (input.unread && !input.isActive) return 'finished-unread'
  if (input.isStreaming) return 'streaming'
  return 'idle'
}
