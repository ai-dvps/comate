import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WsEventMessage } from '@server/websocket/types'
import i18n from '../../../i18n'

const wsClientMock = vi.hoisted(() => {
  type Listener = (msg: WsEventMessage) => void
  const listeners = new Set<Listener>()
  return {
    request: vi.fn(() => Promise.resolve({})),
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
    onEvent: vi.fn((cb: Listener) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }),
    onReconnect: vi.fn(() => () => {}),
    onDisconnect: vi.fn(() => () => {}),
    emitEvent: (msg: WsEventMessage) => listeners.forEach((l) => l(msg)),
  }
})

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

import BrowserPane from '../BrowserPane'
import {
  useBrowserPaneStore,
  initialSessionBrowserState,
  type SessionBrowserState,
} from '../../../stores/browser-pane-store'
import { useChatStore } from '../../../stores/chat-store'

const VIEWER_URL =
  'http://127.0.0.1:43210/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/debug?interactive=true&theme=dark&showControls=true'

function renderPane() {
  return render(
    <I18nextProvider i18n={i18n}>
      <BrowserPane workspaceId="ws1" />
    </I18nextProvider>,
  )
}

function setSession(patch: Partial<SessionBrowserState>, sessionId = 'sess-1') {
  act(() => {
    useBrowserPaneStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...initialSessionBrowserState(), hydrated: true, ...patch },
      },
    }))
  })
}

function setChatState(
  patch: {
    activeSessionId?: string | null
    inFlightBrowserTools?: Record<string, ReadonlySet<string>>
  } = {},
) {
  const activeId = patch.activeSessionId === undefined ? 'sess-1' : patch.activeSessionId
  act(() => {
    useChatStore.setState({
      activeSessionIds: activeId ? { ws1: activeId } : {},
      inFlightBrowserTools: patch.inFlightBrowserTools ?? {},
    })
  })
}

function setPane(patch: Partial<ReturnType<typeof useBrowserPaneStore.getState>>) {
  act(() => {
    useBrowserPaneStore.setState(patch)
  })
}

