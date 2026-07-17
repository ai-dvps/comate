import { create } from 'zustand'
import { shallow } from 'zustand/shallow'
import i18next from 'i18next'
import type { WsEventMessage } from '@server/websocket/types'
import { wsClient } from '../lib/websocket-client.js'

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
  isWatcherAvailable: boolean
}

interface GitChangesState {
  panelVisible: boolean
  activeWorkspaceId: string | null
  workspaces: Record<string, WorkspaceGitState>

  setPanelVisible: (visible: boolean) => void
  setActiveWorkspaceId: (workspaceId: string | null) => void
  refresh: (workspaceId: string) => Promise<void>
  setViewMode: (workspaceId: string, mode: GitViewMode) => void

  // Internal setters used by the lifecycle manager and WebSocket handler.
  _setStatusItems: (workspaceId: string, items: GitStatusItem[]) => void
  _setStatusLoading: (workspaceId: string, loading: boolean) => void
  _setStatusError: (workspaceId: string, error: string | null) => void
  _setWatcherAvailable: (workspaceId: string, available: boolean) => void
}

interface GitChangesEventData {
  type: 'git_changes'
  workspaceId: string
  items: GitStatusItem[]
}

function getInitialWorkspaceState(): WorkspaceGitState {
  return {
    statusItems: [],
    statusLoading: false,
    statusError: null,
    viewMode: 'tree',
    isWatcherAvailable: true,
  }
}

function getWorkspaceState(
  state: GitChangesState,
  workspaceId: string,
): WorkspaceGitState {
  return state.workspaces[workspaceId] ?? getInitialWorkspaceState()
}

const abortControllers = new Map<string, AbortController>()
const wsUnsubscribers = new Map<string, () => void>()

function abortInFlightStatus(workspaceId: string): void {
  const controller = abortControllers.get(workspaceId)
  if (controller) {
    controller.abort()
    abortControllers.delete(workspaceId)
  }
}

async function sendSubscribe(workspaceId: string): Promise<void> {
  if (wsUnsubscribers.has(workspaceId)) return
  await wsClient
    .request('subscribeGitChanges', { workspaceId })
    .catch((err) => {
      console.error(`Failed to subscribe to git changes for ${workspaceId}:`, err)
    })
  wsUnsubscribers.set(workspaceId, () => {
    wsClient
      .request('unsubscribeGitChanges', { workspaceId })
      .catch(() => {})
  })
}

function sendUnsubscribe(workspaceId: string): void {
  const unsub = wsUnsubscribers.get(workspaceId)
  if (unsub) {
    unsub()
    wsUnsubscribers.delete(workspaceId)
  }
}

function unsubscribeAll(): void {
  for (const workspaceId of [...wsUnsubscribers.keys()]) {
    sendUnsubscribe(workspaceId)
  }
}

function resubscribeAll(): void {
  for (const workspaceId of [...wsUnsubscribers.keys()]) {
    wsUnsubscribers.delete(workspaceId)
    void sendSubscribe(workspaceId)
  }
}

function syncLifecycle(state: GitChangesState): void {
  const target = state.panelVisible ? state.activeWorkspaceId : null
  if (target && wsUnsubscribers.has(target)) {
    // Already subscribed to the active workspace; refresh is triggered by the
    // action that changed visibility/workspace.
    return
  }
  unsubscribeAll()
  if (target) {
    void sendSubscribe(target)
    void refreshStatus(target)
  }
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
    store._setStatusItems(workspaceId, Array.isArray(data.items) ? data.items : [])
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message =
      err instanceof Error
        ? err.message
        : i18next.t('gitChanges.refreshError', 'Failed to refresh git changes')
    store._setStatusError(workspaceId, message)
  } finally {
    store._setStatusLoading(workspaceId, false)
    abortControllers.delete(workspaceId)
  }
}

wsClient.onEvent((msg: WsEventMessage) => {
  if (msg.eventType === 'git_changes' && msg.workspaceId) {
    const data = msg.data as GitChangesEventData
    const items = Array.isArray(data.items) ? data.items : []
    useGitChangesStore.getState()._setStatusItems(msg.workspaceId, items)
  } else if (msg.eventType === 'watcher_unavailable' && msg.workspaceId) {
    useGitChangesStore.getState()._setWatcherAvailable(msg.workspaceId, false)
  }
})

wsClient.onReconnect(() => {
  resubscribeAll()
})

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

  // Internal setters used by the lifecycle manager and WebSocket handler.
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

  _setWatcherAvailable: (workspaceId: string, available: boolean) => {
    const current = getWorkspaceState(get(), workspaceId)
    if (current.isWatcherAvailable === available) return
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...getWorkspaceState(state, workspaceId),
          isWatcherAvailable: available,
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
        isWatcherAvailable: ws?.isWatcherAvailable ?? true,
      }
    },
    shallow,
  )
}
