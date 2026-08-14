import { useEffect, useState } from 'react'

export const MIN_CONVERSATION_WIDTH = 520

interface ResponsiveShellInput {
  viewportWidth: number
  leftWidth: number
  rightWidth: number
  leftPreferredExpanded: boolean
  rightPreferredExpanded: boolean
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
  minConversationWidth = MIN_CONVERSATION_WIDTH,
}: ResponsiveShellInput): ResponsiveShellState {
  const leftExpanded = leftPreferredExpanded
  const rightExpanded = rightPreferredExpanded
  const preferredLeftWidth = leftPreferredExpanded ? leftWidth : 0
  const preferredRightWidth = rightPreferredExpanded ? rightWidth : 0

  if (viewportWidth >= minConversationWidth + preferredLeftWidth + preferredRightWidth) {
    return { leftExpanded, rightExpanded }
  }

  if (viewportWidth >= minConversationWidth + preferredLeftWidth) {
    return { leftExpanded, rightExpanded: false }
  }

  return { leftExpanded: false, rightExpanded: false }
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
