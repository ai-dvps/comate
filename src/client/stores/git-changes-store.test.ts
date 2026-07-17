import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { WsEventMessage } from '@server/websocket/types'

const wsClientMock = vi.hoisted(() => {
  type Listener = (msg: WsEventMessage) => void
  let listener: Listener | null = null
  return {
    request: vi.fn(() => Promise.resolve({})),
    onEvent: vi.fn((cb: Listener) => {
      listener = cb
      return () => {
        listener = null
      }
    }),
    onReconnect: vi.fn(() => () => {}),
    onDisconnect: vi.fn(() => () => {}),
    emitEvent: (msg: WsEventMessage) => listener?.(msg),
  }
})

vi.mock('../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

import { useGitChangesStore } from './git-changes-store'

function resetStore() {
  useGitChangesStore.setState({
    panelVisible: false,
    activeWorkspaceId: null,
    workspaces: {},
  })
}

describe('git-changes-store', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      }),
    ) as unknown as typeof global.fetch
  })

  it('fetches status when the panel becomes visible for the active workspace', async () => {
    const { setPanelVisible, setActiveWorkspaceId } = useGitChangesStore.getState()
    setActiveWorkspaceId('ws1')
    setPanelVisible(true)

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/workspaces/ws1/git-changes',
        expect.any(Object),
      ),
    )

    expect(wsClientMock.request).toHaveBeenCalledWith('subscribeGitChanges', {
      workspaceId: 'ws1',
    })
  })

  it('exposes loading and error states while fetching', async () => {
    const { setPanelVisible, setActiveWorkspaceId } = useGitChangesStore.getState()

    let resolveJson: (value: { items: { path: string; indexStatus: string; workingTreeStatus: string }[] }) => void = () => {}
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolve({
            ok: true,
            json: () =>
              new Promise((r) => {
                resolveJson = r
              }),
          } as unknown as Response)
        }),
    ) as unknown as typeof global.fetch

    setActiveWorkspaceId('ws1')
    setPanelVisible(true)

    await waitFor(() =>
      expect(useGitChangesStore.getState().workspaces['ws1']?.statusLoading).toBe(true),
    )

    resolveJson({ items: [{ path: 'a.ts', indexStatus: 'M', workingTreeStatus: ' ' }] })

    await waitFor(() =>
      expect(useGitChangesStore.getState().workspaces['ws1']?.statusLoading).toBe(false),
    )
    expect(useGitChangesStore.getState().workspaces['ws1']?.statusItems).toHaveLength(1)
  })

  it('refetches status when a WebSocket git_changes event arrives', async () => {
    const { setPanelVisible, setActiveWorkspaceId } = useGitChangesStore.getState()
    setActiveWorkspaceId('ws1')
    setPanelVisible(true)

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    wsClientMock.emitEvent({
      type: 'event',
      eventType: 'git_changes',
      workspaceId: 'ws1',
      data: {
        type: 'git_changes',
        workspaceId: 'ws1',
        items: [{ path: 'b.ts', indexStatus: 'A', workingTreeStatus: ' ' }],
      },
    })

    await waitFor(() =>
      expect(useGitChangesStore.getState().workspaces['ws1']?.statusItems).toEqual([
        { path: 'b.ts', indexStatus: 'A', workingTreeStatus: ' ' },
      ]),
    )
  })

  it('sets isWatcherAvailable to false on watcher_unavailable', async () => {
    const { setPanelVisible, setActiveWorkspaceId } = useGitChangesStore.getState()
    setActiveWorkspaceId('ws1')
    setPanelVisible(true)

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    wsClientMock.emitEvent({
      type: 'event',
      eventType: 'watcher_unavailable',
      workspaceId: 'ws1',
      data: {
        type: 'watcher_unavailable',
        workspaceId: 'ws1',
        reason: 'Too many files',
      },
    })

    await waitFor(() =>
      expect(useGitChangesStore.getState().workspaces['ws1']?.isWatcherAvailable).toBe(false),
    )
  })

  it('loads a diff with the correct staged flag', async () => {
    global.fetch = vi.fn((url) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(url).includes('staged=true')
              ? { diff: 'staged diff', isBinary: false, truncated: false }
              : { diff: 'unstaged diff', isBinary: false, truncated: false },
          ),
      }),
    ) as unknown as typeof global.fetch

    const { openDiff, loadDiff } = useGitChangesStore.getState()

    openDiff('ws1', { path: 'a.ts', indexStatus: 'M', workingTreeStatus: ' ' })
    await loadDiff('ws1')

    expect(useGitChangesStore.getState().workspaces['ws1']?.selectedFile?.staged).toBe(true)
    expect(useGitChangesStore.getState().workspaces['ws1']?.diffContent?.diff).toBe('staged diff')

    openDiff('ws1', { path: 'b.ts', indexStatus: ' ', workingTreeStatus: 'M' })
    await loadDiff('ws1')

    expect(useGitChangesStore.getState().workspaces['ws1']?.selectedFile?.staged).toBe(false)
    expect(useGitChangesStore.getState().workspaces['ws1']?.diffContent?.diff).toBe('unstaged diff')
  })

  it('does not fetch a diff for untracked files', async () => {
    const { openDiff, loadDiff } = useGitChangesStore.getState()
    openDiff('ws1', { path: 'new.txt', indexStatus: '?', workingTreeStatus: '?' })
    await loadDiff('ws1')

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/git-changes/diff'),
      expect.any(Object),
    )
    expect(useGitChangesStore.getState().workspaces['ws1']?.diffContent).toBeNull()
  })

  it('switches view mode per workspace', () => {
    const { setViewMode } = useGitChangesStore.getState()
    setViewMode('ws1', 'flat')
    expect(useGitChangesStore.getState().workspaces['ws1']?.viewMode).toBe('flat')
  })
})
