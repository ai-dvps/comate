import { create } from 'zustand'
import type { GitRepository, GitRepositoryCatalog } from '../../server/models/git-graph'
import { gitGraphKey, useGitGraphStore } from './git-graph-store'

interface CatalogState {
  repositories: GitRepository[]
  selectedId: string | null
  loading: boolean
  done: boolean
  errors: GitRepositoryCatalog['errors']
  error: string | null
}
interface RepositoryStore {
  workspaces: Record<string, CatalogState>
  refresh: (workspaceId: string, force?: boolean) => Promise<void>
  select: (workspaceId: string, id: string) => void
  cancel: (workspaceId: string) => void
  clearWorkspace: (workspaceId: string) => void
  reset: () => void
}
const initial = (): CatalogState => ({ repositories: [], selectedId: null, loading: false, done: false, errors: [], error: null })
const requests = new Map<string, { controller: AbortController; promise: Promise<void> }>()

export const useGitRepositoryStore = create<RepositoryStore>((set, get) => ({
  workspaces: {},
  refresh: (workspaceId, force = false) => {
    const pending = requests.get(workspaceId)
    if (pending) return pending.promise
    const controller = new AbortController()
    const currentRequest = () => requests.get(workspaceId)?.controller === controller
    set((state) => ({ workspaces: { ...state.workspaces, [workspaceId]: { ...(state.workspaces[workspaceId] ?? initial()), loading: true, error: null } } }))
    const promise = (async () => {
      try {
        let done = false
        let first = true
        while (!done && !controller.signal.aborted) {
          const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git-graph/repositories${first && force ? '?refresh=true' : ''}`, { signal: controller.signal })
          const body = await res.json() as GitRepositoryCatalog & { error?: string }
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
          if (!currentRequest()) return
          if (!Array.isArray(body.repositories) || typeof body.done !== 'boolean') throw new Error('Invalid repository catalog')
          done = body.done
          first = false
          set((state) => {
            const current = state.workspaces[workspaceId] ?? initial()
            const retained = current.repositories.filter((repo) => !done || body.errors.some((error) => error.relativePath === '.' || repo.relativePath === error.relativePath || repo.relativePath.startsWith(`${error.relativePath}/`)))
            const repositories = [...body.repositories, ...retained.filter((repo) => !body.repositories.some((item) => item.id === repo.id))]
            const selectedId = repositories.some((repo) => repo.id === current.selectedId)
              ? current.selectedId : done ? body.repositories[0]?.id ?? null : current.selectedId
            if (current.selectedId && current.selectedId !== selectedId) useGitGraphStore.getState().cancel(gitGraphKey(workspaceId, current.selectedId))
            return { workspaces: { ...state.workspaces, [workspaceId]: { ...current, repositories, selectedId, done, loading: !done, errors: body.errors, error: null } } }
          })
        }
      } catch (error) {
        if (!currentRequest() || controller.signal.aborted) return
        set((state) => ({ workspaces: { ...state.workspaces, [workspaceId]: { ...(state.workspaces[workspaceId] ?? initial()), loading: false, error: error instanceof Error ? error.message : String(error) } } }))
      } finally {
        if (currentRequest()) requests.delete(workspaceId)
      }
    })()
    requests.set(workspaceId, { controller, promise })
    return promise
  },
  select: (workspaceId, id) => {
    const current = get().workspaces[workspaceId]
    if (!current?.repositories.some((repo) => repo.id === id)) return
    if (current.selectedId && current.selectedId !== id) useGitGraphStore.getState().cancel(gitGraphKey(workspaceId, current.selectedId))
    set((state) => ({ workspaces: { ...state.workspaces, [workspaceId]: { ...current, selectedId: id } } }))
  },
  cancel: (workspaceId) => {
    requests.get(workspaceId)?.controller.abort()
    requests.delete(workspaceId)
    const current = get().workspaces[workspaceId]
    if (current) set((state) => ({ workspaces: { ...state.workspaces, [workspaceId]: { ...current, loading: false } } }))
  },
  clearWorkspace: (workspaceId) => {
    get().cancel(workspaceId)
    useGitGraphStore.getState().clearWorkspace(workspaceId)
    set((state) => { const workspaces = { ...state.workspaces }; delete workspaces[workspaceId]; return { workspaces } })
  },
  reset: () => {
    for (const request of requests.values()) request.controller.abort()
    requests.clear()
    useGitGraphStore.getState().reset()
    set({ workspaces: {} })
  },
}))

// App and Graph share a single focus listener and scan for each visible Workspace.
const observers = new Map<string, number>()
function onFocus() {
  if (document.visibilityState !== 'visible') return
  for (const workspaceId of observers.keys()) void useGitRepositoryStore.getState().refresh(workspaceId)
}
export function observeGitRepositories(workspaceId: string): () => void {
  if (observers.size === 0) window.addEventListener('focus', onFocus)
  observers.set(workspaceId, (observers.get(workspaceId) ?? 0) + 1)
  void useGitRepositoryStore.getState().refresh(workspaceId)
  return () => {
    const count = (observers.get(workspaceId) ?? 1) - 1
    if (count) observers.set(workspaceId, count)
    else { observers.delete(workspaceId); useGitRepositoryStore.getState().cancel(workspaceId) }
    if (!observers.size) window.removeEventListener('focus', onFocus)
  }
}
