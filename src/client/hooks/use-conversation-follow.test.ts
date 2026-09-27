import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useConversationFollow } from './use-conversation-follow'

describe('useConversationFollow', () => {
  it('exits follow immediately for upward wheel, keyboard, and touch input', () => {
    const { result } = renderHook(() => useConversationFollow())

    act(() => result.current.onWheel(-20))
    expect(result.current.isFollowing).toBe(false)
    expect(result.current.isFollowingRef.current).toBe(false)

    act(() => result.current.resetForDisplayMode())
    act(() => result.current.onKeyDown('PageUp'))
    expect(result.current.isFollowing).toBe(false)

    act(() => result.current.resetForDisplayMode())
    act(() => result.current.onTouchStart(100))
    act(() => result.current.onTouchMove(120))
    expect(result.current.isFollowing).toBe(false)
  })

  it('restores follow only at the physical bottom or by explicit command', () => {
    const { result } = renderHook(() => useConversationFollow())

    act(() => result.current.onWheel(-20))
    act(() => result.current.onScrollPosition(980, false))
    expect(result.current.isFollowing).toBe(false)

    act(() => result.current.onScrollPosition(1_000, true))
    expect(result.current.isFollowing).toBe(true)

    act(() => result.current.onSearchJump())
    expect(result.current.isFollowing).toBe(false)
    act(() => result.current.followToBottom())
    expect(result.current.isFollowing).toBe(true)
  })

  it('does not restore follow from a stale bottom callback after upward input', () => {
    const { result } = renderHook(() => useConversationFollow())

    act(() => result.current.onWheel(-20))
    act(() => result.current.onScrollPosition(1_000, true))
    expect(result.current.isFollowing).toBe(false)

    act(() => result.current.onScrollPosition(980, false))
    act(() => result.current.onScrollPosition(1_000, true))
    expect(result.current.isFollowing).toBe(true)
  })

  it('does not restore follow when search closes', () => {
    const { result } = renderHook(() => useConversationFollow())

    act(() => result.current.onSearchJump())
    act(() => result.current.onSearchClose())

    expect(result.current.isFollowing).toBe(false)
  })

  it('bounds programmatic scroll suppression to its token', () => {
    const { result } = renderHook(() => useConversationFollow())
    let token = 0

    act(() => {
      result.current.onScrollPosition(1_000, true)
      token = result.current.beginProgrammaticScroll()
      result.current.onScrollPosition(500, false)
    })
    expect(result.current.isFollowing).toBe(true)

    act(() => result.current.endProgrammaticScroll(token))
    act(() => result.current.onScrollPosition(480, false))
    expect(result.current.isFollowing).toBe(false)
  })

  it('preserves browsing on visibility recovery and follows after a mode reset', () => {
    const { result } = renderHook(() => useConversationFollow())

    act(() => result.current.onWheel(-20))
    expect(result.current.onVisibilityRecovery()).toBe(false)

    act(() => result.current.resetForDisplayMode())
    expect(result.current.isFollowing).toBe(true)
    expect(result.current.onVisibilityRecovery()).toBe(true)
  })
})
