import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetachedBrowserPlacement } from '../../../lib/desktop-api'

const desktopApi = vi.hoisted(() => ({
  getPlacement: vi.fn<() => Promise<DetachedBrowserPlacement | null>>(),
  markReady: vi.fn<() => Promise<boolean>>(),
  notifyEnded: vi.fn<() => Promise<boolean>>(),
  onPlacementChange: vi.fn(),
  restore: vi.fn(() => Promise.resolve(true)),
}))

const paneStore = vi.hoisted(() => {
  let state = { hydrated: false, controlState: 'none' }
  const listeners = new Set<() => void>()
  const setActiveSession = vi.fn()
  const hook = (selector: (value: { sessions: Record<string, typeof state> }) => unknown) =>
    selector({ sessions: { 'session-a': state, 'session-b': state } })
  hook.getState = () => ({ setActiveSession })
  hook.setSession = (next: typeof state) => {
    state = next
    listeners.forEach((listener) => listener())
  }
  hook.subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return { hook, setActiveSession }
})

vi.mock('../../../lib/detached-browser-api', () => ({
  getDetachedBrowserPlacement: desktopApi.getPlacement,
  markDetachedBrowserRendererReady: desktopApi.markReady,
  notifyDetachedBrowserSessionEnded: desktopApi.notifyEnded,
  onDetachedBrowserPlacementChange: desktopApi.onPlacementChange,
  restoreDetachedBrowser: desktopApi.restore,
  detachedBrowserPlacementsEqual: (
    left: DetachedBrowserPlacement | null,
    right: DetachedBrowserPlacement | null,
  ) => left?.workspaceId === right?.workspaceId
    && left?.sessionId === right?.sessionId
    && left?.title === right?.title,
  watchDetachedBrowserPlacement: (handler: (placement: DetachedBrowserPlacement | null) => void) => {
    let received = false
    let disposed = false
    const unsubscribe = desktopApi.onPlacementChange((placement: DetachedBrowserPlacement | null) => {
      received = true
      if (!disposed) handler(placement)
    })
    void desktopApi.getPlacement().then((placement) => {
      if (!disposed && !received) handler(placement)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  },
}))

vi.mock('../../../stores/browser-pane-store', () => ({
  useBrowserPaneStore: paneStore.hook,
  EMPTY_SESSION_BROWSER_STATE: { hydrated: false, controlState: 'none' },
}))

vi.mock('../BrowserStateBar', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="state-bar">{sessionId}</div>,
}))

vi.mock('../BrowserBody', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="browser-body">{sessionId}</div>,
}))

import DetachedBrowserWindowApp from '../DetachedBrowserWindowApp'

const A: DetachedBrowserPlacement = {
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
  title: 'Research chat',
}

describe('DetachedBrowserWindowApp', () => {
  let placementListener: ((placement: DetachedBrowserPlacement | null) => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    paneStore.hook.setSession({ hydrated: false, controlState: 'none' })
    desktopApi.getPlacement.mockResolvedValue(A)
    desktopApi.markReady.mockResolvedValue(true)
    desktopApi.notifyEnded.mockResolvedValue(true)
    desktopApi.onPlacementChange.mockImplementation((listener) => {
      placementListener = listener
      return vi.fn()
    })
  })

  afterEach(cleanup)

  it('pins the assigned session and mounts the native host only after ownership moves', async () => {
    let releaseReady: ((ready: boolean) => void) | undefined
    desktopApi.markReady.mockReturnValue(new Promise((resolve) => { releaseReady = resolve }))

    render(<DetachedBrowserWindowApp />)

    expect(await screen.findByTestId('state-bar')).toHaveTextContent('session-a')
    expect(screen.queryByTestId('browser-body')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(paneStore.setActiveSession).toHaveBeenCalledWith('workspace-a', 'session-a')
      expect(desktopApi.markReady).toHaveBeenCalledWith('session-a')
    })

    await act(async () => releaseReady?.(true))
    expect(await screen.findByTestId('browser-body')).toHaveTextContent('session-a')
    expect(document.title).toBe('Research chat')
  })

  it('retargets from placement events without following the main chat selection', async () => {
    render(<DetachedBrowserWindowApp />)
    expect(await screen.findByTestId('browser-body')).toHaveTextContent('session-a')

    await act(async () => {
      placementListener?.({ workspaceId: 'workspace-b', sessionId: 'session-b', title: 'Other chat' })
    })

    expect(await screen.findByTestId('browser-body')).toHaveTextContent('session-b')
    expect(paneStore.setActiveSession).toHaveBeenLastCalledWith('workspace-b', 'session-b')
  })

  it('ends the detached placement when the pinned browser session closes', async () => {
    const view = render(<DetachedBrowserWindowApp />)
    await screen.findByTestId('browser-body')

    act(() => paneStore.hook.setSession({ hydrated: true, controlState: 'none' }))
    view.rerender(<DetachedBrowserWindowApp />)

    await waitFor(() => expect(desktopApi.notifyEnded).toHaveBeenCalledWith('session-a'))
  })
})
