import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  scanPromptReferences,
  type PromptReference,
} from '../lib/prompt-references'

interface CommandName {
  name: string
}

interface UsePromptReferenceValidationOptions {
  workspaceId: string
  input: string
  commands: CommandName[]
}

interface UsePromptReferenceValidationResult {
  references: PromptReference[]
  refresh: () => void
}

interface CacheEntry {
  valid: boolean
  expiresAt: number
}

interface FileResolution {
  key: string
  validPaths: Set<string>
}

const VALIDATION_DEBOUNCE_MS = 150
const CACHE_TTL_MS = 5000
const validationCache = new Map<string, CacheEntry>()

function cacheKey(workspaceId: string, path: string): string {
  return `${workspaceId}\0${path}`
}

export function usePromptReferenceValidation({
  workspaceId,
  input,
  commands,
}: UsePromptReferenceValidationOptions): UsePromptReferenceValidationResult {
  const candidates = useMemo(() => scanPromptReferences(input), [input])
  const filePaths = useMemo(
    () => [
      ...new Set(
        candidates
          .filter((candidate) => candidate.kind === 'file')
          .map((candidate) => candidate.value),
      ),
    ].sort(),
    [candidates],
  )
  const requestKey = useMemo(
    () => JSON.stringify([workspaceId, filePaths]),
    [filePaths, workspaceId],
  )
  const [fileResolution, setFileResolution] = useState<FileResolution>({
    key: requestKey,
    validPaths: new Set(),
  })
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    if (!workspaceId || filePaths.length === 0) {
      setFileResolution({ key: requestKey, validPaths: new Set() })
      return
    }

    const now = Date.now()
    const cachedValid = new Set<string>()
    let needsValidation = false
    for (const filePath of filePaths) {
      const cached = validationCache.get(cacheKey(workspaceId, filePath))
      if (!cached || cached.expiresAt <= now) {
        needsValidation = true
      } else if (cached.valid) {
        cachedValid.add(filePath)
      }
    }
    setFileResolution({ key: requestKey, validPaths: cachedValid })
    if (!needsValidation) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/workspaces/${workspaceId}/files/resolve`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paths: filePaths }),
              signal: controller.signal,
            },
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as { paths?: unknown }
          if (!Array.isArray(data.paths)) throw new Error('Invalid response')
          if (controller.signal.aborted) return

          const validPaths = new Set(
            data.paths.filter((path): path is string => typeof path === 'string'),
          )
          const expiresAt = Date.now() + CACHE_TTL_MS
          for (const filePath of filePaths) {
            validationCache.set(cacheKey(workspaceId, filePath), {
              valid: validPaths.has(filePath),
              expiresAt,
            })
          }
          setFileResolution({ key: requestKey, validPaths })
        } catch (error) {
          if (controller.signal.aborted) return
          setFileResolution({ key: requestKey, validPaths: new Set() })
        }
      })()
    }, VALIDATION_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [filePaths, refreshVersion, requestKey, workspaceId])

  const commandNames = useMemo(
    () => new Set(commands.map((command) => command.name)),
    [commands],
  )
  const validFilePaths =
    fileResolution.key === requestKey ? fileResolution.validPaths : new Set<string>()
  const references = useMemo(
    () => candidates.filter((candidate) =>
      candidate.kind === 'skill'
        ? commandNames.has(candidate.value)
        : validFilePaths.has(candidate.value),
    ),
    [candidates, commandNames, validFilePaths],
  )

  const refresh = useCallback(() => {
    for (const filePath of filePaths) {
      validationCache.delete(cacheKey(workspaceId, filePath))
    }
    setFileResolution({ key: requestKey, validPaths: new Set() })
    setRefreshVersion((version) => version + 1)
  }, [filePaths, requestKey, workspaceId])

  return { references, refresh }
}