describe('BrowserPane', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
    useBrowserPaneStore.setState({
      isOpen: false,
      width: 480,
      hasOpened: false,
      popoutOpen: false,
      activeWorkspaceId: 'ws1',
      activeSessionId: 'sess-1',
      sessions: {},
    })
    setChatState()
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ url: null }) } as unknown as Response),
    )
  })

  // -- expand / collapse / persistence ----------------------------------------

  it('renders hidden while collapsed and visible once opened; width comes from the store', () => {
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()
    const pane = screen.getByTestId('browser-pane')
    expect(pane).not.toBeVisible()

    act(() => useBrowserPaneStore.getState().setPaneOpen(true))
    expect(pane).toBeVisible()
    expect(pane.style.width).toBe('480px')

    act(() => useBrowserPaneStore.getState().setPaneOpen(false))
    expect(pane).not.toBeVisible()
    expect(localStorage.getItem('browser-pane-open')).toBe('false')
  })

  it('drag-resizing updates and persists the width', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'none' })
    renderPane()

    const handle = screen.getByTestId('browser-pane-resize-handle')
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }))
    fireEvent(window, new MouseEvent('pointermove', { clientX: 400 }))
    // Dragging the left edge 100px left widens the pane by 100px.
    expect(useBrowserPaneStore.getState().width).toBe(580)
    expect(localStorage.getItem('browser-pane-width')).toBe('580')
    fireEvent(window, new MouseEvent('pointerup'))
  })

  // -- keep-alive iframe -------------------------------------------------------

  it('keeps the iframe mounted while collapsed and does not reload on reopen', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    const { container } = renderPane()

    const iframeBefore = container.querySelector('iframe')
    expect(iframeBefore).toBeInTheDocument()
    expect(iframeBefore?.getAttribute('src')).toBe(VIEWER_URL)

    // Collapse: the pane hides, the iframe node survives untouched.
    act(() => useBrowserPaneStore.getState().setPaneOpen(false))
    expect(screen.getByTestId('browser-pane')).not.toBeVisible()
    const iframeCollapsed = container.querySelector('iframe')
    expect(iframeCollapsed).toBe(iframeBefore)

    // Reopen: same element, same src — no reload.
    act(() => useBrowserPaneStore.getState().setPaneOpen(true))
    const iframeAfter = container.querySelector('iframe')
    expect(iframeAfter).toBe(iframeBefore)
    expect(iframeAfter?.getAttribute('src')).toBe(VIEWER_URL)
  })

  it('does not mount the iframe before the pane has ever been opened', () => {
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    const { container } = renderPane()
    expect(container.querySelector('iframe')).not.toBeInTheDocument()
    expect(screen.getByTestId('browser-pane-dormant')).toBeInTheDocument()
  })

  // -- handoff auto-expand ------------------------------------------------------

  it('auto-expands when a handoff arrives over the channel', () => {
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()
    expect(screen.getByTestId('browser-pane')).not.toBeVisible()

    act(() => {
      wsClientMock.emitEvent({
        type: 'event',
        eventType: 'browser_state',
        sessionId: 'sess-1',
        workspaceId: 'ws1',
        data: { type: 'browser_state', sessionId: 'sess-1', workspaceId: 'ws1', state: 'handoff_pending', port: 4001 },
      })
    })

    expect(useBrowserPaneStore.getState().isOpen).toBe(true)
    expect(screen.getByTestId('browser-pane')).toBeVisible()
  })

  // -- session switching (AE3) ---------------------------------------------------

  it('switches the view when the active chat session changes', () => {
    setPane({ isOpen: true, hasOpened: true })
    const otherUrl = VIEWER_URL.replace('43210', '54321')
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    setSession({ controlState: 'user_in_control', port: 4002, viewerUrl: otherUrl }, 'sess-2')
    const { container } = renderPane()
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(VIEWER_URL)

    setChatState({ activeSessionId: 'sess-2' })
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(otherUrl)
    expect(screen.getByTestId('browser-state-label')).toHaveTextContent('You are driving')
  })

  // -- empty state ----------------------------------------------------------------

  it('shows the explanatory empty state (no primary CTA) when the session has no browser', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'none' })
    renderPane()

    const empty = screen.getByTestId('browser-empty-state')
    expect(empty).toHaveTextContent('No browser in this session')
    expect(empty.querySelector('button')).toBeNull()
  })

  // -- F5 progress, open + closed paths --------------------------------------------

  it('shows the determinate progress state with a cancel action while the first tool call starts the browser', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'none' })
    // A browser tool call is in flight (chat-store's F14 in-flight id set).
    setChatState({ inFlightBrowserTools: { 'sess-1': new Set(['t1']) } })
    renderPane()

    expect(screen.getByTestId('browser-start-progress')).toBeInTheDocument()
    expect(screen.getByTestId('browser-start-phase')).toHaveTextContent('Preparing the browser runtime')
    expect(screen.getByTestId('browser-start-percent')).toHaveTextContent('30%')

    const interruptSession = vi.fn(() => Promise.resolve())
    act(() => {
      useChatStore.setState({ interruptSession })
    })
    fireEvent.click(screen.getByTestId('browser-start-cancel'))
    expect(interruptSession).toHaveBeenCalledWith('ws1', 'sess-1')
  })

  it('advances the progress phase once the browser session exists but is not live yet', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'agent_in_control' }) // hydrated, no port yet
    setChatState({ inFlightBrowserTools: { 'sess-1': new Set(['t1']) } })
    renderPane()
    expect(screen.getByTestId('browser-start-phase')).toHaveTextContent('Starting the browser')
    expect(screen.getByTestId('browser-start-percent')).toHaveTextContent('70%')
  })

  it('closed path: the progress UI only lives in the pane; closed pane leaves progress to the in-flight tool call', () => {
    // Pane closed (collapsed): the whole pane is hidden — no progress UI is
    // presented; the chat's in-flight browser tool call is the copy carrier.
    setSession({ controlState: 'none' })
    setChatState({ inFlightBrowserTools: { 'sess-1': new Set(['t1']) } })
    renderPane()
    const pane = screen.getByTestId('browser-pane')
    expect(pane).not.toBeVisible()
    expect(screen.queryByTestId('browser-start-progress')).not.toBeInTheDocument()
  })

  // -- session_lost body -------------------------------------------------------------

  it('shows the crash body with the auto-rebuild note in session_lost', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'session_lost' })
    renderPane()
    const lost = screen.getByTestId('browser-session-lost')
    expect(lost).toHaveTextContent('Browser session lost')
    expect(lost).toHaveTextContent('rebuilds it automatically')
  })

  // -- read-only shield + capture (R4 / a11y) -----------------------------------------

  it('agent driving: a read-only shield blocks the viewer', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()
    expect(screen.getByTestId('browser-readonly-shield')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-capture-shield')).not.toBeInTheDocument()
  })

  it('user driving: click captures input; Esc and window blur release it', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'user_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()

    // Capture: lift the shield (keyboard reachable — it is a button).
    const shield = screen.getByTestId('browser-capture-shield')
    fireEvent.click(shield)
    expect(screen.queryByTestId('browser-capture-shield')).not.toBeInTheDocument()

    // Esc releases the capture.
    fireEvent.keyDown(screen.getByTestId('browser-viewer'), { key: 'Escape' })
    expect(screen.getByTestId('browser-capture-shield')).toBeInTheDocument()

    // Capture again, then window blur releases.
    fireEvent.click(screen.getByTestId('browser-capture-shield'))
    expect(screen.queryByTestId('browser-capture-shield')).not.toBeInTheDocument()
    fireEvent.blur(window)
    expect(screen.getByTestId('browser-capture-shield')).toBeInTheDocument()
  })

  it('sends content-free activity pings on pane interaction while the user drives', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'user_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()
    fireEvent.pointerDown(screen.getByTestId('browser-pane'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserActivityPing', { sessionId: 'sess-1' })
  })

  // -- injection fixture at the component level -----------------------------------------

  it('never renders an iframe for a forged viewer URL (injection fixture)', async () => {
    setPane({ isOpen: true, hasOpened: true })
    // Forge the REST response — the store's shape guard must reject it.
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ url: 'https://evil.com/steal' }),
      } as unknown as Response),
    )
    const { container } = renderPane()

    act(() => {
      useBrowserPaneStore.getState()._applyBrowserState('sess-1', {
        state: 'agent_in_control',
        port: 4001,
      })
    })
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/browser/sess-1/viewer-url'),
    )
    await waitFor(() =>
      expect(useBrowserPaneStore.getState().sessions['sess-1']?.viewerUrl).toBeNull(),
    )
    expect(container.querySelector('iframe')).not.toBeInTheDocument()
  })

  // -- popout handoff ---------------------------------------------------------------

  it('opens the popout from the state bar and swaps the pane body for a placeholder', () => {
    setPane({ isOpen: true, hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    const { container } = renderPane()
    expect(container.querySelector('iframe')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('browser-popout-button'))
    expect(useBrowserPaneStore.getState().popoutOpen).toBe(true)
    expect(screen.getByTestId('browser-popout-placeholder')).toBeInTheDocument()
    expect(container.querySelector('iframe')).not.toBeInTheDocument()
  })
})
