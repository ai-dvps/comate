import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'

const wsClientMock = vi.hoisted(() => ({
  request: vi.fn(() => Promise.resolve({})),
  onEvent: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
  onDisconnect: vi.fn(() => () => {}),
}))

const bridgeMock = vi.hoisted(() => ({
  isNativeBrowserView: vi.fn(() => true),
}))

vi.mock('../../../lib/websocket-client.js', () => ({
  wsClient: wsClientMock,
  DEFAULT_TIMEOUT: 30000,
}))

vi.mock('../../../lib/browser-view-bridge', () => ({
  isNativeBrowserView: bridgeMock.isNativeBrowserView,
  // The pane store subscribes at module scope; the occlusion watcher is not
  // under test here.
  onBrowserViewOcclusionChange: vi.fn(() => () => {}),
}))

import BrowserStateBar from '../BrowserStateBar'
import {
  useBrowserPaneStore,
  initialSessionBrowserState,
  type SessionBrowserState,
} from '../../../stores/browser-pane-store'

function renderBar(onPopout?: () => void) {
  return render(
    <I18nextProvider i18n={i18n}>
      <BrowserStateBar sessionId="sess-1" {...(onPopout ? { onPopout } : {})} />
    </I18nextProvider>,
  )
}

function setSession(patch: Partial<SessionBrowserState>) {
  useBrowserPaneStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      'sess-1': { ...initialSessionBrowserState(), hydrated: true, ...patch },
    },
  }))
}

