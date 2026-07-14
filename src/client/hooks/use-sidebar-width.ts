import { useCallback, useState } from 'react'
import { useResizableWidth } from './use-resizable-width'

const RAIL_WIDTH = 48
const MIN_WIDTH = 200
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 288
const WIDTH_KEY = 'sidebar-width'
const COLLAPSED_KEY = 'sidebar-collapsed'
const PREVIOUS_WIDTH_KEY = 'sidebar-previous-width'

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    if (stored) {
      return stored === 'true'
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return false
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

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value))
}

export function useSidebarWidth() {
  const { width: expandedWidth, setWidth: setExpandedWidth } = useResizableWidth({
    storageKey: WIDTH_KEY,
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
  })

  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => readCollapsed())
  const [previousWidth, setPreviousWidth] = useState<number>(() =>
    readPreviousWidth(expandedWidth),
  )

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((collapsed) => {
      const nextCollapsed = !collapsed
      if (nextCollapsed) {
        const currentWidth = expandedWidth
        setPreviousWidth(currentWidth)
        writePreviousWidth(currentWidth)
      } else {
        const restoredWidth = clampWidth(previousWidth)
        setExpandedWidth(restoredWidth)
      }
      writeCollapsed(nextCollapsed)
      return nextCollapsed
    })
  }, [expandedWidth, previousWidth, setExpandedWidth])

  return {
    width: isCollapsed ? RAIL_WIDTH : expandedWidth,
    setWidth: setExpandedWidth,
    isCollapsed,
    toggleCollapse,
  }
}
