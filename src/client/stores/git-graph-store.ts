import { create } from 'zustand'
import type { GitGraphCommit, GitGraphSnapshot, GitGraphCommitDetail } from '../../server/models/git-graph'
export type { GitGraphCommit, GitGraphSnapshot, GitGraphCommitDetail, GitGraphChangedFile, GitGraphRef, GitGraphRefType, GitRepositoryState } from '../../server/models/git-graph'

/** A browser context is scoped to both Workspace and repository, never selection. */
export function gitGraphKey(workspaceId: string, repositoryId: string): string {
  return JSON.stringify([workspaceId, repositoryId])
}

function graphTarget(key: string): { workspaceId: string; repositoryId?: string } {
  if (key.startsWith('[')) {
    const [workspaceId, repositoryId] = JSON.parse(key) as [string, string]
    return { workspaceId, repositoryId }
  }
  return { workspaceId: key } // Existing root-only callers remain supported.
}

function graphUrl(key: string, suffix = '', params = new URLSearchParams()): string {
  const { workspaceId, repositoryId } = graphTarget(key)
  if (repositoryId) params.set('repositoryId', repositoryId)
  const query = params.toString()
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/git-graph${suffix}${query ? `?${query}` : ''}`
}

function verifyRepository(key: string, body: { repositoryId?: string }): void {
  const { repositoryId } = graphTarget(key)
  if (repositoryId && body.repositoryId !== repositoryId) throw new Error('Repository response mismatch')
}

export const GIT_GRAPH_INITIAL_LIMIT = 100
export const GIT_GRAPH_PAGE_SIZE = 100
export const GIT_GRAPH_MAX_LIMIT = 500

export interface WorkspaceGitGraphState {
  snapshot: GitGraphSnapshot | null
  selectedRefs: string[]
  loadedLimit: number
  searchText: string
  searchMatches: string[]
  activeSearchMatch: number
  selectedCommitHash: string | null
  detail: GitGraphCommitDetail | null
  scrollAnchor: number | null
  snapshotLoading: boolean
  detailLoading: boolean
  snapshotError: string | null
  detailError: string | null
}

interface GitGraphStoreState {
  workspaces: Record<string, WorkspaceGitGraphState>
  open: (workspaceId: string) => Promise<void>
  refresh: (workspaceId: string) => Promise<void>
  refocus: (workspaceId: string) => Promise<void>
  setFilters: (workspaceId: string, refs: string[]) => Promise<void>
  loadMore: (workspaceId: string) => Promise<void>
  setSearchText: (workspaceId: string, text: string) => void
  nextSearchMatch: (workspaceId: string) => void
  previousSearchMatch: (workspaceId: string) => void
  selectCommit: (workspaceId: string, hash: string | null) => Promise<void>
  setScrollAnchor: (workspaceId: string, anchor: number | null) => void
  clearWorkspace: (workspaceId: string) => void
  cancel: (key: string) => void
  reset: () => void
}

function initialWorkspaceState(): WorkspaceGitGraphState {
  return {
    snapshot: null,
    selectedRefs: [],
    loadedLimit: GIT_GRAPH_INITIAL_LIMIT,
    searchText: '',
    searchMatches: [],
    activeSearchMatch: -1,
    selectedCommitHash: null,
    detail: null,
    scrollAnchor: null,
    snapshotLoading: false,
    detailLoading: false,
    snapshotError: null,
    detailError: null,
  }
}

function workspaceState(state: GitGraphStoreState, workspaceId: string): WorkspaceGitGraphState {
  return state.workspaces[workspaceId] ?? initialWorkspaceState()
}

function matchesSearch(commit: GitGraphCommit, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false
  return [
    commit.hash,
    commit.shortHash,
    commit.authorName,
    commit.subject,
    ...commit.refs.flatMap((ref) => [ref.name, ref.fullName]),
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
}

function searchMatches(snapshot: GitGraphSnapshot | null, text: string): string[] {
  const query = text.trim().toLocaleLowerCase()
  if (!query || !snapshot) return []
  return snapshot.commits.filter((commit) => matchesSearch(commit, query)).map((commit) => commit.hash)
}

function reconciledSelection(
  snapshot: GitGraphSnapshot,
  selectedCommitHash: string | null,
): string | null {
  if (selectedCommitHash && snapshot.commits.some((commit) => commit.hash === selectedCommitHash)) {
    return selectedCommitHash
  }
  return snapshot.commits.find((commit) => commit.isHead)?.hash ?? snapshot.commits[0]?.hash ?? null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body as T
}

const snapshotControllers = new Map<string, AbortController>()
const detailControllers = new Map<string, AbortController>()
const snapshotGenerations = new Map<string, number>()
const detailGenerations = new Map<string, number>()

function nextGeneration(generations: Map<string, number>, workspaceId: string): number {
  const generation = (generations.get(workspaceId) ?? 0) + 1
  generations.set(workspaceId, generation)
  return generation
}

function updateWorkspace(
  set: (updater: (state: GitGraphStoreState) => Partial<GitGraphStoreState>) => void,
  workspaceId: string,
  updater: (current: WorkspaceGitGraphState) => WorkspaceGitGraphState,
): void {
  set((state) => ({
    workspaces: {
      ...state.workspaces,
      [workspaceId]: updater(workspaceState(state, workspaceId)),
    },
  }))
}

export const useGitGraphStore = create<GitGraphStoreState>((set, get) => {
  async function fetchSnapshot(workspaceId: string): Promise<void> {
    snapshotControllers.get(workspaceId)?.abort()
    const controller = new AbortController()
    snapshotControllers.set(workspaceId, controller)
    const generation = nextGeneration(snapshotGenerations, workspaceId)
    const current = workspaceState(get(), workspaceId)
    const params = new URLSearchParams({ limit: String(current.loadedLimit) })
    current.selectedRefs.forEach((ref) => params.append('ref', ref))

    updateWorkspace(set, workspaceId, (workspace) => ({
      ...workspace,
      snapshotLoading: true,
      snapshotError: null,
    }))

    try {
      const response = await fetch(graphUrl(workspaceId, '', params), {
        signal: controller.signal,
      })
      const snapshot = await responseJson<GitGraphSnapshot & { repositoryId?: string }>(response)
      if (snapshotControllers.get(workspaceId) !== controller || snapshotGenerations.get(workspaceId) !== generation) return
      verifyRepository(workspaceId, snapshot)

      const beforeUpdate = workspaceState(get(), workspaceId)
      const nextSelection = reconciledSelection(snapshot, beforeUpdate.selectedCommitHash)
      if (nextSelection !== beforeUpdate.selectedCommitHash) {
        detailControllers.get(workspaceId)?.abort()
        detailControllers.delete(workspaceId)
        nextGeneration(detailGenerations, workspaceId)
      }

      updateWorkspace(set, workspaceId, (workspace) => {
        const selectedCommitHash = nextSelection
        const selectionChanged = selectedCommitHash !== workspace.selectedCommitHash
        const matches = searchMatches(snapshot, workspace.searchText)
        return {
          ...workspace,
          snapshot,
          selectedCommitHash,
          detail: selectionChanged ? null : workspace.detail,
          detailError: selectionChanged ? null : workspace.detailError,
          detailLoading: selectionChanged ? false : workspace.detailLoading,
          searchMatches: matches,
          activeSearchMatch: matches.length > 0 ? Math.min(Math.max(workspace.activeSearchMatch, 0), matches.length - 1) : -1,
          snapshotLoading: false,
          snapshotError: null,
        }
      })
    } catch (error) {
      if (snapshotControllers.get(workspaceId) !== controller || snapshotGenerations.get(workspaceId) !== generation) return
      if (error instanceof Error && error.name === 'AbortError') return
      updateWorkspace(set, workspaceId, (workspace) => ({
        ...workspace,
        snapshotLoading: false,
        snapshot: null,
        detail: null,
        snapshotError: errorMessage(error, 'Failed to load Git graph'),
      }))
    } finally {
      if (snapshotControllers.get(workspaceId) === controller) {
        snapshotControllers.delete(workspaceId)
      }
    }
  }

  return {
    workspaces: {},

    open: fetchSnapshot,
    refresh: fetchSnapshot,
    refocus: fetchSnapshot,

    setFilters: async (workspaceId, refs) => {
      const selectedRefs = [...new Set(refs)]
      updateWorkspace(set, workspaceId, (workspace) => ({
        ...workspace,
        selectedRefs,
        loadedLimit: GIT_GRAPH_INITIAL_LIMIT,
      }))
      await fetchSnapshot(workspaceId)
    },

    loadMore: async (workspaceId) => {
      const current = workspaceState(get(), workspaceId)
      if (
        current.snapshotLoading
        || current.snapshot?.hasMore === false
        || current.loadedLimit >= GIT_GRAPH_MAX_LIMIT
      ) return
      updateWorkspace(set, workspaceId, (workspace) => ({
        ...workspace,
        loadedLimit: Math.min(
          workspace.loadedLimit + GIT_GRAPH_PAGE_SIZE,
          GIT_GRAPH_MAX_LIMIT,
        ),
      }))
      await fetchSnapshot(workspaceId)
    },

    setSearchText: (workspaceId, searchText) => {
      updateWorkspace(set, workspaceId, (workspace) => {
        const matches = searchMatches(workspace.snapshot, searchText)
        return {
          ...workspace,
          searchText,
          searchMatches: matches,
          activeSearchMatch: matches.length > 0 ? 0 : -1,
        }
      })
    },

    nextSearchMatch: (workspaceId) => {
      updateWorkspace(set, workspaceId, (workspace) => ({
        ...workspace,
        activeSearchMatch: workspace.searchMatches.length === 0
          ? -1
          : (workspace.activeSearchMatch + 1) % workspace.searchMatches.length,
      }))
    },

    previousSearchMatch: (workspaceId) => {
      updateWorkspace(set, workspaceId, (workspace) => ({
        ...workspace,
        activeSearchMatch: workspace.searchMatches.length === 0
          ? -1
          : (workspace.activeSearchMatch - 1 + workspace.searchMatches.length) % workspace.searchMatches.length,
      }))
    },

    selectCommit: async (workspaceId, hash) => {
      detailControllers.get(workspaceId)?.abort()
      const generation = nextGeneration(detailGenerations, workspaceId)
      if (!hash) {
        updateWorkspace(set, workspaceId, (workspace) => ({
          ...workspace,
          selectedCommitHash: null,
          detail: null,
          detailError: null,
          detailLoading: false,
        }))
        return
      }

      const controller = new AbortController()
      detailControllers.set(workspaceId, controller)
      updateWorkspace(set, workspaceId, (workspace) => ({
        ...workspace,
        selectedCommitHash: hash,
        detail: workspace.detail?.hash === hash ? workspace.detail : null,
        detailError: null,
        detailLoading: true,
      }))

      try {
        const response = await fetch(
          graphUrl(workspaceId, `/${encodeURIComponent(hash)}`),
          { signal: controller.signal },
        )
        const detail = await responseJson<GitGraphCommitDetail & { repositoryId?: string }>(response)
        if (detailControllers.get(workspaceId) !== controller || detailGenerations.get(workspaceId) !== generation) return
        verifyRepository(workspaceId, detail)
        updateWorkspace(set, workspaceId, (workspace) => ({
          ...workspace,
          detail,
          detailLoading: false,
          detailError: null,
        }))
      } catch (error) {
        if (detailControllers.get(workspaceId) !== controller || detailGenerations.get(workspaceId) !== generation) return
        if (error instanceof Error && error.name === 'AbortError') return
        updateWorkspace(set, workspaceId, (workspace) => ({
          ...workspace,
          detailLoading: false,
          detailError: errorMessage(error, 'Failed to load commit details'),
        }))
      } finally {
        if (detailControllers.get(workspaceId) === controller) {
          detailControllers.delete(workspaceId)
        }
      }
    },

    setScrollAnchor: (workspaceId, scrollAnchor) => {
      updateWorkspace(set, workspaceId, (workspace) => ({ ...workspace, scrollAnchor }))
    },

    cancel: (workspaceId) => {
      snapshotControllers.get(workspaceId)?.abort()
      detailControllers.get(workspaceId)?.abort()
      snapshotControllers.delete(workspaceId)
      detailControllers.delete(workspaceId)
      if (get().workspaces[workspaceId]) updateWorkspace(set, workspaceId, (state) => ({ ...state, snapshotLoading: false, detailLoading: false }))
    },

    clearWorkspace: (workspaceId) => {
      const keys = Object.keys(get().workspaces).filter((key) => key === workspaceId || graphTarget(key).workspaceId === workspaceId)
      for (const key of keys) get().cancel(key)
      for (const key of keys) {
        snapshotGenerations.delete(key)
        detailGenerations.delete(key)
      }
      snapshotGenerations.delete(workspaceId)
      detailGenerations.delete(workspaceId)
      set((state) => {
        const workspaces = { ...state.workspaces }
        for (const key of keys) delete workspaces[key]
        return { workspaces }
      })
    },

    reset: () => {
      for (const controller of snapshotControllers.values()) controller.abort()
      for (const controller of detailControllers.values()) controller.abort()
      snapshotControllers.clear()
      detailControllers.clear()
      snapshotGenerations.clear()
      detailGenerations.clear()
      set({ workspaces: {} })
    },
  }
})

export function getGitGraphWorkspaceState(workspaceId: string): WorkspaceGitGraphState {
  return workspaceState(useGitGraphStore.getState(), workspaceId)
}
