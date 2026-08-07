import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../i18n'

const wsClientMock = vi.hoisted(() => ({
  request: vi.fn(() => Promise.resolve({})),
  onEvent: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
  onDisconnect: vi.fn(() => () => {}),
}))

const bridgeMock = vi.hoisted(() => ({
  reportBrowserViewRect: vi.fn(),
  setBrowserViewInputMode: vi.fn(),
  escapeHandler: null as ((sessionId: string) => void) | null,
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
    reportBrowserViewRect: bridgeMock.reportBrowserViewRect,
    setBrowserViewInputMode: bridgeMock.setBrowserViewInputMode,
    useBrowserViewRectReport: useMockRectReport,
    onBrowserViewEscape: vi.fn((handler: (sessionId: string) => void) => {
      bridgeMock.escapeHandler = handler
      return () => {
        bridgeMock.escapeHandler = null
      }
    }),
    // The pane store subscribes at module scope; the occlusion watcher is not
    // under test here.
    onBrowserViewOcclusionChange: vi.fn(() => () => {}),
  }
})

import { NativeBrowserView } from '../BrowserViewer'
import { useBrowserPaneStore } from '../../../stores/browser-pane-store'

beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function renderNative(
  controlState: 'agent_in_control' | 'user_in_control' = 'agent_in_control',
  surfaceVisible = true,
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <NativeBrowserView sessionId="sess-1" controlState={controlState} surfaceVisible={surfaceVisible} />
    </I18nextProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  bridgeMock.escapeHandler = null
  useBrowserPaneStore.setState({ sessions: {} })
})

describe('NativeBrowserView (U8, KTD-14)', () => {
  it('renders only the backdrop and reports an initial rect (null in jsdom)', () => {
    renderNative()
    expect(screen.getByTestId('browser-viewer-native')).toBeTruthy()
    // jsdom rects are zero-area → hidden report; real shells get the panel box.
    expect(bridgeMock.reportBrowserViewRect).toHaveBeenCalledWith('sess-1', null)
  })

  it('maps the control state onto shell input gating', () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <NativeBrowserView sessionId="sess-1" controlState="agent_in_control" surfaceVisible />
      </I18nextProvider>,
    )
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenLastCalledWith('sess-1', 'agent')
    rerender(
      <I18nextProvider i18n={i18n}>
        <NativeBrowserView sessionId="sess-1" controlState="user_in_control" surfaceVisible />
      </I18nextProvider>,
    )
    expect(bridgeMock.setBrowserViewInputMode).toHaveBeenLastCalledWith('sess-1', 'user')
  })

  it('hides the view while the surface is off screen and on unmount', () => {
    const { rerender, unmount } = renderNative('agent_in_control', false)
    // Off-screen surface reports nothing at all (no rect ⇒ hidden shell-side).
    expect(bridgeMock.reportBrowserViewRect).not.toHaveBeenCalled()

    rerender(
      <I18nextProvider i18n={i18n}>
        <NativeBrowserView sessionId="sess-1" controlState="agent_in_control" surfaceVisible />
      </I18nextProvider>,
    )
    // jsdom rects are zero-area → hidden report once visible-but-empty.
    expect(bridgeMock.reportBrowserViewRect).toHaveBeenCalledWith('sess-1', null)

    bridgeMock.reportBrowserViewRect.mockClear()
    unmount()
    expect(bridgeMock.reportBrowserViewRect).toHaveBeenCalledWith('sess-1', null)
  })

  it('shell Esc notification returns focus to the panel frame and announces it', () => {
    renderNative('user_in_control')
    expect(bridgeMock.escapeHandler).not.toBeNull()
    const root = screen.getByTestId('browser-viewer-native')
    act(() => {
      bridgeMock.escapeHandler!('sess-1')
    })
    expect(document.activeElement).toBe(root)
    expect(root.querySelector('[aria-live="polite"]')?.textContent).toBe(
      i18n.t('browser:action.captureReleased'),
    )
    // Other sessions' escapes are ignored.
    act(() => {
      bridgeMock.escapeHandler!('other')
    })
    expect(document.activeElement).toBe(root)
  })
})
