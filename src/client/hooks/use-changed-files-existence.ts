import { useEffect, useMemo, useRef, useState } from 'react'
import { getRelativePath } from '../components/tool-renderers/path-utils'
import {
  readTtlCache,
  resolveExistingWorkspacePaths,
  workspacePathKey,
  writeTtlCache,
  type TtlCacheEntry,
} from '../lib/workspace-file-resolution'

export interface UseChangedFilesExistenceOptions {
  workspaceId: string
  /** Workspace folder used to relativize touched paths before resolving. */
  folderPath: string
  /** Normalized absolute touched-file paths (TouchedFileEntry.path). */
  paths: string[]
  /** Checks run only while enabled (card expanded) and on changes then (KTD4). */
  enabled: boolean
}

const RESOLVE_DEBOUNCE_MS = 150
const EXISTENCE_CACHE_TTL_MS = 5000

interface PathCheck {
  absolute: string
  relative: string
}

const existenceCache = new Map<string, TtlCacheEntry<boolean>>()

function cachedExistence(
  workspaceId: string,
  relativePath: string,
): boolean | undefined {
  return readTtlCache(existenceCache, workspacePathKey(workspaceId, relativePath))
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

/**
 * Deletion existence overlay (plan KTD4): reports which of the session's
 * touched files no longer exist on disk, at view time, without mutating any
 * store data. The returned set holds ABSOLUTE normalized paths so callers can
 * test membership directly and override the stream status to deleted.
 */
export function useChangedFilesExistence({
  workspaceId,
  folderPath,
  paths,
  enabled,
}: UseChangedFilesExistenceOptions): Set<string> {
  // Relativize against the workspace; paths outside it (null) never reach the
  // endpoint, which rejects absolute paths (KTD6).
  const checks = useMemo<PathCheck[]>(() => {
    if (!folderPath) return []
    const seen = new Set<string>()
    const result: PathCheck[] = []
    for (const absolute of paths) {
      const relative = getRelativePath(absolute, folderPath)
      if (relative === null || seen.has(relative)) continue
      seen.add(relative)
      result.push({ absolute, relative })
    }
    return result
  }, [paths, folderPath])

  const [missing, setMissing] = useState<Set<string>>(() => new Set())
  const requestGenerationRef = useRef(0)

  useEffect(() => {
    if (!enabled) return

    // Fresh cache entries apply immediately; paths about to be re-checked
    // keep their previous outcome so a deleted badge never flickers off and
    // back on during the debounce window.
    const unresolved: PathCheck[] = []
    const confirmed = new Map<string, boolean>()
    for (const check of checks) {
      const cached = cachedExistence(workspaceId, check.relative)
      if (cached === undefined) unresolved.push(check)
      else confirmed.set(check.absolute, cached)
    }

    setMissing((current) => {
      const next = new Set(current)
      for (const [absolute, exists] of confirmed) {
        if (exists) next.delete(absolute)
        else next.add(absolute)
      }
      return setsEqual(next, current) ? current : next
    })

    if (!workspaceId || unresolved.length === 0) return

    const controller = new AbortController()
    const generation = ++requestGenerationRef.current
    const timer = setTimeout(() => {
      void resolveExistingWorkspacePaths(
        workspaceId,
        unresolved.map((check) => check.relative),
        controller.signal,
      )
        .then((existing) => {
          if (
            controller.signal.aborted ||
            generation !== requestGenerationRef.current
          ) {
            return
          }
          writeTtlCache(
            existenceCache,
            unresolved.map((check) => [
              workspacePathKey(workspaceId, check.relative),
              existing.has(check.relative),
            ]),
            EXISTENCE_CACHE_TTL_MS,
          )
          setMissing((current) => {
            const next = new Set(current)
            for (const check of unresolved) {
              if (existing.has(check.relative)) next.delete(check.absolute)
              else next.add(check.absolute)
            }
            return setsEqual(next, current) ? current : next
          })
        })
        .catch(() => {
          // A failed check leaves the previous missing set untouched (KTD4).
        })
    }, RESOLVE_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [checks, enabled, workspaceId])

  // Expose only paths still present in the current touched list.
  const currentPaths = useMemo(() => new Set(paths), [paths])
  return useMemo(
    () => new Set([...missing].filter((absolute) => currentPaths.has(absolute))),
    [missing, currentPaths],
  )
}
