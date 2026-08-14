import { create } from 'zustand'
import i18next from 'i18next'
import { basename } from '../lib/path-utils'
import { isUntrackedFile } from '../lib/git-status-helpers'
import type { GitStatusItem } from './git-changes-store'
import { useBrowserPaneStore } from './browser-pane-store'

export interface FileContextTab {
  type: 'file'
  id: string
  workspaceId: string
  path: string
  name: string
  content: string
  isBinary: boolean
  imageDataUrl?: string
  preview: boolean
}

export interface ChangesContextTab {
  type: 'changes'
  id: string
  workspaceId: string
  path: string
  name: string
  statusCode: string
  staged: boolean
  original: string
  modified: string
  isBinary: boolean
  truncated: boolean
  isDeleted: boolean
  isUntracked: boolean
  preview: boolean
  error?: string
}

export type DiffViewerTab = Omit<ChangesContextTab, 'type'> & { type: 'diff' }

export interface BrowserContextTab {
  type: 'browser'
  id: string
  workspaceId: string
  sessionId: string
  name: string
}

export type WorkspaceContextTab = FileContextTab | ChangesContextTab
export type ContextTab = WorkspaceContextTab | BrowserContextTab

interface WorkspaceTabCollection {
  tabs: WorkspaceContextTab[]
}

interface SessionTabCollection {
  workspaceId: string
  tabs: BrowserContextTab[]
}

interface OpenOptions {
  preview?: boolean
}

interface FileContentResponse {
  content?: string | null
  isBinary?: boolean
  encoding?: string
  mimeType?: string
}

interface GitCompareResponse {
  original?: string
  modified?: string
  isBinary?: boolean
  truncated?: boolean
  isDeleted?: boolean
}

interface ContextTabData {
  workspaceTabs: Record<string, WorkspaceTabCollection>
  sessionTabs: Record<string, SessionTabCollection>
  activeSelections: Record<string, string | null>
  activeWorkspaceId: string | null
  activeSessionId: string | null
  openTabs: ContextTab[]
  activeTabId: string | null
}

export interface ContextTabState extends ContextTabData {
  setContext: (workspaceId: string | null, sessionId: string | null) => void
  openFile: (
    workspaceId: string,
    path: string,
    name: string,
    options?: OpenOptions,
  ) => Promise<void>
  openDiff: (
    workspaceId: string,
    item: GitStatusItem,
    staged?: boolean,
    options?: OpenOptions,
  ) => Promise<void>
  openBrowser: (sessionId: string, workspaceId: string) => void
  openFileWorkspace: (workspaceId: string) => void
  openChangesWorkspace: (workspaceId: string) => void
  closeTab: (id: string) => void
  selectTab: (id: string) => void
  clearWorkspace: (workspaceId: string) => void
  reset: () => void
}

const EMPTY_DATA: ContextTabData = {
  workspaceTabs: {},
  sessionTabs: {},
  activeSelections: {},
  activeWorkspaceId: null,
  activeSessionId: null,
  openTabs: [],
  activeTabId: null,
}

const abortControllers = new Map<string, AbortController>()

function selectionKey(workspaceId: string | null, sessionId: string | null): string {
  return `${workspaceId ?? ''}::${sessionId ?? ''}`
}

function projectedTabs(data: ContextTabData): ContextTab[] {
  if (!data.activeWorkspaceId) return []
  const workspace = data.workspaceTabs[data.activeWorkspaceId]?.tabs ?? []
  if (!data.activeSessionId) return workspace
  const session = data.sessionTabs[data.activeSessionId]
  if (!session || session.workspaceId !== data.activeWorkspaceId) return workspace
  return [...workspace, ...session.tabs]
}

function synchronize(data: ContextTabData): ContextTabData {
  const openTabs = projectedTabs(data)
  const key = selectionKey(data.activeWorkspaceId, data.activeSessionId)
  const selected = data.activeSelections[key]
  const activeTabId = selected && openTabs.some((tab) => tab.id === selected)
    ? selected
    : openTabs.at(-1)?.id ?? null
  return {
    ...data,
    openTabs,
    activeTabId,
    activeSelections: {
      ...data.activeSelections,
      [key]: activeTabId,
    },
  }
}

function selectActive(data: ContextTabData, workspaceId: string, id: string): ContextTabData {
  if (data.activeWorkspaceId !== workspaceId) return synchronize(data)
  const key = selectionKey(data.activeWorkspaceId, data.activeSessionId)
  return synchronize({
    ...data,
    activeSelections: { ...data.activeSelections, [key]: id },
  })
}

function fileRequestKey(workspaceId: string, path: string): string {
  return `file:${workspaceId}:${path}`
}

function diffRequestKey(workspaceId: string, path: string, staged: boolean): string {
  return `changes:${workspaceId}:${path}:${staged ? 's' : 'w'}`
}

