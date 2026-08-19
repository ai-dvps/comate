import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChangedFilesExistence } from './use-changed-files-existence'

const WORKSPACE_FOLDER = '/ws'

function resolveResponse(paths: string[]): Response {
  return {
    ok: true,
    json: async () => ({ paths }),
  } as Response
}

describe('useChangedFilesExistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports touched paths absent from the resolve response as missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveResponse(['src/a.ts']))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      useChangedFilesExistence({
        workspaceId: 'ws-existence-basic',
        folderPath: WORKSPACE_FOLDER,
        paths: ['/ws/src/a.ts', '/ws/src/b.ts'],
        enabled: true,
      }),
    )

    expect(result.current.size).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-existence-basic/files/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ paths: ['src/a.ts', 'src/b.ts'] }),
      }),
    )
    expect(result.current.has('/ws/src/a.ts')).toBe(false)
    expect(result.current.has('/ws/src/b.ts')).toBe(true)
  })

  it('serves a re-check within the TTL from cache without a new request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = renderHook(
      ({ enabled }) =>
        useChangedFilesExistence({
          workspaceId: 'ws-existence-ttl',
          folderPath: WORKSPACE_FOLDER,
          paths: ['/ws/gone.ts'],
          enabled,
        }),
      { initialProps: { enabled: true } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Collapse, then re-expand within the cache TTL.
    rerender({ enabled: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    rerender({ enabled: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('drops a path from the missing set when a later response finds it again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resolveResponse([]))
      .mockResolvedValueOnce(resolveResponse(['revived.ts']))
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useChangedFilesExistence({
          workspaceId: 'ws-existence-revive',
          folderPath: WORKSPACE_FOLDER,
          paths: ['/ws/revived.ts'],
          enabled,
        }),
      { initialProps: { enabled: true } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(result.current.has('/ws/revived.ts')).toBe(true)

    // Collapse, let the cache TTL expire, then re-expand: the file is back.
    rerender({ enabled: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    rerender({ enabled: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.size).toBe(0)
  })

  it('keeps the previous missing set when a re-check fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resolveResponse([]))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useChangedFilesExistence({
          workspaceId: 'ws-existence-failure',
          folderPath: WORKSPACE_FOLDER,
          paths: ['/ws/gone.ts'],
          enabled,
        }),
      { initialProps: { enabled: true } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(result.current.has('/ws/gone.ts')).toBe(true)

    // Expire the TTL and re-check; the failure must leave the set untouched.
    rerender({ enabled: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    rerender({ enabled: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.has('/ws/gone.ts')).toBe(true)
  })

  it('excludes paths outside the workspace from the resolve request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      useChangedFilesExistence({
        workspaceId: 'ws-existence-outside',
        folderPath: WORKSPACE_FOLDER,
        paths: ['/ws/inside.ts', '/elsewhere/outside.ts'],
        enabled: true,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-existence-outside/files/resolve',
      expect.objectContaining({
        body: JSON.stringify({ paths: ['inside.ts'] }),
      }),
    )
    expect(result.current.has('/elsewhere/outside.ts')).toBe(false)
    expect(result.current.has('/ws/inside.ts')).toBe(true)
  })

  it('does not request anything while disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      useChangedFilesExistence({
        workspaceId: 'ws-existence-disabled',
        folderPath: WORKSPACE_FOLDER,
        paths: ['/ws/a.ts'],
        enabled: false,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.size).toBe(0)
  })

  it('re-checks when the touched-paths list changes while enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveResponse(['first.ts']))
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(
      ({ paths }) =>
        useChangedFilesExistence({
          workspaceId: 'ws-existence-new-touch',
          folderPath: WORKSPACE_FOLDER,
          paths,
          enabled: true,
        }),
      { initialProps: { paths: ['/ws/first.ts'] } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.size).toBe(0)

    // A new touch lands while the card is expanded.
    rerender({ paths: ['/ws/first.ts', '/ws/second.ts'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // first.ts is still TTL-fresh, so only the new path is re-resolved.
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspaces/ws-existence-new-touch/files/resolve',
      expect.objectContaining({
        body: JSON.stringify({ paths: ['second.ts'] }),
      }),
    )
    expect(result.current.has('/ws/second.ts')).toBe(true)
    expect(result.current.has('/ws/first.ts')).toBe(false)
  })
})
