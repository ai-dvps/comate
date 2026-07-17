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

  it('switches view mode per workspace', () => {
    const { setViewMode } = useGitChangesStore.getState()
    setViewMode('ws1', 'flat')
    expect(useGitChangesStore.getState().workspaces['ws1']?.viewMode).toBe('flat')
  })
})
