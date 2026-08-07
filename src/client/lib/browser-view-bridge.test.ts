import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor } from '@testing-library/react'

import type { ComateBridge } from './desktop-api'
import {
  isNativeBrowserView,
  reportBrowserViewRect,
  resetBrowserViewRectCache,
  setBrowserViewInputMode,
  setBrowserViewOccluded,
  setBrowserViewOcclusionExemption,
  onBrowserViewEscape,
  onBrowserViewOcclusionChange,
} from './browser-view-bridge'

type MutableWindow = Window & { comate?: Partial<ComateBridge> }

const browserView = {
  reportRect: vi.fn<(sessionId: string, rect: unknown) => Promise<void>>(),
  setInputMode: vi.fn<(sessionId: string, mode: string) => Promise<void>>(),
  setOccluded: vi.fn<(occluded: boolean) => Promise<void>>(),
  setOcclusionExemption: vi.fn<(sessionId: string | null) => Promise<void>>(),
  onEscape: vi.fn<(handler: (sessionId: string) => void) => () => void>(),
}

function installBridge(): void {
  (window as MutableWindow).comate = { browserView }
}

function removeBridge(): void {
  delete (window as MutableWindow).comate
}

beforeEach(() => {
  vi.clearAllMocks()
  removeBridge()
  resetBrowserViewRectCache()
})

describe('browser-view-bridge — capability detection', () => {
  it('is false without the bridge and true once browserView.reportRect exists', () => {
    expect(isNativeBrowserView()).toBe(false)
    installBridge()
    expect(isNativeBrowserView()).toBe(true)
  })

  it('every call degrades to a no-op outside the shell', () => {
    expect(() => {
      reportBrowserViewRect('s1', { x: 0, y: 0, width: 100, height: 100 })
      setBrowserViewInputMode('s1', 'user')
      setBrowserViewOccluded(true)
    }).not.toThrow()
    expect(browserView.reportRect).not.toHaveBeenCalled()
  })
})

describe('browser-view-bridge — rect reporting', () => {
  it('rounds and forwards rects; null/zero-area reports hide the view', () => {
    installBridge()
    reportBrowserViewRect('s1', { x: 10.4, y: 20.6, width: 480.2, height: 600.8 })
    expect(browserView.reportRect).toHaveBeenCalledWith('s1', {
      x: 10,
      y: 21,
      width: 480,
      height: 601,
    })
    reportBrowserViewRect('s1', { x: 0, y: 0, width: 0, height: 100 })
    expect(browserView.reportRect).toHaveBeenLastCalledWith('s1', null)
  })

  it('dedups identical consecutive reports per session', () => {
    installBridge()
    const rect = { x: 1, y: 2, width: 300, height: 200 }
    reportBrowserViewRect('s1', rect)
    reportBrowserViewRect('s1', rect)
    reportBrowserViewRect('s2', rect)
    expect(browserView.reportRect).toHaveBeenCalledTimes(2)
  })

  it('swallows IPC rejections (fire-and-forget)', async () => {
    installBridge()
    browserView.reportRect.mockRejectedValueOnce(new Error('gone'))
    expect(() => reportBrowserViewRect('s1', { x: 0, y: 0, width: 1, height: 1 })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe('browser-view-bridge — input gating + escape', () => {
  it('forwards input mode changes', () => {
    installBridge()
    setBrowserViewInputMode('s1', 'user')
    expect(browserView.setInputMode).toHaveBeenCalledWith('s1', 'user')
  })

  it('forwards the modal occlusion exemption (U9)', () => {
    installBridge()
    setBrowserViewOcclusionExemption('s1')
    expect(browserView.setOcclusionExemption).toHaveBeenCalledWith('s1')
    setBrowserViewOcclusionExemption(null)
    expect(browserView.setOcclusionExemption).toHaveBeenLastCalledWith(null)
  })

  it('fans shell escape notifications out to subscribers', () => {
    let captured: ((sessionId: string) => void) | null = null
    browserView.onEscape.mockImplementation((handler) => {
      captured = handler
      return () => {}
    })
    installBridge()
    const seen: string[] = []
    const unsub = onBrowserViewEscape((sessionId) => seen.push(sessionId))
    expect(captured).not.toBeNull()
    captured!('s1')
    expect(seen).toEqual(['s1'])
    unsub()
  })
})

describe('browser-view-bridge — modal occlusion watcher (KTD-14 decision)', () => {
  it('flips the flag when a data-modal-overlay element mounts/unmounts', async () => {
    installBridge()
    const flags: boolean[] = []
    onBrowserViewOcclusionChange((occluded) => flags.push(occluded))

    const overlay = document.createElement('div')
    overlay.setAttribute('data-modal-overlay', '')
    document.body.appendChild(overlay)
    await waitFor(() => expect(flags).toContain(true))
    expect(browserView.setOccluded).toHaveBeenCalledWith(true)

    overlay.remove()
    await waitFor(() => expect(flags.at(-1)).toBe(false))
    expect(browserView.setOccluded).toHaveBeenLastCalledWith(false)
  })

  it('does not flip for dropdown-level or inline elements', async () => {
    installBridge()
    const flags: boolean[] = []
    onBrowserViewOcclusionChange((occluded) => flags.push(occluded))
    const baseline = flags.length

    // Inline approval-card-style dialog (role dialog, NOT a modal overlay).
    const inline = document.createElement('div')
    inline.setAttribute('role', 'dialog')
    inline.setAttribute('aria-modal', 'true')
    document.body.appendChild(inline)
    // A tooltip-ish portal node.
    const tooltip = document.createElement('div')
    tooltip.setAttribute('role', 'tooltip')
    document.body.appendChild(tooltip)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flags.length).toBe(baseline)
    inline.remove()
    tooltip.remove()
  })
})
