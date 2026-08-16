import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  scanPromptReferences,
  type PromptReference,
  type PromptReferenceValidationStatus,
  type ValidatedPromptReference,
} from '../lib/prompt-references'

interface CommandName {
  name: string
}

interface UsePromptReferenceValidationOptions {
  workspaceId: string
  input: string
  commands: CommandName[]
  commandsLoading?: boolean
  commandsError?: string
}

export interface PromptReferenceRefreshResult {
  candidates: ValidatedPromptReference[]
  succeeded: boolean
}

interface UsePromptReferenceValidationResult {
  candidates: ValidatedPromptReference[]
  references: PromptReference[]
  refresh: () => Promise<PromptReferenceRefreshResult>
}

interface CacheEntry {
  valid: boolean
  expiresAt: number
}

interface FileResolution {
  key: string
  statuses: Map<string, Exclude<PromptReferenceValidationStatus, 'pending'>>
}

const VALIDATION_DEBOUNCE_MS = 150
const CACHE_TTL_MS = 5000
const validationCache = new Map<string, CacheEntry>()

function cacheKey(workspaceId: string, path: string): string {
  return `${workspaceId}\0${path}`
}

function confirmedCachedStatus(
  workspaceId: string,
  path: string,
): Exclude<PromptReferenceValidationStatus, 'pending'> | undefined {
  const cached = validationCache.get(cacheKey(workspaceId, path))
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.valid ? 'valid' : 'invalid'
}

async function resolveFilePaths(
  workspaceId: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, 'valid' | 'invalid'>> {
  const res = await fetch(`/api/workspaces/${workspaceId}/files/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { paths?: unknown }
  if (!Array.isArray(data.paths)) throw new Error('Invalid response')

  const validPaths = new Set(
    data.paths.filter((path): path is string => typeof path === 'string'),
  )
  const statuses = new Map<string, 'valid' | 'invalid'>()
  const expiresAt = Date.now() + CACHE_TTL_MS
  for (const path of paths) {
    const status = validPaths.has(path) ? 'valid' : 'invalid'
    statuses.set(path, status)
    validationCache.set(cacheKey(workspaceId, path), {
      valid: status === 'valid',
      expiresAt,
    })
  }
  return statuses
}

function validReferences(
  candidates: ValidatedPromptReference[],
): PromptReference[] {
  return candidates.flatMap(({ status, ...reference }) =>
    status === 'valid' ? [reference] : [],
  )
}

export function usePromptReferenceValidation({
  workspaceId,
  input,
  commands,
  commandsLoading = false,
  commandsError,
}: UsePromptReferenceValidationOptions): UsePromptReferenceValidationResult {
  const scannedCandidates = useMemo(() => scanPromptReferences(input), [input])
  const filePaths = useMemo(
    () => [
      ...new Set(
        scannedCandidates
          .filter((candidate) => candidate.kind === 'file')
          .map((candidate) => candidate.value),
      ),
    ].sort(),
    [scannedCandidates],
  )
  const requestKey = useMemo(
    () => JSON.stringify([workspaceId, filePaths]),
    [filePaths, workspaceId],
  )
  const [fileResolution, setFileResolution] = useState<FileResolution>({
    key: requestKey,
    statuses: new Map(),
  })
  const requestGenerationRef = useRef(0)
  const confirmedSkillsRef = useRef(new Map<string, 'valid' | 'invalid'>())
  const skillsWorkspaceRef = useRef(workspaceId)

  if (skillsWorkspaceRef.current !== workspaceId) {
    skillsWorkspaceRef.current = workspaceId
    confirmedSkillsRef.current = new Map()
  }

  useEffect(() => {
    const cachedStatuses = new Map<string, 'valid' | 'invalid'>()
    const unresolved: string[] = []
    for (const path of filePaths) {
      const cached = confirmedCachedStatus(workspaceId, path)
      if (cached) cachedStatuses.set(path, cached)
      else unresolved.push(path)
    }

    setFileResolution((current) => {
      const statuses = new Map(cachedStatuses)
      if (current.key === requestKey) {
        for (const [path, status] of current.statuses) {
          if (filePaths.includes(path) && !statuses.has(path)) {
            statuses.set(path, status)
          }
        }
      }
      return { key: requestKey, statuses }
    })

    if (!workspaceId || unresolved.length === 0) return

    const controller = new AbortController()
    const generation = ++requestGenerationRef.current
    const timer = setTimeout(() => {
      void resolveFilePaths(workspaceId, unresolved, controller.signal)
        .then((resolved) => {
          if (
            controller.signal.aborted ||
            generation !== requestGenerationRef.current
          ) {
            return
          }
          setFileResolution((current) => {
            if (current.key !== requestKey) return current
            const statuses = new Map(current.statuses)
            for (const [path, status] of resolved) statuses.set(path, status)
            return { key: requestKey, statuses }
          })
        })
        .catch(() => {
          // Preserve confirmed values; unresolved paths remain pending.
        })
    }, VALIDATION_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [filePaths, requestKey, workspaceId])

  const commandNames = useMemo(
    () => new Set(commands.map((command) => command.name)),
    [commands],
  )

  const statusForSkill = useCallback(
    (name: string): PromptReferenceValidationStatus => {
      if (!commandsLoading && !commandsError) {
        const status = commandNames.has(name) ? 'valid' : 'invalid'
        confirmedSkillsRef.current.set(name, status)
        return status
      }
      return confirmedSkillsRef.current.get(name) ?? 'pending'
    },
    [commandNames, commandsError, commandsLoading],
  )

  const fileStatuses = useMemo(() => {
    if (fileResolution.key === requestKey) return fileResolution.statuses
    const statuses = new Map<string, 'valid' | 'invalid'>()
    for (const path of filePaths) {
      const cached = confirmedCachedStatus(workspaceId, path)
      if (cached) statuses.set(path, cached)
    }
    return statuses
  }, [filePaths, fileResolution, requestKey, workspaceId])

  const candidates = useMemo<ValidatedPromptReference[]>(
    () =>
      scannedCandidates.map((candidate) => ({
        ...candidate,
        status:
          candidate.kind === 'skill'
            ? statusForSkill(candidate.value)
            : (fileStatuses.get(candidate.value) ?? 'pending'),
      })),
    [fileStatuses, scannedCandidates, statusForSkill],
  )

  const refresh = useCallback(async (): Promise<PromptReferenceRefreshResult> => {
    if (!workspaceId || filePaths.length === 0) {
      return { candidates, succeeded: true }
    }

    const generation = ++requestGenerationRef.current
    for (const path of filePaths) {
      validationCache.delete(cacheKey(workspaceId, path))
    }

    try {
      const statuses = await resolveFilePaths(workspaceId, filePaths)
      if (generation !== requestGenerationRef.current) {
        return { candidates, succeeded: false }
      }
      setFileResolution({ key: requestKey, statuses })
      return {
        succeeded: true,
        candidates: scannedCandidates.map((candidate) => ({
          ...candidate,
          status:
            candidate.kind === 'skill'
              ? statusForSkill(candidate.value)
              : (statuses.get(candidate.value) ?? 'invalid'),
        })),
      }
    } catch {
      return { candidates, succeeded: false }
    }
  }, [
    candidates,
    filePaths,
    requestKey,
    scannedCandidates,
    statusForSkill,
    workspaceId,
  ])

  return {
    candidates,
    references: validReferences(candidates),
    refresh,
  }
}
