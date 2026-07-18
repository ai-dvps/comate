import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSidebarWidth, RAIL_WIDTH } from './use-sidebar-width'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})

describe('useSidebarWidth', () => {
  it('initializes with isCollapsed false and the stored width when no collapsed flag exists', () => {
    storage.set('sidebar-width', '350')
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.isCollapsed).toBe(false)
    expect(result.current.width).toBe(350)
  })

  it('initializes collapsed when the stored flag is true', () => {
    storage.set('sidebar-collapsed', 'true')
    storage.set('sidebar-width', '350')
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.isCollapsed).toBe(true)
    expect(result.current.width).toBe(RAIL_WIDTH)
  })

  it('toggles isCollapsed and persists the flag', () => {
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.isCollapsed).toBe(false)

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.isCollapsed).toBe(true)
    expect(storage.get('sidebar-collapsed')).toBe('true')

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.isCollapsed).toBe(false)
    expect(storage.get('sidebar-collapsed')).toBe('false')
  })

  it('expanding after collapse restores the width that existed before collapse', () => {
    storage.set('sidebar-width', '400')
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.width).toBe(400)

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(RAIL_WIDTH)
    expect(storage.get('sidebar-previous-width')).toBe('400')

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(400)
  })

  it('clamps a restored previous width within [200, 600]', () => {
    storage.set('sidebar-width', '400')
    storage.set('sidebar-previous-width', '900')
    storage.set('sidebar-collapsed', 'true')
    const { result } = renderHook(() => useSidebarWidth())

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(600)
  })

  it('falls back to sensible defaults when localStorage entries are missing or corrupted', () => {
    storage.set('sidebar-width', 'not-a-number')
    storage.set('sidebar-collapsed', 'maybe')
    storage.set('sidebar-previous-width', 'also-not')
    const { result } = renderHook(() => useSidebarWidth())
    expect(result.current.isCollapsed).toBe(false)
    expect(result.current.width).toBe(288)
  })

  it('clamps a restored previous width to the minimum bound', () => {
    storage.set('sidebar-width', '400')
    storage.set('sidebar-previous-width', '50')
    storage.set('sidebar-collapsed', 'true')
    const { result } = renderHook(() => useSidebarWidth())

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(200)
  })

  it('keeps previous width in sync when setWidth is called while collapsed', () => {
    storage.set('sidebar-width', '400')
    const { result } = renderHook(() => useSidebarWidth())

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(RAIL_WIDTH)

    act(() => {
      result.current.setWidth(500)
    })

    expect(result.current.width).toBe(RAIL_WIDTH)
    expect(storage.get('sidebar-previous-width')).toBe('500')

    act(() => {
      result.current.toggleCollapse()
    })

    expect(result.current.width).toBe(500)
  })
})
