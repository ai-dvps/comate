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

  it('resolves canonical skills immediately and exact files asynchronously', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(['src/app.ts']))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      usePromptReferenceValidation({
        workspaceId: 'ws-resolve',
        input: '/review /unknown @src/app.ts @missing.ts',
        commands,
      }),
    )

    expect(result.current.references).toEqual([
      { kind: 'skill', value: 'review', start: 0, end: 7 },
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-resolve/files/resolve',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.current.references).toEqual([
      { kind: 'skill', value: 'review', start: 0, end: 7 },
      { kind: 'file', value: 'src/app.ts', start: 17, end: 28 },
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
    expect(result.current.references).toEqual([])

    await act(async () => {
      pending[1](response(['new.ts']))
      await Promise.resolve()
    })
    expect(result.current.references).toEqual([
      { kind: 'file', value: 'new.ts', start: 0, end: 7 },
    ])
  })

  it('refreshes visible file references without exposing validation errors', async () => {
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

    act(() => result.current.refresh())
    expect(result.current.references).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.references).toEqual([])
  })
})
