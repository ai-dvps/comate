import { create } from 'zustand'
import i18next from 'i18next'
import { basename } from '../lib/path-utils'
import { isUntrackedFile } from '../lib/git-status-helpers'
import type { GitStatusItem } from '../stores/git-changes-store'

export interface FileTab {
  type: 'file'
  id: string
  path: string
  name: string
  content: string
  isBinary: boolean
}

export interface DiffTab {
  type: 'diff'
  id: string
  path: string
  name: string
  statusCode: string
  original: string
  modified: string
  isBinary: boolean
  truncated: boolean
  isDeleted: boolean
  isUntracked: boolean
  error?: string
}

export type ContentTab = FileTab | DiffTab

interface FileContentResponse {
  path?: string
  content?: string | null
  isBinary?: boolean
  size?: number
}

interface GitCompareResponse {
  original?: string
  modified?: string
  isBinary?: boolean
  truncated?: boolean
  isDeleted?: boolean
}

export interface RightPanelState {
  activeListTab: 'files' | 'git-changes'
  openTabs: ContentTab[]
  activeTabId: string | null
  setActiveListTab: (tab: 'files' | 'git-changes') => void
  openFile: (workspaceId: string, path: string, name: string) => Promise<void>
  openDiff: (workspaceId: string, item: GitStatusItem) => Promise<void>
  closeTab: (id: string) => void
  selectTab: (id: string) => void
  clearTabs: () => void
}

const abortControllers = new Map<string, AbortController>()

function abortInFlight(key: string): void {
  const controller = abortControllers.get(key)
  if (controller) {
    controller.abort()
    abortControllers.delete(key)
  }
}

function getFileTabKey(workspaceId: string, path: string): string {
  return `file:${workspaceId}:${path}`
}

function getDiffTabKey(workspaceId: string, path: string): string {
  return `diff:${workspaceId}:${path}`
}

function getFileTabId(path: string): string {
  return `file:${path}`
}

function getDiffTabId(path: string, statusCode: string): string {
  return `diff:${path}:${statusCode}`
}

function deriveStatusCode(item: GitStatusItem): string {
  if (item.indexStatus && item.indexStatus !== ' ') {
    return item.indexStatus
  }
  return item.workingTreeStatus
}

function deriveStaged(item: GitStatusItem): boolean {
  return (
    item.indexStatus !== ' ' &&
    item.indexStatus !== '?' &&
    item.indexStatus !== ''
  )
}

export const useRightPanelStore = create<RightPanelState>((set, get) => ({
  activeListTab: 'files',
  openTabs: [],
  activeTabId: null,

  setActiveListTab: (tab: 'files' | 'git-changes') => {
    if (get().activeListTab === tab) return
    set({ activeListTab: tab })
  },

  openFile: async (
    workspaceId: string,
    path: string,
    name: string,
  ): Promise<void> => {
    if (!workspaceId || !path) return

    const id = getFileTabId(path)
    const existing = get().openTabs.find((tab) => tab.id === id)
    if (existing) {
      if (get().activeTabId !== id) {
        set({ activeTabId: id })
      }
      return
    }

    abortInFlight(getFileTabKey(workspaceId, path))
    const controller = new AbortController()
    abortControllers.set(getFileTabKey(workspaceId, path), controller)

    try {
      const url = `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({
            error: i18next.t('common:requestFailed', 'Request failed'),
          }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as FileContentResponse
      const tab: FileTab = {
        type: 'file',
        id,
        path,
        name,
        content: typeof data.content === 'string' ? data.content : '',
        isBinary: data.isBinary === true,
      }
      set((state) => ({
        openTabs: [...state.openTabs, tab],
        activeTabId: id,
      }))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (err instanceof Error && err.name === 'AbortError') return
      const message =
        err instanceof Error
          ? err.message
          : i18next.t('common:requestFailed', 'Failed to open file')
      throw new Error(message)
    } finally {
      abortControllers.delete(getFileTabKey(workspaceId, path))
    }
  },

  openDiff: async (
    workspaceId: string,
    item: GitStatusItem,
  ): Promise<void> => {
    if (!workspaceId || !item.path) return

    const statusCode = deriveStatusCode(item)
    const id = getDiffTabId(item.path, statusCode)
    const existing = get().openTabs.find((tab) => tab.id === id)
    if (existing) {
      if (get().activeTabId !== id) {
        set({ activeTabId: id })
      }
      return
    }

    abortInFlight(getDiffTabKey(workspaceId, item.path))
    const controller = new AbortController()
    abortControllers.set(getDiffTabKey(workspaceId, item.path), controller)

    try {
      const staged = deriveStaged(item)
      const params = new URLSearchParams()
      params.set('path', item.path)
      params.set('staged', String(staged))
      if (item.originalPath) {
        params.set('originalPath', item.originalPath)
      }
      const url = `/api/workspaces/${workspaceId}/git-changes/compare?${params.toString()}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({
            error: i18next.t('common:requestFailed', 'Request failed'),
          }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as GitCompareResponse
      const tab: DiffTab = {
        type: 'diff',
        id,
        path: item.path,
        name: basename(item.path),
        statusCode,
        original: typeof data.original === 'string' ? data.original : '',
        modified: typeof data.modified === 'string' ? data.modified : '',
        isBinary: data.isBinary === true,
        truncated: data.truncated === true,
        isDeleted: data.isDeleted === true,
        isUntracked: isUntrackedFile(item),
      }
      set((state) => ({
        openTabs: [...state.openTabs, tab],
        activeTabId: id,
      }))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (err instanceof Error && err.name === 'AbortError') return
      const message =
        err instanceof Error
          ? err.message
          : i18next.t('gitChanges.errorGeneric', 'Failed to load diff')
      throw new Error(message)
    } finally {
      abortControllers.delete(getDiffTabKey(workspaceId, item.path))
    }
  },

  closeTab: (id: string) => {
    set((state) => {
      const index = state.openTabs.findIndex((tab) => tab.id === id)
      if (index === -1) return state
      const nextTabs = state.openTabs.filter((tab) => tab.id !== id)
      let nextActiveId = state.activeTabId
      if (state.activeTabId === id) {
        const nearest = nextTabs[index] ?? nextTabs[index - 1] ?? null
        nextActiveId = nearest?.id ?? null
      }
      return {
        openTabs: nextTabs,
        activeTabId: nextActiveId,
      }
    })
  },

  selectTab: (id: string) => {
    if (get().activeTabId !== id) {
      set({ activeTabId: id })
    }
  },

  clearTabs: () => {
    if (get().openTabs.length === 0 && get().activeTabId === null) return
    set({ openTabs: [], activeTabId: null })
  },
}))
