import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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

function setChatState(activeSessionId: string | null = 'sess-1') {
  act(() => {
    useChatStore.setState({
      activeSessionIds: activeSessionId ? { ws1: activeSessionId } : {},
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
      openBySession: {},
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

  it('renders the state bar and a dormant placeholder before the first open', () => {
    renderPane()
    expect(screen.getByTestId('browser-state-bar')).toBeInTheDocument()
    expect(screen.getByTestId('browser-pane-dormant')).toBeInTheDocument()
    expect(document.querySelector('iframe')).not.toBeInTheDocument()
  })

  it('mounts the iframe once hasOpened becomes true', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    const { container } = renderPane()

    const iframe = container.querySelector('iframe')
    expect(iframe).toBeInTheDocument()
    expect(iframe?.getAttribute('src')).toBe(VIEWER_URL)
  })

  it('does not render anything when the workspace has no active session', () => {
    setChatState(null)
    renderPane()
    expect(screen.queryByTestId('browser-state-bar')).not.toBeInTheDocument()
  })

  it('switches the view when the active chat session changes', () => {
    setPane({ hasOpened: true })
    const otherUrl = VIEWER_URL.replace('43210', '54321')
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    setSession({ controlState: 'user_in_control', port: 4002, viewerUrl: otherUrl }, 'sess-2')
    const { container } = renderPane()
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(VIEWER_URL)

    setChatState('sess-2')
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(otherUrl)
    expect(screen.getByTestId('browser-state-label')).toHaveTextContent('You are driving')
  })

  it('shows the explanatory empty state when the session has no browser', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'none' })
    renderPane()

    const empty = screen.getByTestId('browser-empty-state')
    expect(empty).toHaveTextContent('No browser in this session')
    expect(empty.querySelector('button')).toBeNull()
  })

  it('shows the determinate progress state while the first tool call starts the browser', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'none' })
    act(() => {
      useChatStore.setState({ inFlightBrowserTools: { 'sess-1': new Set(['t1']) } })
    })
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

  it('shows the crash body with the auto-rebuild note in session_lost', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'session_lost' })
    renderPane()
    const lost = screen.getByTestId('browser-session-lost')
    expect(lost).toHaveTextContent('Browser session lost')
    expect(lost).toHaveTextContent('rebuilds it automatically')
  })

  it('agent driving: a read-only shield blocks the viewer', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()
    expect(screen.getByTestId('browser-readonly-shield')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-capture-shield')).not.toBeInTheDocument()
  })

  it('opens the popout from the state bar and swaps the pane body for a placeholder', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001, viewerUrl: VIEWER_URL })
    const { container } = renderPane()
    expect(container.querySelector('iframe')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('browser-popout-button'))
    expect(useBrowserPaneStore.getState().popoutOpen).toBe(true)
    expect(screen.getByTestId('browser-popout-placeholder')).toBeInTheDocument()
    expect(container.querySelector('iframe')).not.toBeInTheDocument()
  })

  it('sends content-free activity pings on pane interaction while the user drives', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'user_in_control', port: 4001, viewerUrl: VIEWER_URL })
    renderPane()
    fireEvent.pointerDown(screen.getByTestId('browser-pane'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserActivityPing', { sessionId: 'sess-1' })
  })
})
