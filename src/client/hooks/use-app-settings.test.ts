import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAppSettings, getInitialSettings } from './use-app-settings'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})

describe('getInitialSettings', () => {
  it('defaults notificationSoundsVolume to 100 when nothing is stored', () => {
    const settings = getInitialSettings()
    expect(settings.notificationSoundsVolume).toBe(100)
  })

  it('loads a valid stored notificationSoundsVolume', () => {
    storage.set(
      'app-settings',
      JSON.stringify({ notificationSoundsEnabled: true, notificationSoundsVolume: 50 }),
    )
    const settings = getInitialSettings()
    expect(settings.notificationSoundsVolume).toBe(50)
  })

  it('falls back to 100 for an invalid stored volume', () => {
    storage.set(
      'app-settings',
      JSON.stringify({ notificationSoundsEnabled: true, notificationSoundsVolume: 'loud' }),
    )
    const settings = getInitialSettings()
    expect(settings.notificationSoundsVolume).toBe(100)
  })

  it('falls back to 100 for an out-of-range stored volume', () => {
    storage.set(
      'app-settings',
      JSON.stringify({ notificationSoundsEnabled: true, notificationSoundsVolume: 150 }),
    )
    const settings = getInitialSettings()
    expect(settings.notificationSoundsVolume).toBe(100)
  })
})

describe('useAppSettings', () => {
  it('returns 100 by default', () => {
    const { result } = renderHook(() => useAppSettings())
    expect(result.current.notificationSoundsVolume).toBe(100)
  })

  it('updates notificationSoundsVolume and persists to localStorage', () => {
    const { result } = renderHook(() => useAppSettings())

    act(() => {
      result.current.setNotificationSoundsVolume(42)
    })

    expect(result.current.notificationSoundsVolume).toBe(42)
    const stored = JSON.parse(storage.get('app-settings')!)
    expect(stored.notificationSoundsVolume).toBe(42)
  })

  it('clamps notificationSoundsVolume to 0-100', () => {
    const { result } = renderHook(() => useAppSettings())

    act(() => {
      result.current.setNotificationSoundsVolume(-10)
    })
    expect(result.current.notificationSoundsVolume).toBe(0)

    act(() => {
      result.current.setNotificationSoundsVolume(120)
    })
    expect(result.current.notificationSoundsVolume).toBe(100)
  })
})
