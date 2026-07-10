import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWorkspacePins } from './use-workspace-pins'

const STORAGE_KEY = 'workspace-pins'

describe('useWorkspacePins', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts empty when nothing is stored', () => {
    const { result } = renderHook(() => useWorkspacePins())
    expect(result.current.pinnedIds).toEqual([])
    expect(result.current.isPinned('a')).toBe(false)
  })

  it('reads stored pinned ids on init', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['x', 'y']))
    const { result } = renderHook(() => useWorkspacePins())
    expect(result.current.pinnedIds).toEqual(['x', 'y'])
  })

  it('falls back to empty on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    const { result } = renderHook(() => useWorkspacePins())
    expect(result.current.pinnedIds).toEqual([])
  })

  it('falls back to empty when stored value is not a string array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }))
    const { result } = renderHook(() => useWorkspacePins())
    expect(result.current.pinnedIds).toEqual([])
  })

  it('togglePin appends new ids in order and removes existing ones', () => {
    const { result } = renderHook(() => useWorkspacePins())
    act(() => result.current.togglePin('a'))
    act(() => result.current.togglePin('b'))
    expect(result.current.pinnedIds).toEqual(['a', 'b'])
    expect(result.current.isPinned('a')).toBe(true)
    act(() => result.current.togglePin('a'))
    expect(result.current.pinnedIds).toEqual(['b'])
    expect(result.current.isPinned('a')).toBe(false)
  })

  it('does not duplicate entries when pinning', () => {
    const { result } = renderHook(() => useWorkspacePins())
    act(() => result.current.togglePin('a'))
    const count = result.current.pinnedIds.filter((id) => id === 'a').length
    expect(count).toBe(1)
  })

  it('persists to localStorage after toggles', () => {
    const { result } = renderHook(() => useWorkspacePins())
    act(() => result.current.togglePin('a'))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['a'])
    act(() => result.current.togglePin('b'))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['a', 'b'])
  })

  it('prunePins drops ids not in the valid set and preserves survivor order', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'b', 'c']))
    const { result } = renderHook(() => useWorkspacePins())
    act(() => result.current.prunePins(['c', 'a']))
    expect(result.current.pinnedIds).toEqual(['a', 'c'])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['a', 'c'])
  })
})
