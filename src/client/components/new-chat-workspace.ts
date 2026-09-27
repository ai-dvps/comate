import type { Workspace } from '../stores/workspace-store'

export const CREATE_WORKSPACE_VALUE = '__create_workspace__'

export function chooseDefaultNewChatWorkspace(
  workspaces: Workspace[],
  lastSessionWorkspaceId: string | null | undefined,
): string | null {
  if (lastSessionWorkspaceId && workspaces.some((workspace) => workspace.id === lastSessionWorkspaceId)) {
    return lastSessionWorkspaceId
  }
  if (workspaces.length === 0) return null
  let best = workspaces[0]
  let bestOpened = Date.parse(best.lastOpenedAt ?? '') || 0
  for (let index = 1; index < workspaces.length; index += 1) {
    const workspace = workspaces[index]
    const opened = Date.parse(workspace.lastOpenedAt ?? '') || 0
    if (opened > bestOpened || (opened === bestOpened && Date.parse(workspace.createdAt) > Date.parse(best.createdAt))) {
      best = workspace
      bestOpened = opened
    }
  }
  return best.id
}
