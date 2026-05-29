import { useState, useCallback } from 'react'

export interface UseResizableWidthOptions {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

export function useResizableWidth(options: UseResizableWidthOptions) {
  const { storageKey, defaultWidth, minWidth, maxWidth } = options

  const [width, setWidthState] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const parsed = parseInt(stored, 10)
        if (!isNaN(parsed)) {
          return Math.min(maxWidth, Math.max(minWidth, parsed))
        }
      }
    } catch {
      // localStorage not available or corrupt data
    }
    return defaultWidth
  })

  const setWidth = useCallback(
    (newWidth: number) => {
      const clamped = Math.min(maxWidth, Math.max(minWidth, newWidth))
      setWidthState(clamped)
      try {
        localStorage.setItem(storageKey, String(clamped))
      } catch {
        // localStorage not available
      }
    },
    [maxWidth, minWidth, storageKey],
  )

  return { width, setWidth }
}
