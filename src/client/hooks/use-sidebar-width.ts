import { useState, useCallback } from 'react'

const STORAGE_KEY = 'sidebar-width'
const DEFAULT_WIDTH = 288
const MIN_WIDTH = 200
const MAX_WIDTH = 600

function getInitialWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed)) {
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed))
      }
    }
  } catch {
    // localStorage not available or corrupt data
  }
  return DEFAULT_WIDTH
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // localStorage not available
  }
}

export function useSidebarWidth() {
  const [width, setWidthState] = useState<number>(getInitialWidth)

  const setWidth = useCallback((newWidth: number) => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
    setWidthState(clamped)
    saveWidth(clamped)
  }, [])

  return { width, setWidth }
}
