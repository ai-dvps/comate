import type { ChatSession } from '../stores/chat-store'
import { getSessionActivityTimestamp } from './session-sort'

type WorkspaceSortable = { id: string; createdAt?: string }

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

/**
 * Workspace ordering key (activity sort position stability, KTD2): the
 * server-carried turn-start key is the primary source. When it is absent
 * (e.g. a downgraded server), fall back to the newest session activity, then
 * to the workspace's own createdAt so a brand-new empty workspace still lands
 * on top (R6).
 */
function getWorkspaceSortTimestamp(
  workspace: WorkspaceSortable,
  sessions: readonly ChatSession[] | undefined,
  workspaceLastTurnStartedAt: Record<string, number>,
  lastActivityAt: Record<string, number>,
): number {
  const serverKey = workspaceLastTurnStartedAt[workspace.id]
  if (serverKey !== undefined) return serverKey

  const sessionDerived = getWorkspaceActivityTimestamp(sessions, lastActivityAt)
  if (sessionDerived !== Number.NEGATIVE_INFINITY) return sessionDerived

  return Date.parse(workspace.createdAt ?? '') || 0
}

export function sortWorkspacesByActivity<T extends WorkspaceSortable>(
  workspaces: readonly T[],
  sessionsByWorkspace: Readonly<Record<string, readonly ChatSession[]>>,
  workspaceLastTurnStartedAt: Record<string, number>,
  lastActivityAt: Record<string, number>,
): T[] {
  const timestamps = new Map(
    workspaces.map((workspace) => [
      workspace.id,
      getWorkspaceSortTimestamp(
        workspace,
        sessionsByWorkspace[workspace.id],
        workspaceLastTurnStartedAt,
        lastActivityAt,
      ),
    ]),
  )

  return [...workspaces].sort((left, right) => {
    const leftTimestamp = timestamps.get(left.id) ?? Number.NEGATIVE_INFINITY
    const rightTimestamp = timestamps.get(right.id) ?? Number.NEGATIVE_INFINITY

    if (leftTimestamp === rightTimestamp) return 0
    return rightTimestamp - leftTimestamp
  })
}