describe('BrowserStateBar', () => {
  beforeEach(() => {
    cleanup()
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
  })

  // Five-state rendering, one assertion bundle each (plan test scenario).

  it('agent_in_control: shows "Claude is driving" with an enabled Take over button', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderBar()

    expect(screen.getByTestId('browser-state-label')).toHaveTextContent('Claude is driving')
    const takeover = screen.getByTestId('browser-takeover-button')
    expect(takeover).toBeEnabled()
    expect(screen.queryByTestId('browser-handback-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('browser-busy-button')).not.toBeInTheDocument()
  })

  it('handoff_pending: shows the waiting state with both Take over and Continue', () => {
    setSession({ controlState: 'handoff_pending', port: 4001 })
    renderBar()

    expect(screen.getByTestId('browser-state-label')).toHaveTextContent(
      'Claude is asking you to take over',
    )
    expect(screen.getByTestId('browser-takeover-button')).toBeEnabled()
    expect(screen.getByTestId('browser-handback-button')).toBeEnabled()
  })

  it('user_in_control: shows "You are driving" with Continue', () => {
    setSession({ controlState: 'user_in_control', port: 4001 })
    renderBar()

    expect(screen.getByTestId('browser-state-label')).toHaveTextContent('You are driving')
    expect(screen.getByTestId('browser-handback-button')).toBeEnabled()
    expect(screen.queryByTestId('browser-takeover-button')).not.toBeInTheDocument()
  })

  it('transitioning (pendingVerb): controls collapse into one disabled busy button', () => {
    setSession({ controlState: 'handoff_pending', pendingVerb: 'takeover' })
    renderBar()

    expect(screen.getByTestId('browser-state-label')).toHaveTextContent('Switching control')
    const busy = screen.getByTestId('browser-busy-button')
    expect(busy).toBeDisabled()
    expect(screen.queryByTestId('browser-takeover-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('browser-handback-button')).not.toBeInTheDocument()
  })

  it('session_lost: shows the crash state with a manual Retry', () => {
    setSession({ controlState: 'session_lost' })
    renderBar()

    expect(screen.getByTestId('browser-state-label')).toHaveTextContent('Browser session lost')
    expect(screen.getByTestId('browser-retry-button')).toBeEnabled()
    expect(screen.queryByTestId('browser-takeover-button')).not.toBeInTheDocument()
  })

  // Verb wiring.

  it('clicking Take over sends the takeover verb and opens the busy window', async () => {
    setSession({ controlState: 'handoff_pending', port: 4001 })
    renderBar()
    fireEvent.click(screen.getByTestId('browser-takeover-button'))

    expect(wsClientMock.request).toHaveBeenCalledWith('browserTakeover', { sessionId: 'sess-1' })
    expect(await screen.findByTestId('browser-busy-button')).toBeDisabled()
  })

  it('clicking Continue sends the handback verb', () => {
    setSession({ controlState: 'user_in_control', port: 4001 })
    renderBar()
    fireEvent.click(screen.getByTestId('browser-handback-button'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserHandback', { sessionId: 'sess-1' })
  })

  it('session_lost Retry POSTs the native rebuild route', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response),
    )
    setSession({ controlState: 'session_lost' })
    renderBar()
    fireEvent.click(screen.getByTestId('browser-retry-button'))
    expect(global.fetch).toHaveBeenCalledWith('/api/browser/sess-1/retry', { method: 'POST' })
  })

  // Degraded state.

  it('browser_unavailable renders the degraded banner with a retry action', () => {
    setSession({
      controlState: 'none',
      unavailable: { code: 'browser_chromium_missing', reason: 'No Chromium executable available' },
    })
    renderBar()

    const banner = screen.getByTestId('browser-unavailable-banner')
    expect(banner).toHaveTextContent('Browser unavailable')
    expect(banner).toHaveTextContent('No Chromium executable available')

    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as unknown as Response),
    )
    fireEvent.click(screen.getByTestId('browser-unavailable-retry'))
    expect(global.fetch).toHaveBeenCalledWith('/api/health/browser')
  })

  // aria-live announcements.

  it('announces control-state transitions via aria-live', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    const { rerender } = renderBar()
    expect(screen.getByTestId('browser-state-live')).toHaveTextContent('Claude is driving')

    setSession({ controlState: 'user_in_control', port: 4001 })
    rerender(
      <I18nextProvider i18n={i18n}>
        <BrowserStateBar sessionId="sess-1" />
      </I18nextProvider>,
    )
    expect(screen.getByTestId('browser-state-live')).toHaveTextContent('You are driving')
  })

  it('projects positive-shape task progress without task ids or authored values', () => {
    setSession({
      controlState: 'agent_in_control',
      task: { lifecycle: 'outcome-unknown', required: 4, verified: 3, populatedPendingValidation: 1, awaitingAuthority: 0 },
    })
    renderBar()
    const projection = screen.getByTestId('browser-task-state')
    expect(projection).toHaveTextContent('External outcome is unknown')
    expect(projection).not.toHaveTextContent('task-')
  })

  it('announces exhausted safe recovery without exposing target details', () => {
    setSession({ controlState: 'agent_in_control', task: { lifecycle: 'blocked', required: 1, verified: 0,
      populatedPendingValidation: 0, awaitingAuthority: 0, recoveryExhausted: true } })
    renderBar()
    const projection = screen.getByTestId('browser-task-state')
    expect(projection).toHaveTextContent('Safe recovery is exhausted')
    expect(projection).not.toHaveTextContent('target')
  })

  // Popout entry (U8/U9: native shell + live control state only).

  it('shows the popout button for a live control state in the native shell', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    const onPopout = vi.fn()
    renderBar(onPopout)
    fireEvent.click(screen.getByTestId('browser-popout-button'))
    expect(onPopout).toHaveBeenCalledTimes(1)
  })

  it('hides the popout button when the control state is not live', () => {
    setSession({ controlState: 'none' })
    renderBar(vi.fn())
    expect(screen.queryByTestId('browser-popout-button')).not.toBeInTheDocument()
  })

  it('hides the popout button outside the Electron shell even when live', () => {
    bridgeMock.isNativeBrowserView.mockReturnValue(false)
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderBar(vi.fn())
    expect(screen.queryByTestId('browser-popout-button')).not.toBeInTheDocument()
  })

  // Keyboard reachability.

  it('control buttons are keyboard-reachable native buttons with visible focus classes', () => {
    setSession({ controlState: 'handoff_pending', port: 4001 })
    renderBar()
    const takeover = screen.getByTestId('browser-takeover-button')
    expect(takeover.tagName).toBe('BUTTON')
    expect(takeover.className).toContain('focus-visible:ring-2')
    takeover.focus()
    expect(document.activeElement).toBe(takeover)
  })

  // "记住此站点" checkbox (U8).

  it('user_in_control: renders the remember-site checkbox next to Continue (F3-friendly)', () => {
    setSession({ controlState: 'user_in_control', port: 4001 })
    renderBar()

    const checkbox = screen.getByTestId('browser-remember-site-checkbox')
    expect(checkbox).toBeEnabled()
    expect(checkbox).not.toBeChecked()
    expect(screen.getByTestId('browser-handback-button')).toBeEnabled()
  })

  it('remember-site is hidden in agent_in_control, handoff_pending, and while busy', () => {
    for (const patch of [
      { controlState: 'agent_in_control' },
      { controlState: 'handoff_pending' },
      { controlState: 'user_in_control', pendingVerb: 'handback' },
    ] as const) {
      cleanup()
      setSession(patch)
      renderBar()
      expect(screen.queryByTestId('browser-remember-site-checkbox')).not.toBeInTheDocument()
    }
  })

  it('toggling the checkbox updates the store; handback carries rememberSite in the verb payload', async () => {
    setSession({ controlState: 'user_in_control', port: 4001 })
    renderBar()

    fireEvent.click(screen.getByTestId('browser-remember-site-checkbox'))
    expect(useBrowserPaneStore.getState().sessions['sess-1'].rememberSite).toBe(true)

    fireEvent.click(screen.getByTestId('browser-handback-button'))
    await vi.waitFor(() => {
      expect(wsClientMock.request).toHaveBeenCalledWith('browserHandback', {
        sessionId: 'sess-1',
        rememberSite: true,
      })
    })
  })

  it('handback without the checkbox sends no rememberSite flag', async () => {
    setSession({ controlState: 'user_in_control', port: 4001 })
    renderBar()

    fireEvent.click(screen.getByTestId('browser-handback-button'))
    await vi.waitFor(() => {
      expect(wsClientMock.request).toHaveBeenCalledWith('browserHandback', {
        sessionId: 'sess-1',
      })
    })
  })

  it('a state transition clears the checkbox', () => {
    setSession({ controlState: 'user_in_control', rememberSite: true, port: 4001 })
    renderBar()
    expect(screen.getByTestId('browser-remember-site-checkbox')).toBeChecked()

    useBrowserPaneStore.getState()._applyBrowserState('sess-1', { state: 'agent_in_control' })
    expect(useBrowserPaneStore.getState().sessions['sess-1'].rememberSite).toBe(false)
  })

  // Explicit close (U1/U4) + idle reclaim (U3).

  it('agent_in_control: renders the close button and sends the browserClose verb', () => {
    setSession({ controlState: 'agent_in_control', port: 4001 })
    renderBar()
    fireEvent.click(screen.getByTestId('browser-close-button'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserClose', { sessionId: 'sess-1' })
  })

  it('close button is hidden when there is no live browser', () => {
    for (const patch of [{ controlState: 'none' }, { controlState: 'session_lost' }] as const) {
      cleanup()
      setSession(patch)
      renderBar()
      expect(screen.queryByTestId('browser-close-button')).not.toBeInTheDocument()
    }
  })

  it('idle banner: renders on idlePrompt, Close now sends browserIdleConfirm', () => {
    setSession({ controlState: 'agent_in_control', port: 4001, idlePrompt: true })
    renderBar()
    fireEvent.click(screen.getByTestId('browser-idle-close'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserIdleConfirm', { sessionId: 'sess-1' })
  })

  it('idle banner: Not now sends browserIdleSnooze and clears the prompt locally', () => {
    setSession({ controlState: 'agent_in_control', port: 4001, idlePrompt: true })
    renderBar()
    fireEvent.click(screen.getByTestId('browser-idle-snooze'))
    expect(wsClientMock.request).toHaveBeenCalledWith('browserIdleSnooze', { sessionId: 'sess-1' })
    expect(useBrowserPaneStore.getState().sessions['sess-1'].idlePrompt).toBe(false)
  })
})