function abortRequest(key: string): void {
  abortControllers.get(key)?.abort()
  abortControllers.delete(key)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function deriveStatusCode(item: GitStatusItem): string {
  return item.indexStatus && item.indexStatus !== ' '
    ? item.indexStatus
    : item.workingTreeStatus
}

function deriveStaged(item: GitStatusItem): boolean {
  return item.indexStatus !== ' ' && item.indexStatus !== '?' && item.indexStatus !== ''
}

function cloneWorkspaceCollection(
  state: ContextTabData,
  workspaceId: string,
): WorkspaceTabCollection {
  return { tabs: [...(state.workspaceTabs[workspaceId]?.tabs ?? [])] }
}

export const useContextTabStore = create<ContextTabState>((set, get) => ({
  ...EMPTY_DATA,

  setContext: (workspaceId, sessionId) => {
    set((state) => synchronize({ ...state, activeWorkspaceId: workspaceId, activeSessionId: sessionId }))
  },

  openFile: async (workspaceId, path, name, options = {}) => {
    if (!workspaceId || !path) return
    const preview = options.preview === true
    const current = get()
    const existing = current.workspaceTabs[workspaceId]?.tabs.find(
      (tab): tab is FileContextTab => tab.type === 'file' && tab.path === path,
    )
    if (existing) {
      const id = preview || !existing.preview ? existing.id : `file:${path}`
      set((state) => {
        const collection = cloneWorkspaceCollection(state, workspaceId)
        collection.tabs = collection.tabs.map((tab) => tab.id === existing.id
          ? { ...existing, id, preview: preview && existing.preview }
          : tab)
        return selectActive({
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
        }, workspaceId, id)
      })
      return
    }

    const key = fileRequestKey(workspaceId, path)
    abortRequest(key)
    const controller = new AbortController()
    abortControllers.set(key, controller)
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => ({
          error: i18next.t('common:requestFailed', 'Request failed'),
        }))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const data = await response.json() as FileContentResponse
      if (abortControllers.get(key) !== controller) return
      const imageDataUrl = data.encoding === 'base64'
        && data.mimeType?.startsWith('image/')
        && typeof data.content === 'string'
        ? `data:${data.mimeType};base64,${data.content}`
        : undefined
      const tab: FileContextTab = {
        type: 'file',
        id: preview ? 'file:preview' : `file:${path}`,
        workspaceId,
        path,
        name,
        content: imageDataUrl ? '' : typeof data.content === 'string' ? data.content : '',
        isBinary: data.isBinary === true,
        imageDataUrl,
        preview,
      }
      set((state) => {
        const collection = cloneWorkspaceCollection(state, workspaceId)
        const tabs = preview
          ? collection.tabs.filter((item) => !(item.type === 'file' && item.preview))
          : collection.tabs
        collection.tabs = [...tabs, tab]
        return selectActive({
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
        }, workspaceId, tab.id)
      })
    } catch (error) {
      if (!isAbortError(error)) throw error
    } finally {
      if (abortControllers.get(key) === controller) abortControllers.delete(key)
    }
  },

  openDiff: async (workspaceId, item, stagedOverride, options = {}) => {
    if (!workspaceId || !item.path) return
    const preview = options.preview === true
    const staged = stagedOverride ?? deriveStaged(item)
    const statusCode = deriveStatusCode(item)
    const current = get()
    const existing = current.workspaceTabs[workspaceId]?.tabs.find(
      (tab): tab is ChangesContextTab => tab.type === 'changes'
        && tab.path === item.path
        && tab.staged === staged,
    )
    if (existing) {
      const id = preview || !existing.preview
        ? existing.id
        : `changes:${item.path}:${statusCode}:${staged ? 's' : 'w'}`
      set((state) => {
        const collection = cloneWorkspaceCollection(state, workspaceId)
        collection.tabs = collection.tabs.map((tab) => tab.id === existing.id
          ? { ...existing, id, preview: preview && existing.preview }
          : tab)
        return selectActive({
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
        }, workspaceId, id)
      })
      return
    }

    const key = diffRequestKey(workspaceId, item.path, staged)
    abortRequest(key)
    const controller = new AbortController()
    abortControllers.set(key, controller)
    try {
      const params = new URLSearchParams({ path: item.path, staged: String(staged) })
      if (item.originalPath) params.set('originalPath', item.originalPath)
      const response = await fetch(
        `/api/workspaces/${workspaceId}/git-changes/compare?${params.toString()}`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => ({
          error: i18next.t('common:requestFailed', 'Request failed'),
        }))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const data = await response.json() as GitCompareResponse
      if (abortControllers.get(key) !== controller) return
      const tab: ChangesContextTab = {
        type: 'changes',
        id: preview
          ? 'changes:preview'
          : `changes:${item.path}:${statusCode}:${staged ? 's' : 'w'}`,
        workspaceId,
        path: item.path,
        name: basename(item.path),
        statusCode,
        staged,
        original: typeof data.original === 'string' ? data.original : '',
        modified: typeof data.modified === 'string' ? data.modified : '',
        isBinary: data.isBinary === true,
        truncated: data.truncated === true,
        isDeleted: data.isDeleted === true,
        isUntracked: isUntrackedFile(item),
        preview,
      }
      set((state) => {
        const collection = cloneWorkspaceCollection(state, workspaceId)
        const tabs = preview
          ? collection.tabs.filter((entry) => !(entry.type === 'changes' && entry.preview))
          : collection.tabs
        collection.tabs = [...tabs, tab]
        return selectActive({
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
        }, workspaceId, tab.id)
      })
    } catch (error) {
      if (!isAbortError(error)) throw error
    } finally {
      if (abortControllers.get(key) === controller) abortControllers.delete(key)
    }
  },

  openBrowser: (sessionId, workspaceId) => {
    if (!sessionId || !workspaceId) return
    const id = `browser:${sessionId}`
    set((state) => {
      const current = state.sessionTabs[sessionId]
      const tabs = current?.tabs.some((tab) => tab.id === id)
        ? current.tabs
        : [{ type: 'browser' as const, id, sessionId, workspaceId, name: 'Browser' }]
      const next = {
        ...state,
        sessionTabs: {
          ...state.sessionTabs,
          [sessionId]: { workspaceId, tabs },
        },
      }
      if (state.activeWorkspaceId !== workspaceId || state.activeSessionId !== sessionId) {
        return synchronize(next)
      }
      return selectActive(next, workspaceId, id)
    })
  },

  openFileWorkspace: (workspaceId) => {
    if (!workspaceId) return
    set((state) => {
      const collection = cloneWorkspaceCollection(state, workspaceId)
      const existing = collection.tabs.find((tab) => tab.type === 'file')
      if (existing) return selectActive(state, workspaceId, existing.id)
      const tab: FileContextTab = {
        type: 'file',
        id: 'file:preview',
        workspaceId,
        path: '',
        name: 'Files',
        content: '',
        isBinary: false,
        preview: true,
      }
      collection.tabs.push(tab)
      return selectActive({
        ...state,
        workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
      }, workspaceId, tab.id)
    })
  },

  openChangesWorkspace: (workspaceId) => {
    if (!workspaceId) return
    set((state) => {
      const collection = cloneWorkspaceCollection(state, workspaceId)
      const existing = collection.tabs.find((tab) => tab.type === 'changes')
      if (existing) return selectActive(state, workspaceId, existing.id)
      const tab: ChangesContextTab = {
        type: 'changes',
        id: 'changes:preview',
        workspaceId,
        path: '',
        name: 'Changes',
        statusCode: '',
        staged: false,
        original: '',
        modified: '',
        isBinary: false,
        truncated: false,
        isDeleted: false,
        isUntracked: false,
        preview: true,
      }
      collection.tabs.push(tab)
      return selectActive({
        ...state,
        workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
      }, workspaceId, tab.id)
    })
  },

  closeTab: (id) => {
    set((state) => {
      const index = state.openTabs.findIndex((tab) => tab.id === id)
      if (index < 0) return state
      const target = state.openTabs[index]
      let next: ContextTabData = state
      if (target.type === 'browser') {
        void useBrowserPaneStore.getState().close(target.sessionId)
        const collection = state.sessionTabs[target.sessionId]
        next = {
          ...state,
          sessionTabs: {
            ...state.sessionTabs,
            [target.sessionId]: {
              workspaceId: target.workspaceId,
              tabs: collection.tabs.filter((tab) => tab.id !== id),
            },
          },
        }
      } else {
        const collection = cloneWorkspaceCollection(state, target.workspaceId)
        collection.tabs = collection.tabs.filter((tab) => tab.id !== id)
        next = {
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [target.workspaceId]: collection },
        }
      }
      const remaining = projectedTabs(next)
      const nearest = remaining[index] ?? remaining[index - 1] ?? null
      const key = selectionKey(state.activeWorkspaceId, state.activeSessionId)
      return synchronize({
        ...next,
        activeSelections: { ...next.activeSelections, [key]: nearest?.id ?? null },
      })
    })
  },

  selectTab: (id) => {
    set((state) => {
      if (!state.openTabs.some((tab) => tab.id === id) || state.activeTabId === id) return state
      const key = selectionKey(state.activeWorkspaceId, state.activeSessionId)
      return synchronize({
        ...state,
        activeSelections: { ...state.activeSelections, [key]: id },
      })
    })
  },

  clearWorkspace: (workspaceId) => {
    for (const [key, controller] of abortControllers) {
      if (key.includes(`:${workspaceId}:`)) {
        controller.abort()
        abortControllers.delete(key)
      }
    }
    set((state) => {
      const workspaceTabs = { ...state.workspaceTabs }
      delete workspaceTabs[workspaceId]
      const sessionTabs = Object.fromEntries(
        Object.entries(state.sessionTabs).filter(([, value]) => value.workspaceId !== workspaceId),
      )
      return synchronize({ ...state, workspaceTabs, sessionTabs })
    })
  },

  reset: () => {
    for (const controller of abortControllers.values()) controller.abort()
    abortControllers.clear()
    set(EMPTY_DATA)
  },
}))
