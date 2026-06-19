import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useMessageSearch, findMessageSearchMatches } from './useMessageSearch'
import type { ChatMessage } from '../types/message'

function makeTextMessage(text: string, id = 'msg-1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    timestamp: 1,
  }
}

describe('findMessageSearchMatches', () => {
  it('returns no matches for an empty query', () => {
    const messages = [makeTextMessage('hello world')]
    expect(findMessageSearchMatches(messages, '')).toEqual([])
    expect(findMessageSearchMatches(messages, '   ')).toEqual([])
  })

  it('performs case-insensitive substring matching', () => {
    const messages = [makeTextMessage('Hello World')]
    expect(findMessageSearchMatches(messages, 'hello')).toHaveLength(1)
    expect(findMessageSearchMatches(messages, 'WORLD')).toHaveLength(1)
  })

  it('counts multiple matches inside one message separately', () => {
    const messages = [makeTextMessage('config and config again')]
    const matches = findMessageSearchMatches(messages, 'config')
    expect(matches).toHaveLength(2)
    expect(matches[0]).toMatchObject({ start: 0, end: 6 })
    expect(matches[1]).toMatchObject({ start: 11, end: 17 })
  })

  it('searches tool_result parts', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            output: 'result contains needle',
            isError: false,
          },
        ],
        timestamp: 1,
      },
    ]
    expect(findMessageSearchMatches(messages, 'needle')).toHaveLength(1)
  })

  it('searches thinking parts', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'thinking', text: 'thinking about config', state: 'complete' }],
        timestamp: 1,
      },
    ]
    expect(findMessageSearchMatches(messages, 'config')).toHaveLength(1)
  })

  it('searches tool_use input and tool name', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool_use',
            toolUseId: 'tu-1',
            toolName: 'read_file',
            input: { path: '/config.json' },
            state: 'complete',
          },
        ],
        timestamp: 1,
      },
    ]
    expect(findMessageSearchMatches(messages, 'read_file')).toHaveLength(1)
    expect(findMessageSearchMatches(messages, 'config')).toHaveLength(1)
  })

  it('returns an empty array and zero total matches when nothing matches', () => {
    const messages = [makeTextMessage('hello world')]
    expect(findMessageSearchMatches(messages, 'xyz')).toEqual([])
  })

  it('reports the message and part index for each match', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'first config' },
          { type: 'text', text: 'second config' },
        ],
        timestamp: 1,
      },
    ]
    const matches = findMessageSearchMatches(messages, 'config')
    expect(matches).toHaveLength(2)
    expect(matches[0]).toMatchObject({ messageId: 'msg-1', partIndex: 0 })
    expect(matches[1]).toMatchObject({ messageId: 'msg-1', partIndex: 1 })
  })
})

describe('useMessageSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no matches and an empty query', () => {
    const { result } = renderHook(() =>
      useMessageSearch({ messages: [makeTextMessage('hello')] }),
    )
    expect(result.current.query).toBe('')
    expect(result.current.matches).toEqual([])
    expect(result.current.totalMatches).toBe(0)
    expect(result.current.currentMatchIndex).toBe(0)
    expect(result.current.currentMatch).toBeNull()
  })

  it('debounces query updates', () => {
    const { result } = renderHook(() =>
      useMessageSearch({ messages: [makeTextMessage('config')] }),
    )
    act(() => {
      result.current.setQuery('config')
    })
    expect(result.current.isSearching).toBe(true)
    expect(result.current.matches).toEqual([])

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.isSearching).toBe(false)
    expect(result.current.totalMatches).toBe(1)
  })

  it('navigates forward and backward through matches with wrapping', () => {
    const { result } = renderHook(() =>
      useMessageSearch({ messages: [makeTextMessage('a a a')] }),
    )
    act(() => {
      result.current.setQuery('a')
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.totalMatches).toBe(3)
    expect(result.current.currentMatchIndex).toBe(0)

    act(() => result.current.nextMatch())
    expect(result.current.currentMatchIndex).toBe(1)
    act(() => result.current.nextMatch())
    expect(result.current.currentMatchIndex).toBe(2)
    act(() => result.current.nextMatch())
    expect(result.current.currentMatchIndex).toBe(0)

    act(() => result.current.prevMatch())
    expect(result.current.currentMatchIndex).toBe(2)
  })

  it('resets to the first match when the query changes', () => {
    const { result } = renderHook(() =>
      useMessageSearch({ messages: [makeTextMessage('foo bar')] }),
    )
    act(() => {
      result.current.setQuery('bar')
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    act(() => result.current.nextMatch())
    expect(result.current.currentMatchIndex).toBe(0)

    act(() => {
      result.current.setQuery('foo')
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.currentMatchIndex).toBe(0)
  })

  it('clamps the current index when the match list shrinks', () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) =>
        useMessageSearch({ messages: [makeTextMessage(text)] }),
      { initialProps: { text: 'a a a' } },
    )
    act(() => {
      result.current.setQuery('a')
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    act(() => result.current.nextMatch())
    act(() => result.current.nextMatch())
    expect(result.current.currentMatchIndex).toBe(2)

    rerender({ text: 'a' })
    expect(result.current.currentMatchIndex).toBe(0)
  })

  it('returns 0/0 when there are no matches', () => {
    const { result } = renderHook(() =>
      useMessageSearch({ messages: [makeTextMessage('hello')] }),
    )
    act(() => {
      result.current.setQuery('xyz')
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.totalMatches).toBe(0)
    expect(result.current.currentMatch).toBeNull()
    expect(result.current.currentMatchIndex).toBe(0)
  })
})
