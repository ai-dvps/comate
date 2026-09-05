import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useContextTabStore } from '../stores/context-tab-store'
import { useFileAutoReload } from './use-file-auto-reload'

vi.mock('../lib/websocket-client.js', () => ({
  wsClient: { onEvent: vi.fn(), onReconnect: vi.fn(), onDisconnect: vi.fn() },
}))

describe('useFileAutoReload', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: 'before', version: 'v1' }))))
    useContextTabStore.getState().reset()
    useContextTabStore.getState().setContext('ws-1', null)
    await useContextTabStore.getState().openFile('ws-1', 'a.txt', 'a.txt')
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))
  })

  afterEach(() => {
    useContextTabStore.getState().reset()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('checks on mount, automatically loads changes, and stops on unmount', async () => {
    const { unmount } = renderHook(() => useFileAutoReload('ws-1', 'file:a.txt', 'a.txt'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ content: 'after', version: 'v2' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(useContextTabStore.getState().openTabs[0]).toMatchObject({ content: 'after', reloaded: true })
    unmount()
    const count = vi.mocked(fetch).mock.calls.length
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetch).toHaveBeenCalledTimes(count)
  })

  it('retains old content on errors and clears the error after recovery', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useFileAutoReload('ws-1', 'file:a.txt', 'a.txt'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current).toBe(true)
    expect(useContextTabStore.getState().openTabs[0]).toMatchObject({ content: 'before' })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current).toBe(false)
  })

  it('pauses while hidden and checks as soon as the document becomes visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderHook(() => useFileAutoReload('ws-1', 'file:a.txt', 'a.txt'))
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(fetch).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
