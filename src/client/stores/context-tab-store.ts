import { create } from 'zustand'
import i18next from 'i18next'
import { basename } from '../lib/path-utils'
import { isUntrackedFile } from '../lib/git-status-helpers'
import type { GitStatusItem } from './git-changes-store'
import { useBrowserPaneStore } from './browser-pane-store'
import { getApiBase } from '../lib/desktop-api'
import { wsClient } from '../lib/websocket-client.js'
import type { WsEventMessage } from '@server/websocket/types'
import type { GitGraphChangedFile } from './git-graph-store'

type GitGraphUncomparableReason = 'binary' | 'gitlink'

interface GitGraphFileComparison {
  commitHash: string
  baseHash: string | null
  path: string
  oldPath?: string
  status: GitGraphChangedFile['status']
  original: string
  modified: string
  isBinary: boolean
  isTextComparable: boolean
  uncomparableReason?: GitGraphUncomparableReason
  truncated: boolean
  isDeleted: boolean
}

export interface FileContextTab {
  type: 'file'
  id: string
  workspaceId: string
  path: string
  name: string
  content: string
  isBinary: boolean
  imageDataUrl?: string
  videoUrl?: string
  audioUrl?: string
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

export interface GitGraphContextTab {
  type: 'git-graph'
  id: 'git-graph'
  workspaceId: string
  name: string
}

export interface CommitDiffContextTab {
  type: 'commit-diff'
  id: string
  workspaceId: string
  commitHash: string
  baseHash: string | null
  path: string
  oldPath?: string
  name: string
  statusCode: string
  original: string
  modified: string
  isBinary: boolean
  isGitlink: boolean
  isTextComparable: boolean
  uncomparableReason?: GitGraphUncomparableReason
  truncated: boolean
  isDeleted: boolean
  loading: boolean
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

export type WorkspaceContextTab =
  | FileContextTab
  | ChangesContextTab
  | GitGraphContextTab
  | CommitDiffContextTab
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
  openGitGraph: (workspaceId: string) => void
  openCommitDiff: (
    workspaceId: string,
    commitHash: string,
    baseHash: string | null,
    file: GitGraphChangedFile,
  ) => Promise<void>
  closeTab: (id: string) => void
  /**
   * Event-driven removal of a session's Browser tab (browser_closed) — unlike
   * closeTab it never asks the server to close; the event IS the close.
   */
  removeBrowserTab: (sessionId: string) => void
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

function translatedName(key: string, fallback: string): string {
  const value = i18next.t(key, { defaultValue: fallback })
  return typeof value === 'string' && value ? value : fallback
}

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

function fileRequestKey(workspaceId: string, path: string, preview: boolean): string {
  return preview ? `file-preview:${workspaceId}` : `file:${workspaceId}:${path}`
}

function diffRequestKey(
  workspaceId: string,
  path: string,
  staged: boolean,
  preview: boolean,
): string {
  return preview
    ? `changes-preview:${workspaceId}`
    : `changes:${workspaceId}:${path}:${staged ? 's' : 'w'}`
}

function identityPart(value: string | null | undefined): string {
  const normalized = value ?? ''
  return `${normalized.length}:${normalized}`
}

export function commitDiffTabId(
  commitHash: string,
  baseHash: string | null,
  oldPath: string | undefined,
  path: string,
): string {
  return `commit-diff:${[
    identityPart(commitHash),
    identityPart(baseHash),
    identityPart(oldPath),
    identityPart(path),
  ].join('|')}`
}

function commitDiffRequestKey(workspaceId: string, tabId: string): string {
  return `commit-diff:${workspaceId}:${tabId}`
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

    const key = fileRequestKey(workspaceId, path, preview)
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
      const mediaPath = (data.mimeType?.startsWith('video/') || data.mimeType?.startsWith('audio/'))
        ? `/api/workspaces/${workspaceId}/files/media?path=${encodeURIComponent(path)}`
        : undefined
      const mediaUrl = mediaPath ? `${await getApiBase()}${mediaPath}` : undefined
      const videoUrl = data.mimeType?.startsWith('video/') ? mediaUrl : undefined
      const audioUrl = data.mimeType?.startsWith('audio/') ? mediaUrl : undefined
      if (abortControllers.get(key) !== controller) return
      const tab: FileContextTab = {
        type: 'file',
        id: preview ? 'file:preview' : `file:${path}`,
        workspaceId,
        path,
        name,
        content: imageDataUrl || videoUrl || audioUrl ? '' : typeof data.content === 'string' ? data.content : '',
        isBinary: data.isBinary === true,
        imageDataUrl,
        videoUrl,
        audioUrl,
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

    const key = diffRequestKey(workspaceId, item.path, staged, preview)
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
        : [{
            type: 'browser' as const,
            id,
            sessionId,
            workspaceId,
            name: translatedName('common:shell.browser', 'Browser'),
          }]
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
        name: translatedName('common:shell.files', 'Files'),
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
        name: translatedName('common:shell.changes', 'Changes'),
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

  openGitGraph: (workspaceId) => {
    if (!workspaceId) return
    set((state) => {
      const collection = cloneWorkspaceCollection(state, workspaceId)
      const existing = collection.tabs.find((tab) => tab.type === 'git-graph')
      if (existing) return selectActive(state, workspaceId, existing.id)
      const tab: GitGraphContextTab = {
        type: 'git-graph',
        id: 'git-graph',
        workspaceId,
        name: translatedName('common:shell.gitGraph', 'Git Graph'),
      }
      collection.tabs.push(tab)
      return selectActive({
        ...state,
        workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
      }, workspaceId, tab.id)
    })
  },

  openCommitDiff: async (workspaceId, commitHash, baseHash, file) => {
    if (!workspaceId || !commitHash || !file.path) return
    const id = commitDiffTabId(commitHash, baseHash, file.oldPath, file.path)
    const existing = get().workspaceTabs[workspaceId]?.tabs.find(
      (tab): tab is CommitDiffContextTab => tab.type === 'commit-diff' && tab.id === id,
    )
    if (existing && !existing.loading) {
      set((state) => selectActive(state, workspaceId, id))
      return
    }

    const key = commitDiffRequestKey(workspaceId, id)
    abortRequest(key)
    const controller = new AbortController()
    abortControllers.set(key, controller)
    const pendingTab: CommitDiffContextTab = {
      type: 'commit-diff',
      id,
      workspaceId,
      commitHash,
      baseHash,
      path: file.path,
      oldPath: file.oldPath,
      name: basename(file.path),
      statusCode: file.status,
      original: '',
      modified: '',
      isBinary: file.isBinary,
      isGitlink: file.isGitlink,
      isTextComparable: !file.isBinary && !file.isGitlink,
      uncomparableReason: file.isBinary ? 'binary' : file.isGitlink ? 'gitlink' : undefined,
      truncated: false,
      isDeleted: file.status === 'D',
      loading: true,
    }
    set((state) => {
      const collection = cloneWorkspaceCollection(state, workspaceId)
      collection.tabs = [
        ...collection.tabs.filter((tab) => tab.id !== id),
        pendingTab,
      ]
      return selectActive({
        ...state,
        workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
      }, workspaceId, id)
    })

    try {
      const params = new URLSearchParams({ path: file.path })
      const response = await fetch(
        `/api/workspaces/${workspaceId}/git-graph/${encodeURIComponent(commitHash)}/diff?${params.toString()}`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => ({
          error: i18next.t('common:requestFailed', 'Request failed'),
        }))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const data = await response.json() as GitGraphFileComparison
      if (abortControllers.get(key) !== controller) return
      set((state) => {
        const collection = cloneWorkspaceCollection(state, workspaceId)
        collection.tabs = collection.tabs.map((tab) => tab.id === id
          ? {
              ...pendingTab,
              commitHash: data.commitHash,
              baseHash: data.baseHash,
              path: data.path,
              oldPath: data.oldPath,
              name: basename(data.path),
              statusCode: data.status,
              original: data.original,
              modified: data.modified,
              isBinary: data.isBinary,
              isGitlink: data.uncomparableReason === 'gitlink',
              isTextComparable: data.isTextComparable,
              uncomparableReason: data.uncomparableReason,
              truncated: data.truncated,
              isDeleted: data.isDeleted,
              loading: false,
            }
          : tab)
        return synchronize({
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
        })
      })
    } catch (error) {
      if (isAbortError(error)) return
      if (abortControllers.get(key) !== controller) return
      set((state) => {
        const collection = cloneWorkspaceCollection(state, workspaceId)
        collection.tabs = collection.tabs.map((tab) => tab.id === id
          ? { ...pendingTab, loading: false, error: error instanceof Error ? error.message : String(error) }
          : tab)
        return synchronize({
          ...state,
          workspaceTabs: { ...state.workspaceTabs, [workspaceId]: collection },
        })
      })
    } finally {
      if (abortControllers.get(key) === controller) abortControllers.delete(key)
    }
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
        if (target.type === 'commit-diff') {
          abortRequest(commitDiffRequestKey(target.workspaceId, target.id))
        }
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

  removeBrowserTab: (sessionId) => {
    set((state) => {
      const id = `browser:${sessionId}`
      const collection = state.sessionTabs[sessionId]
      if (!collection || !collection.tabs.some((tab) => tab.id === id)) return state
      // synchronize re-projects openTabs and resolves the selection: a removed
      // active tab falls back to the last projected tab, an untouched
      // selection survives a background session's removal.
      return synchronize({
        ...state,
        sessionTabs: {
          ...state.sessionTabs,
          [sessionId]: {
            workspaceId: collection.workspaceId,
            tabs: collection.tabs.filter((tab) => tab.id !== id),
          },
        },
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

// ---------------------------------------------------------------------------
// Module-level WS wiring (browser-pane-store pattern)
// ---------------------------------------------------------------------------

// browser_closed → retire the session's Browser tab together with the browser.
// The server-side close (agent close tool, state-bar close, idle reclaim,
// session teardown) is the source of truth — the event already IS the close,
// so removeBrowserTab never re-sends browserClose. The pane open flag is
// cleared too, so the persisted map does not remember an open pane for a
// closed browser (a later browser birth re-opens it via the pane store's
// auto-open gates). The listener lives in this module because
// context-tab-store already depends on browser-pane-store — the reverse
// import would be circular.
wsClient.onEvent((msg: WsEventMessage) => {
  if (msg.type !== 'event' || msg.eventType !== 'browser_closed') return
  const sessionId = msg.sessionId
  if (!sessionId) return
  useContextTabStore.getState().removeBrowserTab(sessionId)
  useBrowserPaneStore.getState().setPaneOpen(sessionId, false)
})
