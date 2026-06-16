import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TrigramCompletion, tokenize } from '../lib/ngram-completion'
import { renderHook, act } from '@testing-library/react'
import { useNgramCompletion } from './useNgramCompletion'

const promptsMock = vi.hoisted(() => ({ value: [] as string[] }))

vi.mock('./useSentPrompts', () => ({
  useSentPrompts: (workspaceId: string | undefined) => {
    return workspaceId ? promptsMock.value : []
  },
}))

describe('tokenize', () => {
  it('splits Latin runs into word tokens', () => {
    expect(tokenize('Explain the function')).toEqual([
      'explain',
      'the',
      'function',
    ])
  })

  it('splits CJK runs into individual characters', () => {
    expect(tokenize('解释这个函数')).toEqual(['解', '释', '这', '个', '函', '数'])
  })

  it('does not cross run boundaries', () => {
    expect(tokenize('解释这个 authLogin 函数')).toEqual([
      '解', '释', '这', '个',
      'authlogin',
      '函', '数',
    ])
  })
})

describe('TrigramCompletion', () => {
  it('suggests the next word from a learned trigram', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    model.train('explain the class')
    expect(model.suggest('explain the ')).toBe('function')
  })

  it('falls back to bigram when trigram is absent', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    expect(model.suggest('the ')).toBe('function')
  })

  it('prepends a space for Latin continuation when input lacks trailing whitespace', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    expect(model.suggest('explain')).toBe(' the')
  })

  it('returns null when confidence is too low', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the class')
    expect(model.suggest('explain the ')).toBeNull()
  })

  it('returns null for untrained input', () => {
    const model = new TrigramCompletion()
    expect(model.suggest('hello ')).toBeNull()
  })

  it('trains CJK prompts with character-level tokens', () => {
    const model = new TrigramCompletion()
    model.train('解释这个函数')
    model.train('解释这个函数')
    expect(model.suggest('解释这个')).toBe('函')
  })

  it('clears learned data', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    model.clear()
    expect(model.suggest('explain the ')).toBeNull()
  })
})

describe('useNgramCompletion', () => {
  beforeEach(() => {
    promptsMock.value = []
  })

  it('returns no suggestion before training', () => {
    promptsMock.value = []
    const { result } = renderHook(() => useNgramCompletion('ws-1'))
    expect(result.current.suggest('explain the ')).toBeNull()
  })

  it('suggests based on workspace prompt history', () => {
    promptsMock.value = ['explain the function', 'explain the function']
    const { result } = renderHook(() => useNgramCompletion('ws-1'))
    expect(result.current.suggest('explain the ')).toBe('function')
  })

  it('trains incrementally via train()', () => {
    promptsMock.value = []
    const { result } = renderHook(() => useNgramCompletion('ws-1'))

    act(() => {
      result.current.train('explain the function')
      result.current.train('explain the function')
    })

    expect(result.current.suggest('explain the ')).toBe('function')
  })

  it('clears when workspace changes', () => {
    promptsMock.value = ['explain the function', 'explain the function']
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) => useNgramCompletion(workspaceId),
      { initialProps: { workspaceId: 'ws-1' } },
    )
    expect(result.current.suggest('explain the ')).toBe('function')

    promptsMock.value = []
    rerender({ workspaceId: 'ws-2' })
    expect(result.current.suggest('explain the ')).toBeNull()
  })
})
