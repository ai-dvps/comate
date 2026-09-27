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

    expect(wsClientMock.request).not.toHaveBeenCalled()
    expect(wsClientMock.onEvent).not.toHaveBeenCalled()
    expect(wsClientMock.onReconnect).not.toHaveBeenCalled()
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

  it('ignores legacy push events and only updates after a manual refresh', async () => {
    const store = useGitChangesStore.getState()
    store.setActiveWorkspaceId('ws1')
    store.setPanelVisible(true)
    await waitFor(() => expect(useGitChangesStore.getState().workspaces.ws1?.statusLoading).toBe(false))
    const items = [{ path: 'b.ts', indexStatus: 'A', workingTreeStatus: ' ' }]
    wsClientMock.emitEvent({ type: 'event', eventType: 'git_changes', workspaceId: 'ws1',
      data: { type: 'git_changes', workspaceId: 'ws1', items } })
    expect(useGitChangesStore.getState().workspaces.ws1.statusItems).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(1)
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ items }) } as Response)
    await store.refresh('ws1')
    expect(useGitChangesStore.getState().workspaces.ws1.statusItems).toEqual(items)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(wsClientMock.request).not.toHaveBeenCalled()
  })

  it('loads a newly selected workspace only while the panel is open', async () => {
    const store = useGitChangesStore.getState()
    store.setActiveWorkspaceId('ws1')
    expect(global.fetch).not.toHaveBeenCalled()
    store.setPanelVisible(true)
    await waitFor(() => expect(useGitChangesStore.getState().workspaces.ws1?.statusLoading).toBe(false))
    store.setActiveWorkspaceId('ws2')
    await waitFor(() => expect(useGitChangesStore.getState().workspaces.ws2?.statusLoading).toBe(false))
    expect(global.fetch).toHaveBeenCalledTimes(2)
    store.setPanelVisible(false)
    store.setActiveWorkspaceId('ws3')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(wsClientMock.request).not.toHaveBeenCalled()
  })

  it('switches view mode per workspace', () => {
    const { setViewMode } = useGitChangesStore.getState()
    setViewMode('ws1', 'flat')
    expect(useGitChangesStore.getState().workspaces['ws1']?.viewMode).toBe('flat')
  })
})
