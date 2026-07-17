import { useCallback, useState } from 'react'
import { useResizableWidth } from './use-resizable-width'

export const RAIL_WIDTH = 48
const MIN_WIDTH = 360
const DEFAULT_WIDTH = 640
const WIDTH_KEY = 'right-panel-width'
const COLLAPSED_KEY = 'right-panel-collapsed'
const PREVIOUS_WIDTH_KEY = 'right-panel-previous-width'

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    if (stored === 'false') {
      return false
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return true
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, String(value))
  } catch {
    // localStorage not available
  }
}

function readPreviousWidth(fallback: number): number {
  try {
    const stored = localStorage.getItem(PREVIOUS_WIDTH_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed)) {
        return parsed
      }
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return fallback
}

function writePreviousWidth(value: number): void {
  try {
    localStorage.setItem(PREVIOUS_WIDTH_KEY, String(value))
  } catch {
    // localStorage not available
  }
}

export function useRightPanelWidth() {
  const maxWidth = Math.floor(
    typeof window !== 'undefined' ? window.innerWidth * 0.5 : DEFAULT_WIDTH,
  )
  const { width: expandedWidth, setWidth: setExpandedWidth } = useResizableWidth({
    storageKey: WIDTH_KEY,
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth,
  })

  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => readCollapsed())
  const [previousWidth, setPreviousWidth] = useState<number>(() =>
    readPreviousWidth(expandedWidth),
  )

  const setWidth = useCallback(
    (value: number) => {
      const clamped = Math.min(maxWidth, Math.max(MIN_WIDTH, value))
      setExpandedWidth(clamped)
      if (isCollapsed) {
        setPreviousWidth(clamped)
        writePreviousWidth(clamped)
      }
    },
    [isCollapsed, maxWidth, setExpandedWidth],
  )

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((collapsed) => {
      const nextCollapsed = !collapsed
      if (nextCollapsed) {
        const currentWidth = expandedWidth
        setPreviousWidth(currentWidth)
        writePreviousWidth(currentWidth)
      } else {
        setExpandedWidth(previousWidth)
      }
      writeCollapsed(nextCollapsed)
      return nextCollapsed
    })
  }, [expandedWidth, previousWidth, setExpandedWidth])

  return {
    width: isCollapsed ? RAIL_WIDTH : expandedWidth,
    setWidth,
    isCollapsed,
    toggleCollapse,
    expandedWidth,
  }
}
