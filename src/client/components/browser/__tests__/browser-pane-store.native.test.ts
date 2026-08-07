import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const bridgeMock = vi.hoisted(() => ({
  isNativeBrowserView: vi.fn(() => true),
  occlusionListener: null as ((occluded: boolean) => void) | null,
}))

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

vi.mock('../../../lib/browser-view-bridge', () => ({
  isNativeBrowserView: bridgeMock.isNativeBrowserView,
  onBrowserViewOcclusionChange: vi.fn((listener: (occluded: boolean) => void) => {
    bridgeMock.occlusionListener = listener
    return () => {
      bridgeMock.occlusionListener = null
    }
  }),
}))

import {
  useBrowserPaneStore,
  initialSessionBrowserState,
  type SessionBrowserState,
} from '../../../stores/browser-pane-store'

function setSession(patch: Partial<SessionBrowserState>, sessionId = 'sess-1') {
  useBrowserPaneStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: { ...initialSessionBrowserState(), hydrated: true, ...patch },
    },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  bridgeMock.isNativeBrowserView.mockReturnValue(true)
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response),
  )
  useBrowserPaneStore.setState({
    sessions: {},
    nativeViewOccluded: false,
    activeWorkspaceId: null,
    activeSessionId: null,
  })
})

describe('browser-pane-store — native view mode (U8/U9)', () => {
  it('never fetches a viewer URL — the native stack has no iframe fallback', () => {
    // U9 removed the iframe viewer with the legacy browser stack, so no
    // transition ever constructs or fetches a viewer URL, in any environment.
    useBrowserPaneStore.getState()._applyBrowserState('sess-1', { state: 'agent_in_control', port: 1234 })
    const session = useBrowserPaneStore.getState().sessions['sess-1']!
    expect(session.controlState).toBe('agent_in_control')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('session_lost manual retry POSTs the rebuild route', async () => {
    setSession({ controlState: 'session_lost' })
    await useBrowserPaneStore.getState().retrySession('sess-1')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/api/browser/sess-1/retry')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('retrySession swallows a failed rebuild POST (state bar copy carries expectations)', async () => {
    setSession({ controlState: 'session_lost' })
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')))
    await expect(useBrowserPaneStore.getState().retrySession('sess-1')).resolves.toBeUndefined()
  })

  it('retryUnavailable recovers the banner with only the health probe', async () => {
    setSession({ unavailable: { code: 'browser_start_failed', reason: 'x' } })
    await useBrowserPaneStore.getState().retryUnavailable('sess-1')
    const session = useBrowserPaneStore.getState().sessions['sess-1']!
    expect(session.unavailable).toBeNull()
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls).toEqual(['/api/health/browser'])
  })

  it('the occlusion watcher drives the single store flag', () => {
    expect(bridgeMock.occlusionListener).not.toBeNull()
    bridgeMock.occlusionListener!(true)
    expect(useBrowserPaneStore.getState().nativeViewOccluded).toBe(true)
    bridgeMock.occlusionListener!(false)
    expect(useBrowserPaneStore.getState().nativeViewOccluded).toBe(false)
  })
})
