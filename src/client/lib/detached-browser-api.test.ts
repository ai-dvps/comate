import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComateBridge, DetachedBrowserPlacement } from './desktop-api'
import {
  detachBrowserWindow,
  focusDetachedBrowserWindow,
  getDetachedBrowserPlacement,
  markDetachedBrowserRendererReady,
  notifyDetachedBrowserSessionEnded,
  onDetachedBrowserPlacementChange,
  restoreDetachedBrowser,
} from './detached-browser-api'

type MutableWindow = Window & { comate?: Partial<ComateBridge> }

const A: DetachedBrowserPlacement = {
  workspaceId: 'ws-a',
  sessionId: 'session-a',
  title: 'Research chat',
}

const detachedBrowser = {
  detach: vi.fn(() => Promise.resolve()),
  focus: vi.fn(() => Promise.resolve(true)),
  restore: vi.fn(() => Promise.resolve(true)),
  getPlacement: vi.fn(() => Promise.resolve(A)),
  rendererReady: vi.fn(() => Promise.resolve(true)),
  sessionEnded: vi.fn(() => Promise.resolve(true)),
  onPlacementChange: vi.fn<(handler: (placement: DetachedBrowserPlacement | null) => void) => () => void>(),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as MutableWindow).comate = { detachedBrowser }
})

describe('detached browser desktop API', () => {
  it('forwards placement commands through the whitelisted bridge', async () => {
    await detachBrowserWindow(A)
    await focusDetachedBrowserWindow()
    await restoreDetachedBrowser()
    await markDetachedBrowserRendererReady('session-a')
    await notifyDetachedBrowserSessionEnded('session-a')
    expect(detachedBrowser.detach).toHaveBeenCalledWith(A)
    expect(detachedBrowser.focus).toHaveBeenCalledOnce()
    expect(detachedBrowser.restore).toHaveBeenCalledOnce()
    expect(detachedBrowser.rendererReady).toHaveBeenCalledWith('session-a')
    expect(detachedBrowser.sessionEnded).toHaveBeenCalledWith('session-a')
    await expect(getDetachedBrowserPlacement()).resolves.toEqual(A)
  })

  it('fans placement changes out and returns the preload unsubscribe', () => {
    const unsubscribe = vi.fn()
    let listener: ((placement: DetachedBrowserPlacement | null) => void) | undefined
    detachedBrowser.onPlacementChange.mockImplementation((handler) => {
      listener = handler
      return unsubscribe
    })
    const seen: Array<DetachedBrowserPlacement | null> = []
    const stop = onDetachedBrowserPlacementChange((placement) => seen.push(placement))
    listener?.(A)
    listener?.(null)
    expect(seen).toEqual([A, null])
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('degrades safely when the detached bridge is unavailable', async () => {
    delete (window as MutableWindow).comate
    await expect(getDetachedBrowserPlacement()).resolves.toBeNull()
    await expect(focusDetachedBrowserWindow()).resolves.toBe(false)
    await expect(restoreDetachedBrowser()).resolves.toBe(false)
    expect(() => onDetachedBrowserPlacementChange(() => {})).not.toThrow()
  })
})
