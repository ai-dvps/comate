import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  scanPromptReferences,
  type PromptReference,
  type PromptReferenceValidationStatus,
  type ValidatedPromptReference,
} from '../lib/prompt-references'
import {
  readTtlCache,
  resolveExistingWorkspacePaths,
  workspacePathKey,
  writeTtlCache,
  type TtlCacheEntry,
} from '../lib/workspace-file-resolution'

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

interface PromptReferenceRefreshResult {
  candidates: ValidatedPromptReference[]
}

interface UsePromptReferenceValidationResult {
  candidates: ValidatedPromptReference[]
  references: PromptReference[]
  refresh: (commandsOverride?: CommandName[]) => Promise<PromptReferenceRefreshResult>
}

const VALIDATION_DEBOUNCE_MS = 150
const CACHE_TTL_MS = 5000

interface FileResolution {
  key: string
  statuses: Map<string, Exclude<PromptReferenceValidationStatus, 'pending'>>
}

const validationCache = new Map<string, TtlCacheEntry<boolean>>()

function confirmedCachedStatus(
  workspaceId: string,
  path: string,
): Exclude<PromptReferenceValidationStatus, 'pending'> | undefined {
  const valid = readTtlCache(validationCache, workspacePathKey(workspaceId, path))
  if (valid === undefined) return undefined
  return valid ? 'valid' : 'invalid'
}

async function resolveFilePaths(
  workspaceId: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, 'valid' | 'invalid'>> {
  const validPaths = await resolveExistingWorkspacePaths(workspaceId, paths, signal)
  const statuses = new Map<string, 'valid' | 'invalid'>()
  for (const path of paths) {
    const status = validPaths.has(path) ? 'valid' : 'invalid'
    statuses.set(path, status)
  }
  return statuses
}

function cacheFileStatuses(
  workspaceId: string,
  statuses: Map<string, 'valid' | 'invalid'>,
): void {
  writeTtlCache(
    validationCache,
    [...statuses].map(([path, status]) => [
      workspacePathKey(workspaceId, path),
      status === 'valid',
    ]),
    CACHE_TTL_MS,
  )
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
    const requestedPaths = new Set(filePaths)
    for (const path of filePaths) {
      const cached = confirmedCachedStatus(workspaceId, path)
      if (cached) cachedStatuses.set(path, cached)
      else unresolved.push(path)
    }

    setFileResolution((current) => {
      const statuses = new Map(cachedStatuses)
      if (current.key === requestKey) {
        for (const [path, status] of current.statuses) {
          if (requestedPaths.has(path) && !statuses.has(path)) {
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
          cacheFileStatuses(workspaceId, resolved)
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

  const refresh = useCallback(async (
    commandsOverride?: CommandName[],
  ): Promise<PromptReferenceRefreshResult> => {
    const refreshedCommandNames = commandsOverride
      ? new Set(commandsOverride.map((command) => command.name))
      : null
    const refreshedSkillStatus = (name: string) => {
      if (!refreshedCommandNames) return statusForSkill(name)
      const status = refreshedCommandNames.has(name) ? 'valid' : 'invalid'
      confirmedSkillsRef.current.set(name, status)
      return status
    }
    if (!workspaceId || filePaths.length === 0) {
      return {
        candidates: scannedCandidates.map((candidate) => ({
          ...candidate,
          status:
            candidate.kind === 'skill'
              ? refreshedSkillStatus(candidate.value)
              : (fileStatuses.get(candidate.value) ?? 'pending'),
        })),
      }
    }

    const generation = ++requestGenerationRef.current
    for (const path of filePaths) {
      validationCache.delete(workspacePathKey(workspaceId, path))
    }

    try {
      const statuses = await resolveFilePaths(workspaceId, filePaths)
      if (generation !== requestGenerationRef.current) {
        return { candidates }
      }
      cacheFileStatuses(workspaceId, statuses)
      setFileResolution({ key: requestKey, statuses })
      return {
        candidates: scannedCandidates.map((candidate) => ({
          ...candidate,
          status:
            candidate.kind === 'skill'
              ? refreshedSkillStatus(candidate.value)
              : (statuses.get(candidate.value) ?? 'invalid'),
        })),
      }
    } catch {
      return { candidates }
    }
  }, [
    candidates,
    filePaths,
    fileStatuses,
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
