import { useEffect, useState } from 'react'

export const MIN_CONVERSATION_WIDTH = 520

interface ResponsiveShellInput {
  viewportWidth: number
  leftWidth: number
  rightWidth: number
  leftPreferredExpanded: boolean
  rightPreferredExpanded: boolean
  forceLeftExpanded?: boolean
  forceRightExpanded?: boolean
  minConversationWidth?: number
}

export interface ResponsiveShellState {
  leftExpanded: boolean
  rightExpanded: boolean
}

export function deriveResponsiveShell({
  viewportWidth,
  leftWidth,
  rightWidth,
  leftPreferredExpanded,
  rightPreferredExpanded,
  forceLeftExpanded = false,
  forceRightExpanded = false,
  minConversationWidth = MIN_CONVERSATION_WIDTH,
}: ResponsiveShellInput): ResponsiveShellState {
  const leftExpanded = leftPreferredExpanded
  const rightExpanded = rightPreferredExpanded
  const preferredLeftWidth = leftPreferredExpanded ? leftWidth : 0
  const preferredRightWidth = rightPreferredExpanded ? rightWidth : 0

  if (viewportWidth >= minConversationWidth + preferredLeftWidth + preferredRightWidth) {
    return {
      leftExpanded: leftExpanded || forceLeftExpanded,
      rightExpanded: rightExpanded || forceRightExpanded,
    }
  }

  if (viewportWidth >= minConversationWidth + preferredLeftWidth) {
    return {
      leftExpanded: leftExpanded || forceLeftExpanded,
      rightExpanded: forceRightExpanded,
    }
  }

  return {
    leftExpanded: forceLeftExpanded,
    rightExpanded: forceRightExpanded,
  }
}

function readViewportWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth
}

export function useViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth)

  useEffect(() => {
    const handleResize = () => setViewportWidth(readViewportWidth())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return viewportWidth
}
