import type { ChatSession } from '../stores/chat-store'
import { getSessionActivityTimestamp } from './session-sort'

type WorkspaceWithId = { id: string }

export function getWorkspaceActivityTimestamp(
  sessions: readonly ChatSession[] | undefined,
  lastActivityAt: Record<string, number>,
): number {
  if (!sessions?.length) return Number.NEGATIVE_INFINITY

  return sessions.reduce(
    (latest, session) => Math.max(latest, getSessionActivityTimestamp(session, lastActivityAt)),
    Number.NEGATIVE_INFINITY,
  )
}

export function sortWorkspacesByActivity<T extends WorkspaceWithId>(
  workspaces: readonly T[],
  sessionsByWorkspace: Readonly<Record<string, readonly ChatSession[]>>,
  lastActivityAt: Record<string, number>,
): T[] {
  const timestamps = new Map(
    workspaces.map((workspace) => [
      workspace.id,
      getWorkspaceActivityTimestamp(sessionsByWorkspace[workspace.id], lastActivityAt),
    ]),
  )

  return [...workspaces].sort((left, right) => {
    const leftTimestamp = timestamps.get(left.id) ?? Number.NEGATIVE_INFINITY
    const rightTimestamp = timestamps.get(right.id) ?? Number.NEGATIVE_INFINITY

    if (leftTimestamp === rightTimestamp) return 0
    return rightTimestamp - leftTimestamp
  })
}
