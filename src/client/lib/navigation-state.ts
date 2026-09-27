interface NavigationState {
  openWorkspaceIds: string[]
  activeWorkspaceId: string | null
  activeSessionIds: Record<string, string>
}

const STORAGE_KEY = 'comate-navigation-v1'

export function readNavigationState(): NavigationState {
  const empty: NavigationState = { openWorkspaceIds: [], activeWorkspaceId: null, activeSessionIds: {} }
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!value || typeof value !== 'object') return empty
    const openWorkspaceIds = Array.isArray(value.openWorkspaceIds)
      ? [...new Set<string>(value.openWorkspaceIds.filter((id: unknown) => typeof id === 'string' && id))]
      : []
    const activeWorkspaceId = typeof value.activeWorkspaceId === 'string' && value.activeWorkspaceId
      ? value.activeWorkspaceId : null
    if (activeWorkspaceId && !openWorkspaceIds.includes(activeWorkspaceId)) {
      openWorkspaceIds.push(activeWorkspaceId)
    }
    const activeSessionIds = value.activeSessionIds && typeof value.activeSessionIds === 'object' && !Array.isArray(value.activeSessionIds)
      ? Object.fromEntries(Object.entries(value.activeSessionIds).filter(([, id]) => typeof id === 'string')) as Record<string, string>
      : {}
    return { openWorkspaceIds, activeWorkspaceId, activeSessionIds }
  } catch {
    return empty
  }
}

export function saveNavigationState(update: Partial<NavigationState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readNavigationState(), ...update }))
  } catch {
    // Storage can be unavailable or full; navigation must still work.
  }
}

export function saveActiveSessionIds(current: Record<string, string>, previous: Record<string, string>): void {
  const activeSessionIds = readNavigationState().activeSessionIds
  let changed = false
  for (const workspaceId of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    if (current[workspaceId] === previous[workspaceId]) continue
    changed = true
    if (Object.hasOwn(current, workspaceId)) activeSessionIds[workspaceId] = current[workspaceId]
    else delete activeSessionIds[workspaceId]
  }
  // Other renderer windows share storage; preserve their untouched selections.
  if (changed) saveNavigationState({ activeSessionIds })
}
