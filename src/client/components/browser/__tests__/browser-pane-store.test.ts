import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { WsEventMessage } from '@server/websocket/types'

const wsClientMock = vi.hoisted(() => {
  type Listener = (msg: WsEventMessage) => void
  let listener: Listener | null = null
  let reconnectListener: (() => void) | null = null
  return {
    request: vi.fn(() => Promise.resolve({})),
    onEvent: vi.fn((cb: Listener) => {
      listener = cb
      return () => {
        listener = null
      }
    }),
    onReconnect: vi.fn((cb: () => void) => {
      reconnectListener = cb
      return () => {
        reconnectListener = null
      }
    }),
    onDisconnect: vi.fn(() => () => {}),
    emitEvent: (msg: WsEventMessage) => listener?.(msg),
    emitReconnect: () => reconnectListener?.(),
  }
})

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

import {
  useBrowserPaneStore,
  sanitizeViewerUrl,
  selectHandoffPending,
  selectHasInFlightBrowserTool,
  selectBrowserStartPhase,
  initialSessionBrowserState,
  BROWSER_START_PHASE_PERCENT,
} from '../../../stores/browser-pane-store'
import type { BrowserPaneControlState } from '../../../stores/browser-pane-store'

const VIEWER_URL =
  'http://127.0.0.1:43210/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/debug?interactive=true&theme=dark&showControls=true'

function mockViewerUrlFetch(url: string | null) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ url }),
    } as unknown as Response),
  )
}

function resetPaneStore() {
  useBrowserPaneStore.setState({
    isOpen: false,
    width: 480,
    hasOpened: false,
    popoutOpen: false,
    activeWorkspaceId: null,
    activeSessionId: null,
    sessions: {},
  })
}

function browserStateEvent(
  sessionId: string,
  state: BrowserPaneControlState,
  port?: number,
): WsEventMessage {
  return {
    type: 'event',
    eventType: 'browser_state',
    sessionId,
    workspaceId: 'ws1',
    data: { type: 'browser_state', sessionId, workspaceId: 'ws1', state, ...(port ? { port } : {}) },
  }
}

