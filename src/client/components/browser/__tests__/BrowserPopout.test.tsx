import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'

const wsClientMock = vi.hoisted(() => ({
  request: vi.fn(() => Promise.resolve({})),
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
  onDisconnect: vi.fn(() => () => {}),
}))

const bridgeMock = vi.hoisted(() => ({
  isNativeBrowserView: vi.fn(() => true),
  reportBrowserViewRect: vi.fn(),
  setBrowserViewInputMode: vi.fn(),
}))

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

vi.mock('../../../lib/browser-view-bridge', () => ({
  isNativeBrowserView: bridgeMock.isNativeBrowserView,
  reportBrowserViewRect: bridgeMock.reportBrowserViewRect,
  setBrowserViewInputMode: bridgeMock.setBrowserViewInputMode,
  onBrowserViewEscape: vi.fn(() => () => {}),
  // The pane store subscribes at module scope; the occlusion watcher is not
  // under test here.
  onBrowserViewOcclusionChange: vi.fn(() => () => {}),
}))

import BrowserPopout from '../BrowserPopout'
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

const NATIVE_HOST = '[data-testid="browser-viewer-native"]'

function renderBoth() {
  return render(
    <I18nextProvider i18n={i18n}>
      <BrowserPane workspaceId="ws1" />
      <BrowserPopout />
    </I18nextProvider>,
  )
}

function setSession(patch: Partial<SessionBrowserState>) {
  act(() => {
    useBrowserPaneStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        'sess-1': { ...initialSessionBrowserState(), hydrated: true, ...patch },
      },
    }))
  })
}

function setPane(patch: Parameters<typeof useBrowserPaneStore.setState>[0]) {
  act(() => {
    useBrowserPaneStore.setState(patch)
  })
}

describe('BrowserPopout', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
    bridgeMock.isNativeBrowserView.mockReturnValue(true)
    useBrowserPaneStore.setState({
      openBySession: { 'sess-1': true },
      width: 480,
      hasOpened: true,
      popoutOpen: false,
      activeWorkspaceId: 'ws1',
      activeSessionId: 'sess-1',
      sessions: {},
    })
    act(() => {
      useChatStore.setState({ activeSessionIds: { ws1: 'sess-1' } })
    })
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response),
    )
  })

  it('renders nothing while closed', () => {
    renderBoth()
    expect(screen.queryByTestId('browser-popout')).not.toBeInTheDocument()
  })

  it('hosts the native view while open; the pane shows its placeholder (one surface at a time)', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    const { container } = renderBoth()

    setPane({ popoutOpen: true })
    const popout = screen.getByTestId('browser-popout')
    expect(popout.querySelector(NATIVE_HOST)).toBeInTheDocument()
    expect(screen.getByTestId('browser-popout-placeholder')).toBeInTheDocument()
    // The画面 lives in exactly one surface at a time.
    expect(container.querySelectorAll(NATIVE_HOST)).toHaveLength(1)
  })

  it('mirrors the pane state machine: a verb from the popout drives the same store', async () => {
    setSession({ controlState: 'handoff_pending', port: 4001 })
    renderBoth()
    setPane({ popoutOpen: true })

    const popout = screen.getByTestId('browser-popout')
    fireEvent.click(
      Array.from(popout.querySelectorAll('button')).find(
        (b) => b.dataset.testid === 'browser-takeover-button',
      ) as HTMLElement,
    )
    expect(wsClientMock.request).toHaveBeenCalledWith('browserTakeover', { sessionId: 'sess-1' })

    // Both entries show the busy window — one state machine.
    const busyButtons = await screen.findAllByTestId('browser-busy-button')
    expect(busyButtons.length).toBe(2)
    busyButtons.forEach((b) => expect(b).toBeDisabled())
  })

  it('Esc closes the popout and returns the view to the pane', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    const { container } = renderBoth()
    setPane({ popoutOpen: true })
    expect(screen.getByTestId('browser-popout')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('browser-popout'), { key: 'Escape' })
    expect(screen.queryByTestId('browser-popout')).not.toBeInTheDocument()
    // 关闭即回面板：the pane hosts the view again.
    expect(screen.getByTestId('browser-pane').querySelector(NATIVE_HOST)).toBeInTheDocument()
    expect(container.querySelectorAll(NATIVE_HOST)).toHaveLength(1)
  })

  it('close button closes and restores focus to the previously focused element', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderBoth()

    const opener = screen.getByTestId('browser-popout-button')
    opener.focus()
    expect(document.activeElement).toBe(opener)

    setPane({ popoutOpen: true })
    // Focus moved into the dialog.
    expect(screen.getByTestId('browser-popout').contains(document.activeElement)).toBe(true)

    fireEvent.click(screen.getByTestId('browser-popout-close'))
    expect(screen.queryByTestId('browser-popout')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('follows the active session switch', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    act(() => {
      useBrowserPaneStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'sess-2': {
            ...initialSessionBrowserState(),
            hydrated: true,
            controlState: 'user_in_control',
            port: 4002,
          },
        },
      }))
    })
    renderBoth()
    setPane({ popoutOpen: true })
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenLastCalledWith('sess-1', 'agent')

    act(() => {
      useBrowserPaneStore.setState({ activeSessionId: 'sess-2' })
      useChatStore.setState({ activeSessionIds: { ws1: 'sess-2' } })
    })
    // The popout now hosts sess-2's view with user-mode input gating.
    expect(screen.getByTestId('browser-popout').querySelector(NATIVE_HOST)).toBeInTheDocument()
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenLastCalledWith('sess-2', 'user')
    expect(screen.getByTestId('browser-popout')).toHaveTextContent('You are driving')
  })

  it('Tab wraps focus within the popout (focus trap)', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderBoth()
    setPane({ popoutOpen: true })

    const popout = screen.getByTestId('browser-popout')
    const closeButton = screen.getByTestId('browser-popout-close')
    // The close button is the first focusable; Tab from it wraps forward
    // through the trap instead of escaping the dialog.
    closeButton.focus()
    fireEvent.keyDown(popout, { key: 'Tab', shiftKey: true })
    expect(popout.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
  })
})
