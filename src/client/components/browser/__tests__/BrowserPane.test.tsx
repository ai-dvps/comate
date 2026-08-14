import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
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

const bridgeMock = vi.hoisted(() => ({
  isNativeBrowserView: vi.fn(() => true),
  reportBrowserViewRect: vi.fn(),
  setBrowserViewInputMode: vi.fn(),
}))

const detachedBrowserMock = vi.hoisted(() => ({
  detach: vi.fn(() => Promise.resolve()),
  focus: vi.fn(() => Promise.resolve(true)),
  restore: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

vi.mock('../../../lib/browser-view-bridge', async () => {
  const { useEffect } = await import('react')
  // Faithful stand-in for the shared hook: an immediate report while active,
  // null on cleanup (rAF/ResizeObserver re-reports are not under test here).
  function useMockRectReport(
    ref: { current: HTMLElement | null },
    sessionId: string | null,
    active: boolean,
  ): void {
    useEffect(() => {
      if (!active || !sessionId) return
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      bridgeMock.reportBrowserViewRect(
        sessionId,
        rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null,
      )
      return () => {
        bridgeMock.reportBrowserViewRect(sessionId, null)
      }
    }, [ref, sessionId, active])
  }
  return {
    isNativeBrowserView: bridgeMock.isNativeBrowserView,
    reportBrowserViewRect: bridgeMock.reportBrowserViewRect,
    setBrowserViewInputMode: bridgeMock.setBrowserViewInputMode,
    useBrowserViewRectReport: useMockRectReport,
    onBrowserViewEscape: vi.fn(() => () => {}),
    // The pane store subscribes at module scope; the occlusion watcher is not
    // under test here.
    onBrowserViewOcclusionChange: vi.fn(() => () => {}),
  }
})

vi.mock('../../../lib/detached-browser-api', () => ({
  detachBrowserWindow: detachedBrowserMock.detach,
  focusDetachedBrowserWindow: detachedBrowserMock.focus,
  restoreDetachedBrowser: detachedBrowserMock.restore,
}))

import BrowserPane from '../BrowserPane'
import {
  useBrowserPaneStore,
  initialSessionBrowserState,
  type SessionBrowserState,
} from '../../../stores/browser-pane-store'
import { useChatStore } from '../../../stores/chat-store'

beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

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
    bridgeMock.isNativeBrowserView.mockReturnValue(true)
    useBrowserPaneStore.setState({
      openBySession: {},
      width: 480,
      hasOpened: false,
      detachedPlacement: null,
      activeWorkspaceId: 'ws1',
      activeSessionId: 'sess-1',
      sessions: {},
    })
    setChatState()
    useChatStore.setState({
      sessions: {
        ws1: [{ id: 'sess-1', workspaceId: 'ws1', name: 'Research chat', createdAt: '', updatedAt: '' }],
      },
    })
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response),
    )
  })

  it('renders the state bar and a dormant placeholder before the first open', () => {
    renderPane()
    expect(screen.getByTestId('browser-state-bar')).toBeInTheDocument()
    expect(screen.getByTestId('browser-pane-dormant')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-viewer-native')).not.toBeInTheDocument()
  })

  it('mounts the native view host once the pane has opened and the control state is live', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderPane()

    expect(screen.getByTestId('browser-viewer-native')).toBeInTheDocument()
    // jsdom rects are zero-area → the shell is told to hide the view; the
    // input gate still follows the control state.
    expect(bridgeMock.reportBrowserViewRect).toHaveBeenCalledWith('sess-1', null)
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenCalledWith('sess-1', 'agent')
  })

  it('collapses every body state to the needs-desktop degradation outside the Electron shell (KTD-15)', () => {
    bridgeMock.isNativeBrowserView.mockReturnValue(false)
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderPane()

    const degraded = screen.getByTestId('browser-needs-desktop')
    expect(degraded).toHaveTextContent('The browser view needs the desktop app')
    expect(screen.queryByTestId('browser-viewer-native')).not.toBeInTheDocument()
    // No shell → no independent-window entry either.
    expect(screen.queryByTestId('browser-detach-button')).not.toBeInTheDocument()
  })

  it('does not render anything when the workspace has no active session', () => {
    setChatState(null)
    renderPane()
    expect(screen.queryByTestId('browser-state-bar')).not.toBeInTheDocument()
  })

  it('switches the view when the active chat session changes', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001 })
    setSession({ controlState: 'user_in_control', port: 4002 }, 'sess-2')
    renderPane()
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenLastCalledWith('sess-1', 'agent')

    setChatState('sess-2')
    expect(screen.getByTestId('browser-viewer-native')).toBeInTheDocument()
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenLastCalledWith('sess-2', 'user')
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
    expect(screen.getByTestId('browser-start-phase')).toHaveTextContent('Preparing the browser')
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

  it('opens an independent window and mirrors its authoritative placement as a full placeholder', async () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderPane()
    expect(screen.getByTestId('browser-viewer-native')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('browser-detach-button'))
    expect(detachedBrowserMock.detach).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      sessionId: 'sess-1',
      title: 'Research chat',
    })

    setPane({
      detachedPlacement: { workspaceId: 'ws1', sessionId: 'sess-1', title: 'Research chat' },
    })
    const placeholder = screen.getByTestId('browser-detached-placeholder')
    expect(placeholder).toHaveTextContent('Research chat')
    expect(placeholder).toHaveTextContent('another window')
    expect(screen.queryByTestId('browser-viewer-native')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('browser-detached-focus'))
    fireEvent.click(screen.getByTestId('browser-detached-restore'))
    expect(detachedBrowserMock.focus).toHaveBeenCalledOnce()
    expect(detachedBrowserMock.restore).toHaveBeenCalledOnce()
  })

  it('does not treat another chat as detached', () => {
    setPane({
      hasOpened: true,
      detachedPlacement: { workspaceId: 'ws1', sessionId: 'sess-2', title: 'Other chat' },
    })
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderPane()
    expect(screen.getByTestId('browser-viewer-native')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-detached-placeholder')).not.toBeInTheDocument()
  })

  it('sends content-free activity pings on pane interaction while the user drives', () => {
    setPane({ hasOpened: true })
    setSession({ controlState: 'user_in_control', port: 4001 })
    renderPane()
    fireEvent.pointerDown(screen.getByTestId('browser-pane'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserActivityPing', { sessionId: 'sess-1' })
  })
})
