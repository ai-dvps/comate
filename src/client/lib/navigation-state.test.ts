import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('navigation across restarts', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    vi.stubGlobal('WebSocket', undefined)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function stores() {
    const { useWorkspaceStore } = await import('../stores/workspace-store')
    const { useChatStore } = await import('../stores/chat-store')
    const { wsClient } = await import('../lib/websocket-client')
    vi.spyOn(wsClient, 'request').mockResolvedValue({})
    return { workspace: useWorkspaceStore, chat: useChatStore, wsClient }
  }

  function serve(workspaceIds = ['w1', 'w2'], sessionIds = ['s1']) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url === '/api/workspaces'
        ? { workspaces: workspaceIds.map((id) => ({ id })) }
        : url.split('?')[0].endsWith('/sessions')
          ? { sessions: sessionIds.map((id) => ({ id, source: 'gui' })) }
          : {},
    })))
  }

  it('restores open workspaces and selected session, including its subscription', async () => {
    serve()
    const first = await stores()
    await first.workspace.getState().openWorkspace('w1')
    await first.workspace.getState().openWorkspace('w2')
    first.chat.getState().setActiveSession('w2', 's1')

    vi.resetModules()
    const next = await stores()
    await next.workspace.getState().fetchWorkspaces()
    await next.chat.getState().fetchSessions('w2')
    expect(next.workspace.getState().openWorkspaceIds).toEqual(['w1', 'w2'])
    expect(next.workspace.getState().activeWorkspaceId).toBe('w2')
    expect(next.chat.getState().activeSessionIds.w2).toBe('s1')
    expect(next.wsClient.request).toHaveBeenCalledWith('subscribe', expect.objectContaining({ sessionId: 's1' }), expect.any(Number))
  })

  it('drops deleted workspaces and sessions after successful fetches', async () => {
    serve()
    const first = await stores()
    await first.workspace.getState().openWorkspace('w1')
    await first.workspace.getState().openWorkspace('w2')
    first.chat.getState().setActiveSession('w1', 'deleted')
    vi.resetModules()
    serve(['w1'], [])
    const next = await stores()
    await next.workspace.getState().fetchWorkspaces()
    await next.chat.getState().fetchSessions('w1')
    expect(next.workspace.getState().openWorkspaceIds).toEqual(['w1'])
    expect(next.workspace.getState().activeWorkspaceId).toBe('w1')
    expect(next.chat.getState().activeSessionIds.w1).toBeUndefined()
  })

  it('preserves saved selections through a failed startup and retry', async () => {
    serve()
    const first = await stores()
    await first.workspace.getState().openWorkspace('w1')
    first.chat.getState().setActiveSession('w1', 's1')
    vi.resetModules()
    const next = await stores()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await next.workspace.getState().fetchWorkspaces()
    await next.chat.getState().fetchSessions('w1')
    expect(next.workspace.getState().activeWorkspaceId).toBe('w1')
    expect(next.chat.getState().activeSessionIds.w1).toBe('s1')
    serve()
    await next.workspace.getState().fetchWorkspaces()
    await next.chat.getState().fetchSessions('w1')
    expect(next.chat.getState().activeSessionIds.w1).toBe('s1')
  })

  it('remembers closing all workspaces', async () => {
    serve()
    const first = await stores()
    await first.workspace.getState().openWorkspace('w1')
    first.workspace.getState().closeWorkspace('w1')
    vi.resetModules()
    const next = await stores()
    await next.workspace.getState().fetchWorkspaces()
    expect(next.workspace.getState().activeWorkspaceId).toBeNull()
    expect(next.workspace.getState().openWorkspaceIds).toEqual([])
  })

  it('ignores corrupt storage and survives unavailable storage', async () => {
    localStorage.setItem('comate-navigation-v1', '{broken')
    const state = await stores()
    expect(state.workspace.getState().openWorkspaceIds).toEqual([])
    expect(state.chat.getState().activeSessionIds).toEqual({})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    serve()
    await state.workspace.getState().openWorkspace('w1')
    state.chat.getState().setActiveSession('w1', 's1')
    expect(state.workspace.getState().activeWorkspaceId).toBe('w1')
    expect(state.chat.getState().activeSessionIds.w1).toBe('s1')
  })

  it('merges session changes without overwriting another window', async () => {
    const state = await stores()
    state.chat.getState().setActiveSession('w1', 's1')
    const { readNavigationState, saveNavigationState } = await import('./navigation-state')
    saveNavigationState({ activeSessionIds: { w1: 'newer', w2: 's2' } })
    state.chat.getState().setActiveSession('w3', 's3')
    expect(readNavigationState().activeSessionIds).toEqual({ w1: 'newer', w2: 's2', w3: 's3' })
    state.chat.setState({ activeSessionIds: { w1: 's1', w3: 's3' } })
    expect(readNavigationState().activeSessionIds.w2).toBe('s2')
    state.chat.setState({ activeSessionIds: { w1: 's1' } })
    expect(readNavigationState().activeSessionIds.w3).toBeUndefined()
  })

  it('does not clear a selection made while the session list is loading', async () => {
    const state = await stores()
    state.chat.getState().setActiveSession('w1', 's1')
    let respond!: (value: unknown) => void
    const pending = new Promise((resolve) => { respond = resolve })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const loading = state.chat.getState().fetchSessions('w1')
    state.chat.getState().setActiveSession('w1', 'new-session')
    respond({ ok: true, json: async () => ({ sessions: [] }) })
    await loading
    expect(state.chat.getState().activeSessionIds.w1).toBe('new-session')
  })
})
