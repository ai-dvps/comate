import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSentPrompts } from './useSentPrompts'

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    messages: {} as Record<
      string,
      { id: string; role: 'user' | 'assistant' | 'system'; parts: { type: string; text?: string }[]; timestamp: number }[]
    >,
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
    setMessages: (
      sessionId: string,
      messages: (typeof state.messages)[string],
    ) => {
      state.messages[sessionId] = messages
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
    chatStoreMock.getState().messages = {}
  })

  it('returns an empty array when there is no session', () => {
    const { result } = renderHook(() => useSentPrompts(undefined))
    expect(result.current).toEqual([])
  })

  it('returns sent prompts in reverse chronological order', () => {
    chatStoreMock.setMessages('session-1', [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first prompt' }], timestamp: 1 },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }], timestamp: 2 },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'second prompt' }], timestamp: 3 },
    ])

    const { result } = renderHook(() => useSentPrompts('session-1'))
    expect(result.current).toEqual(['second prompt', 'first prompt'])
  })

  it('extracts text parts that are not at index 0', () => {
    chatStoreMock.setMessages('session-1', [
      {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'tool_result', toolUseId: 't1', output: 'out', isError: false } as unknown as { type: string; text?: string },
          { type: 'text', text: 'actual prompt' },
        ],
        timestamp: 1,
      },
    ])

    const { result } = renderHook(() => useSentPrompts('session-1'))
    expect(result.current).toEqual(['actual prompt'])
  })

  it('drops user messages with no text part', () => {
    chatStoreMock.setMessages('session-1', [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'tool_result', toolUseId: 't1', output: 'out', isError: false } as unknown as { type: string; text?: string }],
        timestamp: 1,
      },
    ])

    const { result } = renderHook(() => useSentPrompts('session-1'))
    expect(result.current).toEqual([])
  })

  it('skips adjacent duplicate prompts', () => {
    chatStoreMock.setMessages('session-1', [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'dup' }], timestamp: 1 },
      { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'dup' }], timestamp: 2 },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'unique' }], timestamp: 3 },
    ])

    const { result } = renderHook(() => useSentPrompts('session-1'))
    expect(result.current).toEqual(['unique', 'dup'])
  })

  it('keeps non-adjacent duplicate prompts', () => {
    chatStoreMock.setMessages('session-1', [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'dup' }], timestamp: 1 },
      { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'other' }], timestamp: 2 },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'dup' }], timestamp: 3 },
    ])

    const { result } = renderHook(() => useSentPrompts('session-1'))
    expect(result.current).toEqual(['dup', 'other', 'dup'])
  })

  it('ignores non-user roles', () => {
    chatStoreMock.setMessages('session-1', [
      { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'assistant text' }], timestamp: 1 },
      { id: 'm2', role: 'system', parts: [{ type: 'text', text: 'system text' }], timestamp: 2 },
    ])

    const { result } = renderHook(() => useSentPrompts('session-1'))
    expect(result.current).toEqual([])
  })

  it('updates when messages change', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useSentPrompts(sessionId),
      { initialProps: { sessionId: 'session-1' } },
    )

    expect(result.current).toEqual([])

    chatStoreMock.setMessages('session-1', [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }], timestamp: 1 },
    ])

    rerender({ sessionId: 'session-1' })
    expect(result.current).toEqual(['hello'])
  })
})
