import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import i18next from 'i18next'

export interface GitStatusItem {
  path: string
  indexStatus: string
  workingTreeStatus: string
  originalPath?: string
}

export type GitViewMode = 'tree' | 'flat'

interface WorkspaceGitState {
  statusItems: GitStatusItem[]
  statusLoading: boolean
  statusError: string | null
  viewMode: GitViewMode
}

interface GitChangesState {
  panelVisible: boolean
  activeWorkspaceId: string | null
  workspaces: Record<string, WorkspaceGitState>

  setPanelVisible: (visible: boolean) => void
  setActiveWorkspaceId: (workspaceId: string | null) => void
  refresh: (workspaceId: string) => Promise<void>
  setViewMode: (workspaceId: string, mode: GitViewMode) => void

  // Internal setters used by status requests.
  _setStatusItems: (workspaceId: string, items: GitStatusItem[]) => void
  _setStatusLoading: (workspaceId: string, loading: boolean) => void
  _setStatusError: (workspaceId: string, error: string | null) => void
}

function getInitialWorkspaceState(): WorkspaceGitState {
  return {
    statusItems: [],
    statusLoading: false,
    statusError: null,
    viewMode: 'tree',
  }
}

function getWorkspaceState(
  state: GitChangesState,
  workspaceId: string,
): WorkspaceGitState {
  return state.workspaces[workspaceId] ?? getInitialWorkspaceState()
}

const abortControllers = new Map<string, AbortController>()

function abortInFlightStatus(workspaceId: string): void {
  const controller = abortControllers.get(workspaceId)
  if (controller) {
    controller.abort()
    abortControllers.delete(workspaceId)
    useGitChangesStore.getState()._setStatusLoading(workspaceId, false)
  }
}

function syncLifecycle(state: GitChangesState): void {
  for (const workspaceId of abortControllers.keys()) abortInFlightStatus(workspaceId)
  const target = state.panelVisible ? state.activeWorkspaceId : null
  if (target) void refreshStatus(target)
}

async function refreshStatus(workspaceId: string): Promise<void> {
  const store = useGitChangesStore.getState()
  abortInFlightStatus(workspaceId)
  const controller = new AbortController()
  abortControllers.set(workspaceId, controller)

  store._setStatusLoading(workspaceId, true)
  store._setStatusError(workspaceId, null)

  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/git-changes`, {
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => ({ error: i18next.t('common:requestFailed', 'Request failed') }))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const data = (await res.json()) as { items?: GitStatusItem[] }
    if (controller.signal.aborted) return
    store._setStatusItems(workspaceId, Array.isArray(data.items) ? data.items : [])
  } catch (err) {
    if (controller.signal.aborted) return
    const message =
      err instanceof Error
        ? err.message
        : i18next.t('gitChanges.refreshError', 'Failed to refresh git changes')
    store._setStatusError(workspaceId, message)
  } finally {
    // Only clear loading state and the controller entry if this call is still
    // the active one. A newer refresh may have replaced the controller while
    // this (aborted) call was awaiting; clobbering its state would orphan the
    // replacement.
    if (abortControllers.get(workspaceId) === controller) {
      store._setStatusLoading(workspaceId, false)
      abortControllers.delete(workspaceId)
    }
  }
}

export const useGitChangesStore = create<GitChangesState>((set, get) => ({
  panelVisible: false,
  activeWorkspaceId: null,
  workspaces: {},

  setPanelVisible: (visible: boolean) => {
    if (get().panelVisible === visible) return
    set({ panelVisible: visible })
    syncLifecycle(get())
  },

  setActiveWorkspaceId: (workspaceId: string | null) => {
    if (get().activeWorkspaceId === workspaceId) return
    set({ activeWorkspaceId: workspaceId })
    syncLifecycle(get())
  },

  refresh: async (workspaceId: string) => {
    if (!workspaceId) return
    await refreshStatus(workspaceId)
  },

  setViewMode: (workspaceId: string, mode: GitViewMode) => {
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...getWorkspaceState(state, workspaceId),
          viewMode: mode,
        },
      },
    }))
  },

  // Internal setters used by status requests.
  _setStatusItems: (workspaceId: string, items: GitStatusItem[]) => {
    const current = getWorkspaceState(get(), workspaceId)
    if (shallow(current.statusItems, items)) return
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...current,
          statusItems: items,
          statusLoading: false,
          statusError: null,
        },
      },
    }))
  },

  _setStatusLoading: (workspaceId: string, loading: boolean) => {
    const current = getWorkspaceState(get(), workspaceId)
    if (current.statusLoading === loading) return
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...current,
          statusLoading: loading,
        },
      },
    }))
  },

  _setStatusError: (workspaceId: string, error: string | null) => {
    const current = getWorkspaceState(get(), workspaceId)
    if (current.statusError === error) return
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...current,
          statusError: error,
        },
      },
    }))
  },
}))

export function useGitChanges(workspaceId: string | null) {
  return useGitChangesStore(
    (s) => {
      const ws = workspaceId ? s.workspaces[workspaceId] : undefined
      return {
        statusItems: ws?.statusItems ?? [],
        statusLoading: Boolean(ws?.statusLoading),
        statusError: ws?.statusError ?? null,
        viewMode: ws?.viewMode ?? 'tree',
      }
    },
    shallow,
  )
}
