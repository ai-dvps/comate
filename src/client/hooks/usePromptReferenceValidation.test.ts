import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePromptReferenceValidation } from './usePromptReferenceValidation'

const commands = [{ name: 'review' }, { name: 'commit' }]

function response(paths: string[]): Response {
  return {
    ok: true,
    json: async () => ({ paths }),
  } as Response
}

describe('usePromptReferenceValidation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports canonical skills immediately and exact files asynchronously', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(['src/app.ts']))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      usePromptReferenceValidation({
        workspaceId: 'ws-resolve',
        input: '/review /unknown @src/app.ts @missing.ts',
        commands,
      }),
    )

    expect(result.current.candidates).toEqual([
      { kind: 'skill', value: 'review', start: 0, end: 7, status: 'valid' },
      { kind: 'skill', value: 'unknown', start: 8, end: 16, status: 'invalid' },
      { kind: 'file', value: 'src/app.ts', start: 17, end: 28, status: 'pending' },
      { kind: 'file', value: 'missing.ts', start: 29, end: 40, status: 'pending' },
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-resolve/files/resolve',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.current.candidates).toEqual([
      { kind: 'skill', value: 'review', start: 0, end: 7, status: 'valid' },
      { kind: 'skill', value: 'unknown', start: 8, end: 16, status: 'invalid' },
      { kind: 'file', value: 'src/app.ts', start: 17, end: 28, status: 'valid' },
      { kind: 'file', value: 'missing.ts', start: 29, end: 40, status: 'invalid' },
    ])
  })

  it('drops a response from an older input generation', async () => {
    const pending: Array<(value: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () => new Promise<Response>((resolve) => pending.push(resolve)),
      ),
    )

    const { result, rerender } = renderHook(
      ({ input }) =>
        usePromptReferenceValidation({
          workspaceId: 'ws-stale',
          input,
          commands,
        }),
      { initialProps: { input: '@old.ts' } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    rerender({ input: '@new.ts' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    await act(async () => {
      pending[0](response(['old.ts']))
      await Promise.resolve()
    })
    expect(result.current.candidates).toEqual([
      { kind: 'file', value: 'new.ts', start: 0, end: 7, status: 'pending' },
    ])

    await act(async () => {
      pending[1](response(['new.ts']))
      await Promise.resolve()
    })
    expect(result.current.candidates).toEqual([
      { kind: 'file', value: 'new.ts', start: 0, end: 7, status: 'valid' },
    ])
  })

  it('retains confirmed file status when a refresh fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(['src/app.ts']))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      usePromptReferenceValidation({
        workspaceId: 'ws-refresh',
        input: '@src/app.ts',
        commands,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(result.current.references).toHaveLength(1)

    await act(async () => {
      const refreshPromise = result.current.refresh()
      await refreshPromise
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.candidates).toEqual([
      { kind: 'file', value: 'src/app.ts', start: 0, end: 11, status: 'valid' },
    ])
  })

  it('does not cache an older overlapping refresh response', async () => {
    const pending: Array<(value: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () => new Promise<Response>((resolve) => pending.push(resolve)),
      ),
    )

    const first = renderHook(() =>
      usePromptReferenceValidation({
        workspaceId: 'ws-refresh-race',
        input: '@race.ts',
        commands,
      }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
      pending[0](response(['race.ts']))
      await Promise.resolve()
    })

    let olderRefresh!: Promise<unknown>
    let newerRefresh!: Promise<unknown>
    act(() => {
      olderRefresh = first.result.current.refresh()
      newerRefresh = first.result.current.refresh()
    })

    await act(async () => {
      pending[2](response([]))
      await newerRefresh
    })
    await act(async () => {
      pending[1](response(['race.ts']))
      await olderRefresh
    })
    first.unmount()

    const second = renderHook(() =>
      usePromptReferenceValidation({
        workspaceId: 'ws-refresh-race',
        input: '@race.ts',
        commands,
      }),
    )

    expect(second.result.current.candidates[0].status).toBe('invalid')
  })

  it('bounds explicit file refresh requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(['bounded.ts']))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      usePromptReferenceValidation({
        workspaceId: 'ws-bounded-refresh',
        input: '@bounded.ts',
        commands,
      }),
    )

    await act(async () => {
      await result.current.refresh()
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-bounded-refresh/files/resolve',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('keeps the last confirmed skill status while commands reload or fail', () => {
    vi.stubGlobal('fetch', vi.fn())
    const { result, rerender } = renderHook(
      ({ loading, error, commandList }) =>
        usePromptReferenceValidation({
          workspaceId: 'ws-skills',
          input: '/review',
          commands: commandList,
          commandsLoading: loading,
          commandsError: error,
        }),
      {
        initialProps: {
          loading: false,
          error: undefined as string | undefined,
          commandList: commands,
        },
      },
    )

    expect(result.current.candidates[0].status).toBe('valid')
    rerender({ loading: true, error: undefined, commandList: [] })
    expect(result.current.candidates[0].status).toBe('valid')
    rerender({ loading: false, error: 'offline', commandList: [] })
    expect(result.current.candidates[0].status).toBe('valid')
  })
})
