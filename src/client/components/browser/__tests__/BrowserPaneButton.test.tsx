import { describe, it, expect, vi, beforeEach } from 'vitest'
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

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

import BrowserPaneButton from '../BrowserPaneButton'
import {
  useBrowserPaneStore,
  initialSessionBrowserState,
} from '../../../stores/browser-pane-store'
import { useChatStore } from '../../../stores/chat-store'

function renderButton() {
  return render(
    <I18nextProvider i18n={i18n}>
      <BrowserPaneButton workspaceId="ws1" />
    </I18nextProvider>,
  )
}

describe('BrowserPaneButton', () => {
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
    act(() => {
      useChatStore.setState({ activeSessionIds: { ws1: 'sess-1' } })
    })
  })

  it('toggles the pane open state', () => {
    renderButton()
    const button = screen.getByTestId('browser-pane-button')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(useBrowserPaneStore.getState().isOpen).toBe(true)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('browser-pane-open')).toBe('true')
  })

  it('shows the handoff badge while the session awaits takeover (R5)', () => {
    renderButton()
    expect(screen.queryByTestId('browser-pane-badge')).not.toBeInTheDocument()

    act(() => {
      useBrowserPaneStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'sess-1': {
            ...initialSessionBrowserState(),
            hydrated: true,
            controlState: 'handoff_pending',
          },
        },
      }))
    })
    expect(screen.getByTestId('browser-pane-badge')).toBeInTheDocument()

    act(() => {
      useBrowserPaneStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'sess-1': {
            ...initialSessionBrowserState(),
            hydrated: true,
            controlState: 'user_in_control',
          },
        },
      }))
    })
    expect(screen.queryByTestId('browser-pane-badge')).not.toBeInTheDocument()
  })

  it('is keyboard reachable with a visible focus ring', () => {
    renderButton()
    const button = screen.getByTestId('browser-pane-button')
    expect(button.tagName).toBe('BUTTON')
    expect(button.className).toContain('focus-visible:ring-2')
    button.focus()
    expect(document.activeElement).toBe(button)
  })
})
