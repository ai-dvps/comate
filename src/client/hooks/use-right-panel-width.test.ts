import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRightPanelWidth, RAIL_WIDTH } from './use-right-panel-width'

const storage = new Map<string, string>()

describe('useRightPanelWidth', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1600,
    })
  })

  it('initializes collapsed by default and uses the stored width as expanded width', () => {
    storage.set('right-panel-width', '500')
    const { result } = renderHook(() => useRightPanelWidth())
    expect(result.current.isCollapsed).toBe(true)
    expect(result.current.width).toBe(RAIL_WIDTH)
    expect(result.current.expandedWidth).toBe(500)
  })

  it('initializes collapsed when the stored flag is true', () => {
    storage.set('right-panel-collapsed', 'true')
    storage.set('right-panel-width', '500')
    const { result } = renderHook(() => useRightPanelWidth())
    expect(result.current.isCollapsed).toBe(true)
    expect(result.current.width).toBe(RAIL_WIDTH)
  })

  it('toggles isCollapsed and persists the flag', () => {
    const { result } = renderHook(() => useRightPanelWidth())
    expect(result.current.isCollapsed).toBe(true)

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.isCollapsed).toBe(false)
    expect(storage.get('right-panel-collapsed')).toBe('false')

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.isCollapsed).toBe(true)
    expect(storage.get('right-panel-collapsed')).toBe('true')
  })

  it('expanding after collapse restores the width that existed before collapse', () => {
    storage.set('right-panel-width', '500')
    const { result } = renderHook(() => useRightPanelWidth())
    expect(result.current.width).toBe(RAIL_WIDTH)

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(500)

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(RAIL_WIDTH)
    expect(storage.get('right-panel-previous-width')).toBe('500')
  })

  it('clamps a restored previous width within [360, 90% of window width]', () => {
    storage.set('right-panel-width', '500')
    storage.set('right-panel-previous-width', '900')
    storage.set('right-panel-collapsed', 'true')
    const { result } = renderHook(() => useRightPanelWidth())

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(900)
  })

  it('falls back to sensible defaults when localStorage entries are missing or corrupted', () => {
    storage.set('right-panel-width', 'not-a-number')
    storage.set('right-panel-collapsed', 'maybe')
    storage.set('right-panel-previous-width', 'also-not')
    const { result } = renderHook(() => useRightPanelWidth())
    expect(result.current.isCollapsed).toBe(true)
    expect(result.current.width).toBe(RAIL_WIDTH)
  })

  it('clamps a restored previous width to the minimum bound', () => {
    storage.set('right-panel-width', '500')
    storage.set('right-panel-previous-width', '200')
    storage.set('right-panel-collapsed', 'true')
    const { result } = renderHook(() => useRightPanelWidth())

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(360)
  })

  it('keeps previous width in sync when setWidth is called while collapsed', () => {
    storage.set('right-panel-width', '500')
    storage.set('right-panel-collapsed', 'false')
    const { result } = renderHook(() => useRightPanelWidth())

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(RAIL_WIDTH)

    act(() => {
      result.current.setWidth(700)
    })

    expect(result.current.width).toBe(RAIL_WIDTH)
    expect(storage.get('right-panel-previous-width')).toBe('700')

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(700)
  })

  it('clamps setWidth to the configured bounds', () => {
    storage.set('right-panel-collapsed', 'false')
    const { result } = renderHook(() => useRightPanelWidth())

    act(() => {
      result.current.setWidth(100)
    })
    expect(result.current.width).toBe(360)

    act(() => {
      result.current.setWidth(900)
    })
    expect(result.current.width).toBe(900)

    act(() => {
      result.current.setWidth(1500)
    })
    expect(result.current.width).toBe(1440)
  })
})