describe('browser-pane-store', () => {
  beforeEach(() => {
    localStorage.clear()
    // Park the active session so module-level subscription state is quiesced.
    useBrowserPaneStore.getState().setActiveSession(null, null)
    resetPaneStore()
    vi.clearAllMocks()
    mockViewerUrlFetch(null)
  })

  // -- persistence ----------------------------------------------------------

  it('persists open state and width to localStorage', () => {
    const store = useBrowserPaneStore.getState()
    store.setPaneOpen(true)
    expect(localStorage.getItem('browser-pane-open')).toBe('true')
    store.setWidth(555)
    expect(localStorage.getItem('browser-pane-width')).toBe('555')
    expect(useBrowserPaneStore.getState().width).toBe(555)
    store.setPaneOpen(false)
    expect(localStorage.getItem('browser-pane-open')).toBe('false')
  })

  it('clamps width to the minimum', () => {
    useBrowserPaneStore.getState().setWidth(10)
    expect(useBrowserPaneStore.getState().width).toBe(320)
  })

  it('marks hasOpened on first open so the iframe may mount', () => {
    expect(useBrowserPaneStore.getState().hasOpened).toBe(false)
    useBrowserPaneStore.getState().setPaneOpen(true)
    expect(useBrowserPaneStore.getState().hasOpened).toBe(true)
    useBrowserPaneStore.getState().setPaneOpen(false)
    expect(useBrowserPaneStore.getState().hasOpened).toBe(true)
  })

  // -- handoff: badge + auto-expand -----------------------------------------

  it('auto-expands the pane and exposes the handoff badge when a handoff arrives for the active session', async () => {
    const store = useBrowserPaneStore.getState()
    store.setActiveSession('ws1', 'sess-1')
    await waitFor(() =>
      expect(wsClientMock.request).toHaveBeenCalledWith('subscribeBrowserState', {
        workspaceId: 'ws1',
        sessionId: 'sess-1',
      }),
    )
    expect(useBrowserPaneStore.getState().isOpen).toBe(false)

    wsClientMock.emitEvent(browserStateEvent('sess-1', 'handoff_pending', 4001))

    expect(useBrowserPaneStore.getState().isOpen).toBe(true)
    expect(localStorage.getItem('browser-pane-open')).toBe('true')
    expect(selectHandoffPending(useBrowserPaneStore.getState(), 'sess-1')).toBe(true)
  })

  it('does not auto-expand for a handoff on a background session', () => {
    useBrowserPaneStore.getState().setActiveSession('ws1', 'sess-1')
    wsClientMock.emitEvent(browserStateEvent('sess-other', 'handoff_pending', 4002))
    expect(useBrowserPaneStore.getState().isOpen).toBe(false)
    expect(selectHandoffPending(useBrowserPaneStore.getState(), 'sess-other')).toBe(true)
  })

  // -- AE3: follow the active session ---------------------------------------

  it('switches its subscription when the active session changes and keeps per-session state', async () => {
    const store = useBrowserPaneStore.getState()
    store.setActiveSession('ws1', 'sess-1')
    await waitFor(() =>
      expect(wsClientMock.request).toHaveBeenCalledWith('subscribeBrowserState', {
        workspaceId: 'ws1',
        sessionId: 'sess-1',
      }),
    )
    wsClientMock.emitEvent(browserStateEvent('sess-1', 'agent_in_control', 4001))

    store.setActiveSession('ws1', 'sess-2')
    await waitFor(() =>
      expect(wsClientMock.request).toHaveBeenCalledWith('subscribeBrowserState', {
        workspaceId: 'ws1',
        sessionId: 'sess-2',
      }),
    )
    expect(wsClientMock.request).toHaveBeenCalledWith('unsubscribeBrowserState', {
      sessionId: 'sess-1',
    })

    // Session 1's browser state is retained (the server browser keeps
    // running); the pane simply shows the newly active session (AE3).
    const sessions = useBrowserPaneStore.getState().sessions
    expect(sessions['sess-1']?.controlState).toBe('agent_in_control')
    expect(sessions['sess-2']).toBeUndefined()

    wsClientMock.emitEvent(browserStateEvent('sess-2', 'user_in_control', 4002))
    expect(useBrowserPaneStore.getState().sessions['sess-2']?.controlState).toBe('user_in_control')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.controlState).toBe('agent_in_control')
  })

  it('resubscribes on reconnect', async () => {
    useBrowserPaneStore.getState().setActiveSession('ws1', 'sess-1')
    await waitFor(() =>
      expect(wsClientMock.request).toHaveBeenCalledWith('subscribeBrowserState', {
        workspaceId: 'ws1',
        sessionId: 'sess-1',
      }),
    )
    vi.clearAllMocks()
    wsClientMock.emitReconnect()
    await waitFor(() =>
      expect(wsClientMock.request).toHaveBeenCalledWith('subscribeBrowserState', {
        workspaceId: 'ws1',
        sessionId: 'sess-1',
      }),
    )
  })

  // -- viewer URL channel + injection fixture --------------------------------

  it('fetches the server-constructed viewer URL on live transitions', async () => {
    mockViewerUrlFetch(VIEWER_URL)
    useBrowserPaneStore.getState()._applyBrowserState('sess-1', {
      state: 'agent_in_control',
      port: 4001,
    })
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/browser/sess-1/viewer-url'),
    )
    await waitFor(() =>
      expect(useBrowserPaneStore.getState().sessions['sess-1']?.viewerUrl).toBe(VIEWER_URL),
    )
  })

  it('sanitizeViewerUrl accepts only the exact viewer-proxy shape', () => {
    expect(sanitizeViewerUrl(VIEWER_URL)).toBe(VIEWER_URL)
    // Injection fixture: nothing agent/user-constructed may pass.
    expect(sanitizeViewerUrl('https://evil.com/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/debug?x=1')).toBeNull()
    expect(sanitizeViewerUrl('http://127.0.0.1.evil.com:1/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/debug?x=1')).toBeNull()
    expect(sanitizeViewerUrl('http://localhost:43210/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/debug?x=1')).toBeNull()
    expect(sanitizeViewerUrl('http://127.0.0.1:43210/s/short/v1/sessions/debug?x=1')).toBeNull()
    expect(sanitizeViewerUrl('http://127.0.0.1:43210/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/cast')).toBeNull()
    expect(sanitizeViewerUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeViewerUrl('')).toBeNull()
    expect(sanitizeViewerUrl(null)).toBeNull()
    expect(sanitizeViewerUrl(42)).toBeNull()
    expect(sanitizeViewerUrl(undefined)).toBeNull()
  })

  it('rejects a forged viewer-url REST response — the iframe src never comes from injected input', async () => {
    mockViewerUrlFetch('https://evil.com/pwned' as unknown as string)
    useBrowserPaneStore.getState()._applyBrowserState('sess-1', {
      state: 'agent_in_control',
      port: 4001,
    })
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/browser/sess-1/viewer-url'),
    )
    await waitFor(() =>
      expect(useBrowserPaneStore.getState().sessions['sess-1']?.viewerUrl).toBeNull(),
    )
  })

  it('clears the viewer URL when the session is lost or closed', async () => {
    mockViewerUrlFetch(VIEWER_URL)
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'agent_in_control', port: 4001 })
    await waitFor(() =>
      expect(useBrowserPaneStore.getState().sessions['sess-1']?.viewerUrl).toBe(VIEWER_URL),
    )
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.viewerUrl).toBeNull()
    store._applyClosed('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.controlState).toBe('none')
  })

  // -- verbs + busy window ----------------------------------------------------

  it('takeover sends the WS verb and keeps the busy window until the state flip arrives', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'handoff_pending', port: 4001 })

    const verbPromise = store.takeover('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.pendingVerb).toBe('takeover')
    await verbPromise

    expect(wsClientMock.request).toHaveBeenCalledWith('browserTakeover', { sessionId: 'sess-1' })
    // handoff grant: the flip lands when the agent's in-progress action
    // completes — the busy window is still up.
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.pendingVerb).toBe('takeover')

    wsClientMock.emitEvent(browserStateEvent('sess-1', 'user_in_control', 4001))
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.pendingVerb).toBeNull()
  })

  it('settles the busy window for synchronous flips (proactive takeover)', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'agent_in_control', port: 4001 })
    // Synchronous flip arrives before the verb response resolves.
    wsClientMock.request.mockImplementationOnce(() => {
      wsClientMock.emitEvent(browserStateEvent('sess-1', 'user_in_control', 4001))
      return Promise.resolve({})
    })
    await store.takeover('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.pendingVerb).toBeNull()
  })

  it('surfaces verb errors and clears them on the next state event', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    wsClientMock.request.mockRejectedValueOnce(new Error('The browser session was lost.'))
    await store.takeover('sess-1')
    const afterError = useBrowserPaneStore.getState().sessions['sess-1']
    expect(afterError?.pendingVerb).toBeNull()
    expect(afterError?.verbError).toBe('The browser session was lost.')

    wsClientMock.emitEvent(browserStateEvent('sess-1', 'agent_in_control', 4002))
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.verbError).toBeNull()
  })

  it('handback sends the handback verb', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    const p = store.handback('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.pendingVerb).toBe('handback')
    await p
    expect(wsClientMock.request).toHaveBeenCalledWith('browserHandback', { sessionId: 'sess-1' })
  })

  // -- browser_unavailable degraded path --------------------------------------

  it('browser_unavailable sets the degraded state; retry clears it when health recovers', async () => {
    const store = useBrowserPaneStore.getState()
    wsClientMock.emitEvent({
      type: 'event',
      eventType: 'browser_unavailable',
      sessionId: 'sess-1',
      workspaceId: 'ws1',
      data: {
        type: 'browser_unavailable',
        sessionId: 'sess-1',
        workspaceId: 'ws1',
        code: 'browser_chromium_missing',
        reason: 'No Chromium executable available',
      },
    })
    const degraded = useBrowserPaneStore.getState().sessions['sess-1']
    expect(degraded?.unavailable?.code).toBe('browser_chromium_missing')

    // Retry while still unhealthy: banner stays, with refreshed reason.
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'still missing' }),
      } as unknown as Response),
    )
    await store.retryUnavailable('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.unavailable?.reason).toBe('still missing')

    // Retry after recovery: banner clears and the viewer URL is refetched.
    global.fetch = vi.fn((input) => {
      const url = String(input)
      if (url === '/api/health/browser') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ url: null }),
      } as unknown as Response)
    }) as unknown as typeof global.fetch
    await store.retryUnavailable('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.unavailable).toBeNull()
  })

  it('a live browser_state transition supersedes a stale unavailable banner', () => {
    const store = useBrowserPaneStore.getState()
    store._applyUnavailable('sess-1', { code: 'browser_start_failed', reason: 'boom' })
    store._applyBrowserState('sess-1', { state: 'agent_in_control', port: 4001 })
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.unavailable).toBeNull()
  })

  // -- session_lost manual retry ----------------------------------------------

  it('retryViewer bumps the iframe nonce when the browser is live again', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    mockViewerUrlFetch(VIEWER_URL)
    await store.retryViewer('sess-1')
    const session = useBrowserPaneStore.getState().sessions['sess-1']
    expect(session?.viewerUrl).toBe(VIEWER_URL)
    expect(session?.viewerNonce).toBe(1)
  })

  it('retryViewer leaves the lost state untouched while the browser is still dead', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    mockViewerUrlFetch(null)
    await store.retryViewer('sess-1')
    const session = useBrowserPaneStore.getState().sessions['sess-1']
    expect(session?.viewerUrl).toBeNull()
    expect(session?.viewerNonce).toBe(0)
    expect(session?.controlState).toBe('session_lost')
  })

  // -- activity ping ------------------------------------------------------------

  it('recordActivity sends content-free pings, throttled, only in live states', () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    store.recordActivity('sess-1')
    store.recordActivity('sess-1')
    expect(wsClientMock.request).toHaveBeenCalledTimes(1)
    expect(wsClientMock.request).toHaveBeenCalledWith('browserActivityPing', {
      sessionId: 'sess-1',
    })

    vi.clearAllMocks()
    store._applyBrowserState('sess-2', { state: 'none' })
    store.recordActivity('sess-2')
    expect(wsClientMock.request).not.toHaveBeenCalled()
  })

  // -- F5 progress derivation ---------------------------------------------------

  it('derives the first-use progress phase from observable signals', () => {
    const base = initialSessionBrowserState()
    expect(selectBrowserStartPhase(base, false)).toBeNull()
    expect(selectBrowserStartPhase(base, true)).toBe('preparing')
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'agent_in_control' }, true),
    ).toBe('starting')
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'session_lost' }, true),
    ).toBeNull()
    expect(selectBrowserStartPhase({ ...base, viewerUrl: VIEWER_URL }, true)).toBeNull()
    expect(BROWSER_START_PHASE_PERCENT.preparing).toBeLessThan(BROWSER_START_PHASE_PERCENT.starting)
  })

  it('selectHasInFlightBrowserTool spots an unresolved browser tool call', () => {
    const state = {
      messages: {
        'sess-1': [
          {
            parts: [
              { type: 'tool_use' as const, toolUseId: 't1', toolName: 'mcp__comate-browser__open' },
            ],
          },
        ],
      },
    }
    expect(selectHasInFlightBrowserTool(state as never, 'sess-1')).toBe(true)

    const resolved = {
      messages: {
        'sess-1': [
          {
            parts: [
              { type: 'tool_use' as const, toolUseId: 't1', toolName: 'mcp__comate-browser__open' },
              { type: 'tool_result' as const, toolUseId: 't1' },
            ],
          },
        ],
      },
    }
    expect(selectHasInFlightBrowserTool(resolved as never, 'sess-1')).toBe(false)

    const nonBrowser = {
      messages: {
        'sess-1': [
          { parts: [{ type: 'tool_use' as const, toolUseId: 't2', toolName: 'Bash' }] },
        ],
      },
    }
    expect(selectHasInFlightBrowserTool(nonBrowser as never, 'sess-1')).toBe(false)
    expect(selectHasInFlightBrowserTool(state as never, null)).toBe(false)
  })

  it('module-level wiring routes browser events into the store', () => {
    wsClientMock.emitEvent(browserStateEvent('sess-9', 'agent_in_control', 4100))
    expect(useBrowserPaneStore.getState().sessions['sess-9']?.controlState).toBe('agent_in_control')
    wsClientMock.emitEvent({
      type: 'event',
      eventType: 'browser_closed',
      sessionId: 'sess-9',
      workspaceId: 'ws1',
      data: { type: 'browser_closed', sessionId: 'sess-9', workspaceId: 'ws1' },
    })
    expect(useBrowserPaneStore.getState().sessions['sess-9']?.controlState).toBe('none')
  })
})
