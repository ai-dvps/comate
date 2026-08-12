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
  selectHandoffPending,
  selectHasInFlightBrowserTool,
  selectBrowserStartPhase,
  selectSessionBrowser,
  selectSessionOpen,
  initialSessionBrowserState,
  BROWSER_START_PHASE_PERCENT,
} from '../../../stores/browser-pane-store'
import type { BrowserPaneControlState } from '../../../stores/browser-pane-store'

function mockFetchOk() {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as unknown as Response),
  )
}

function resetPaneStore() {
  useBrowserPaneStore.setState({
    openBySession: {},
    width: 480,
    hasOpened: false,
    popoutOpen: false,
    activeWorkspaceId: null,
    activeSessionId: null,
    sessions: {},
    nativeViewOccluded: false,
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
    mockFetchOk()
  })

  // -- persistence ----------------------------------------------------------

  it('persists per-session open state and width to localStorage', () => {
    const store = useBrowserPaneStore.getState()
    store.setPaneOpen('sess-1', true)
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-1')).toBe(true)
    expect(localStorage.getItem('browser-pane-open-by-session')).toBe(
      JSON.stringify({ 'sess-1': true }),
    )
    store.setWidth(555)
    expect(localStorage.getItem('browser-pane-width')).toBe('555')
    expect(useBrowserPaneStore.getState().width).toBe(555)
    store.setPaneOpen('sess-1', false)
    expect(localStorage.getItem('browser-pane-open-by-session')).toBe(
      JSON.stringify({ 'sess-1': false }),
    )
  })

  it('clamps width to the minimum', () => {
    useBrowserPaneStore.getState().setWidth(10)
    expect(useBrowserPaneStore.getState().width).toBe(320)
  })

  it('marks hasOpened on first open so the viewer surface may mount', () => {
    expect(useBrowserPaneStore.getState().hasOpened).toBe(false)
    useBrowserPaneStore.getState().setPaneOpen('sess-1', true)
    expect(useBrowserPaneStore.getState().hasOpened).toBe(true)
    useBrowserPaneStore.getState().setPaneOpen('sess-1', false)
    expect(useBrowserPaneStore.getState().hasOpened).toBe(true)
  })

  // -- 展开/收起 is independent per session -----------------------------------

  it('keeps the pane open state independent per session', () => {
    const store = useBrowserPaneStore.getState()
    store.setActiveSession('ws1', 'sess-A')
    // Open the pane for session A.
    store.setPaneOpen('sess-A', true)
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-A')).toBe(true)

    // Switch to session B: B starts collapsed, A's open state is retained.
    store.setActiveSession('ws1', 'sess-B')
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-B')).toBe(false)
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-A')).toBe(true)

    // Toggling B open never disturbs A.
    store.togglePane('sess-B')
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-B')).toBe(true)
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-A')).toBe(true)

    // Switching back to A keeps its own (open) state — not B's.
    store.setActiveSession('ws1', 'sess-A')
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-A')).toBe(true)
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-B')).toBe(true)

    // Collapsing A leaves B untouched.
    store.togglePane('sess-A')
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-A')).toBe(false)
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-B')).toBe(true)
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
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-1')).toBe(false)

    wsClientMock.emitEvent(browserStateEvent('sess-1', 'handoff_pending', 4001))

    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-1')).toBe(true)
    expect(localStorage.getItem('browser-pane-open-by-session')).toBe(
      JSON.stringify({ 'sess-1': true }),
    )
    expect(selectHandoffPending(useBrowserPaneStore.getState(), 'sess-1')).toBe(true)
  })

  it('does not auto-expand for a handoff on a background session', () => {
    useBrowserPaneStore.getState().setActiveSession('ws1', 'sess-1')
    wsClientMock.emitEvent(browserStateEvent('sess-other', 'handoff_pending', 4002))
    expect(selectSessionOpen(useBrowserPaneStore.getState(), 'sess-1')).toBe(false)
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

  it('keeps task projection in memory from browser_task_state events', () => {
    wsClientMock.emitEvent({
      type: 'event', eventType: 'browser_task_state', sessionId: 'sess-1', workspaceId: 'ws1',
      data: { type: 'browser_task_state', task: { lifecycle: 'blocked', required: 2, verified: 1, populatedPendingValidation: 0, awaitingAuthority: 0 } },
    } as WsEventMessage)
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.task?.lifecycle).toBe('blocked')
    expect(localStorage.getItem('browser-task-state')).toBeNull()
  })

  // -- U9: no viewer URL exists client-side anymore ---------------------------

  it('never fetches a viewer URL — state transitions perform no client fetch at all', () => {
    const store = useBrowserPaneStore.getState()
    // The iframe viewer and its /viewer-url endpoint left with the legacy
    // browser stack (U9): applying any transition, live or not, must not hit
    // the network from the store.
    store._applyBrowserState('sess-1', { state: 'agent_in_control', port: 4001 })
    store._applyBrowserState('sess-1', { state: 'handoff_pending', port: 4001 })
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    store._applyClosed('sess-1')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('closing a session resets it to the empty browser state', () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'agent_in_control', port: 4001 })
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.controlState).toBe('session_lost')
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

  // -- "记住此站点" remember-site (U8) -----------------------------------------

  it('setRememberSite only applies while the user is driving', () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    store.setRememberSite('sess-1', true)
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.rememberSite).toBe(true)

    store._applyBrowserState('sess-2', { state: 'agent_in_control', port: 4002 })
    store.setRememberSite('sess-2', true)
    expect(useBrowserPaneStore.getState().sessions['sess-2']?.rememberSite).toBe(false)
  })

  it('handback with rememberSite carries the flag and resets the checkbox on save', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    store.setRememberSite('sess-1', true)
    wsClientMock.request.mockResolvedValueOnce({ handedBack: true, siteAuth: { saved: true, key: 'example.com' } })
    await store.handback('sess-1')
    expect(wsClientMock.request).toHaveBeenCalledWith('browserHandback', {
      sessionId: 'sess-1',
      rememberSite: true,
    })
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.rememberSite).toBe(false)
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.verbError).toBeNull()
  })

  it('a failed remember still hands back and surfaces the error', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    store.setRememberSite('sess-1', true)
    wsClientMock.request.mockResolvedValueOnce({
      handedBack: true,
      siteAuth: { saved: false, error: 'Sites addressed by IP literal cannot be remembered.' },
    })
    await store.handback('sess-1')
    const session = useBrowserPaneStore.getState().sessions['sess-1']
    expect(session?.verbError).toBe('Sites addressed by IP literal cannot be remembered.')
    expect(session?.rememberSite).toBe(false)
  })

  it('a state transition clears the checkbox without a handback', () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'user_in_control', port: 4001 })
    store.setRememberSite('sess-1', true)
    // Handoff timeout flips the state without any handback verb.
    store._applyBrowserState('sess-1', { state: 'agent_in_control' })
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.rememberSite).toBe(false)
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

    // Retry after recovery: the banner clears. U9 removed the viewer URL, so
    // the health probe is the only fetch the recovery path makes.
    mockFetchOk()
    await store.retryUnavailable('sess-1')
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.unavailable).toBeNull()
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls).toEqual(['/api/health/browser'])
  })

  it('a live browser_state transition supersedes a stale unavailable banner', () => {
    const store = useBrowserPaneStore.getState()
    store._applyUnavailable('sess-1', { code: 'browser_start_failed', reason: 'boom' })
    store._applyBrowserState('sess-1', { state: 'agent_in_control', port: 4001 })
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.unavailable).toBeNull()
  })

  // -- session_lost manual retry (native rebuild, U8/U9) -----------------------

  it('retrySession POSTs the rebuild route and leaves the state flip to the channel', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    await store.retrySession('sess-1')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/api/browser/sess-1/retry')
    expect((init as RequestInit).method).toBe('POST')
    // The rebuild is reported over the browser_state channel; the local state
    // stays session_lost until that event lands.
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.controlState).toBe('session_lost')
  })

  it('retrySession swallows a failed rebuild POST (the state bar copy carries expectations)', async () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')))
    await expect(store.retrySession('sess-1')).resolves.toBeUndefined()
    expect(useBrowserPaneStore.getState().sessions['sess-1']?.controlState).toBe('session_lost')
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
    // Live control states are always 'starting' — the shell is attaching the
    // native view; there is no viewerUrl signal anymore (U9).
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'agent_in_control' }, true),
    ).toBe('starting')
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'agent_in_control' }, false),
    ).toBe('starting')
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'handoff_pending' }, false),
    ).toBe('starting')
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'user_in_control' }, false),
    ).toBe('starting')
    expect(
      selectBrowserStartPhase({ ...base, controlState: 'session_lost' }, true),
    ).toBeNull()
    expect(BROWSER_START_PHASE_PERCENT.preparing).toBeLessThan(BROWSER_START_PHASE_PERCENT.starting)
  })

  it('selectHasInFlightBrowserTool reads the chat-store in-flight id set', () => {
    // The set's add/remove semantics live in chat-store (see chat-store tests);
    // this selector is the O(1) reader.
    const withUse = { inFlightBrowserTools: { 'sess-1': new Set(['t1']) } }
    expect(selectHasInFlightBrowserTool(withUse as never, 'sess-1')).toBe(true)

    const resolved = { inFlightBrowserTools: { 'sess-1': new Set<string>() } }
    expect(selectHasInFlightBrowserTool(resolved as never, 'sess-1')).toBe(false)

    const unknown = { inFlightBrowserTools: {} }
    expect(selectHasInFlightBrowserTool(unknown as never, 'sess-1')).toBe(false)
    expect(selectHasInFlightBrowserTool(withUse as never, null)).toBe(false)
  })

  it('selectSessionBrowser returns a stable empty reference for unknown sessions', () => {
    const state = useBrowserPaneStore.getState()
    expect(selectSessionBrowser(state, 'nope')).toBe(selectSessionBrowser(state, 'nope'))
    expect(selectSessionBrowser(state, null)).toEqual(initialSessionBrowserState())
  })

  it('ignores a duplicate browser_state event without rebuilding the sessions object (F16)', () => {
    const store = useBrowserPaneStore.getState()
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    const before = useBrowserPaneStore.getState().sessions
    // Identical replay (e.g. WS reconnect hydration): no state change at all.
    store._applyBrowserState('sess-1', { state: 'session_lost' })
    expect(useBrowserPaneStore.getState().sessions).toBe(before)
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
