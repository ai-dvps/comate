import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'

const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export interface ConversationFollowController {
  isFollowing: boolean
  isFollowingRef: MutableRefObject<boolean>
  onWheel: (deltaY: number) => void
  onKeyDown: (key: string) => void
  onTouchStart: (clientY: number) => void
  onTouchMove: (clientY: number) => void
  onScrollPosition: (scrollTop: number, isAtPhysicalBottom: boolean) => void
  onSearchJump: () => void
  onSearchClose: () => void
  followToBottom: () => void
  resetForDisplayMode: () => void
  onVisibilityRecovery: () => boolean
  beginProgrammaticScroll: () => number
  endProgrammaticScroll: (token: number) => void
}

export function useConversationFollow(): ConversationFollowController {
  const [isFollowing, setIsFollowing] = useState(true)
  const isFollowingRef = useRef(true)
  const lastScrollTopRef = useRef<number | null>(null)
  const lastTouchYRef = useRef<number | null>(null)
  const nextProgrammaticTokenRef = useRef(0)
  const programmaticTokenRef = useRef<number | null>(null)

  const setFollowing = useCallback((next: boolean) => {
    if (isFollowingRef.current === next) return
    isFollowingRef.current = next
    setIsFollowing(next)
  }, [])

  const exitFollow = useCallback(() => setFollowing(false), [setFollowing])

  const onWheel = useCallback((deltaY: number) => {
    if (deltaY < 0) exitFollow()
  }, [exitFollow])

  const onKeyDown = useCallback((key: string) => {
    if (UPWARD_KEYS.has(key)) exitFollow()
  }, [exitFollow])

  const onTouchStart = useCallback((clientY: number) => {
    lastTouchYRef.current = clientY
  }, [])

  const onTouchMove = useCallback((clientY: number) => {
    const previous = lastTouchYRef.current
    lastTouchYRef.current = clientY
    if (previous !== null && clientY > previous) exitFollow()
  }, [exitFollow])

  const onScrollPosition = useCallback((scrollTop: number, isAtPhysicalBottom: boolean) => {
    const previous = lastScrollTopRef.current
    lastScrollTopRef.current = scrollTop
    if (programmaticTokenRef.current !== null) return
    if (previous !== null && scrollTop < previous) {
      exitFollow()
      return
    }
    if (isAtPhysicalBottom) setFollowing(true)
  }, [exitFollow, setFollowing])

  const beginProgrammaticScroll = useCallback(() => {
    nextProgrammaticTokenRef.current += 1
    programmaticTokenRef.current = nextProgrammaticTokenRef.current
    return nextProgrammaticTokenRef.current
  }, [])

  const endProgrammaticScroll = useCallback((token: number) => {
    if (programmaticTokenRef.current === token) {
      programmaticTokenRef.current = null
    }
  }, [])

  const onSearchJump = useCallback(() => setFollowing(false), [setFollowing])
  const onSearchClose = useCallback(() => {}, [])
  const followToBottom = useCallback(() => setFollowing(true), [setFollowing])
  const resetForDisplayMode = useCallback(() => setFollowing(true), [setFollowing])
  const onVisibilityRecovery = useCallback(() => isFollowingRef.current, [])

  return {
    isFollowing,
    isFollowingRef,
    onWheel,
    onKeyDown,
    onTouchStart,
    onTouchMove,
    onScrollPosition,
    onSearchJump,
    onSearchClose,
    followToBottom,
    resetForDisplayMode,
    onVisibilityRecovery,
    beginProgrammaticScroll,
    endProgrammaticScroll,
  }
}
