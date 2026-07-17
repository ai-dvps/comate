import { useCallback, useState } from 'react'
import { useResizableWidth } from './use-resizable-width'

export const GIT_PANEL_RAIL_WIDTH = 48
const MIN_WIDTH = 240
const DEFAULT_WIDTH = 320
const WIDTH_KEY = 'git-changes-panel-width'
const COLLAPSED_KEY = 'git-changes-panel-collapsed'
const PREVIOUS_WIDTH_KEY = 'git-changes-panel-previous-width'

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

export function useGitChangesPanelWidth() {
  const maxWidth = Math.floor(
    typeof window !== 'undefined' ? window.innerWidth * 0.5 : 640,
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
    width: isCollapsed ? GIT_PANEL_RAIL_WIDTH : expandedWidth,
    setWidth,
    isCollapsed,
    toggleCollapse,
  }
}
