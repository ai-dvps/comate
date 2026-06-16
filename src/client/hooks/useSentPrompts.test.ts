import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSentPrompts } from './useSentPrompts'

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    promptHistory: {} as Record<string, string[]>,
  }

  function notify() {
    listeners.forEach((l) => l())
  }

  return {
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setPromptHistory: (workspaceId: string, prompts: string[]) => {
      state.promptHistory[workspaceId] = prompts
      notify()
    },
  }
})

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector?: (s: ReturnType<typeof chatStoreMock.getState>) => unknown) => {
    const state = chatStoreMock.getState()
    return selector ? selector(state) : state
  },
}))

describe('useSentPrompts', () => {
  beforeEach(() => {
    chatStoreMock.getState().promptHistory = {}
  })

  it('returns an empty array when there is no workspace', () => {
    const { result } = renderHook(() => useSentPrompts(undefined))
    expect(result.current).toEqual([])
  })

  it('returns sent prompts in reverse chronological order', () => {
    // Stored chronologically; displayed newest-first.
    chatStoreMock.setPromptHistory('ws-1', ['first prompt', 'second prompt'])

    const { result } = renderHook(() => useSentPrompts('ws-1'))
    expect(result.current).toEqual(['second prompt', 'first prompt'])
  })

  it('drops empty prompts', () => {
    chatStoreMock.setPromptHistory('ws-1', ['hello', '   ', 'world'])

    const { result } = renderHook(() => useSentPrompts('ws-1'))
    expect(result.current).toEqual(['world', 'hello'])
  })

  it('skips adjacent duplicate prompts', () => {
    chatStoreMock.setPromptHistory('ws-1', ['dup', 'dup', 'unique'])

    const { result } = renderHook(() => useSentPrompts('ws-1'))
    expect(result.current).toEqual(['unique', 'dup'])
  })

  it('keeps non-adjacent duplicate prompts', () => {
    chatStoreMock.setPromptHistory('ws-1', ['dup', 'other', 'dup'])

    const { result } = renderHook(() => useSentPrompts('ws-1'))
    expect(result.current).toEqual(['dup', 'other', 'dup'])
  })

  it('updates when prompt history changes', () => {
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) => useSentPrompts(workspaceId),
      { initialProps: { workspaceId: 'ws-1' } },
    )

    expect(result.current).toEqual([])

    chatStoreMock.setPromptHistory('ws-1', ['hello'])

    rerender({ workspaceId: 'ws-1' })
    expect(result.current).toEqual(['hello'])
  })
})
