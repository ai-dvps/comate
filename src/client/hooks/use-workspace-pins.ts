import { useState, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'workspace-pins'

function readPinnedIds(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
        return parsed
      }
    }
  } catch {
    // localStorage unavailable or corrupt data
  }
  return []
}

function persistPinnedIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // localStorage unavailable
  }
}

export interface UseWorkspacePinsResult {
  pinnedIds: string[]
  isPinned: (id: string) => boolean
  togglePin: (id: string) => void
  prunePins: (validIds: string[]) => void
}

export function useWorkspacePins(): UseWorkspacePinsResult {
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinnedIds)

  useEffect(() => {
    persistPinnedIds(pinnedIds)
  }, [pinnedIds])

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds])

  const prunePins = useCallback((validIds: string[]) => {
    const valid = new Set(validIds)
    setPinnedIds((prev) => {
      const next = prev.filter((id) => valid.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [])

  return { pinnedIds, isPinned, togglePin, prunePins }
}
