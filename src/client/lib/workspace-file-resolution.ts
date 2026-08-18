/**
 * Shared primitives for the workspace files-resolve endpoint and the keyed TTL
 * caches its consumers keep. Each consumer holds its own cache Map so one
 * feature's entries never warm another feature's.
 */

const RESOLVE_TIMEOUT_MS = 10_000

export function workspacePathKey(
  workspaceId: string,
  relativePath: string,
): string {
  return `${workspaceId}\0${relativePath}`
}

export interface TtlCacheEntry<T> {
  value: T
  expiresAt: number
}

export function readTtlCache<T>(
  cache: Map<string, TtlCacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

export function writeTtlCache<T>(
  cache: Map<string, TtlCacheEntry<T>>,
  entries: Iterable<[string, T]>,
  ttlMs: number,
): void {
  const expiresAt = Date.now() + ttlMs
  for (const [key, value] of entries) {
    cache.set(key, { value, expiresAt })
  }
  // Sweep expired entries on write so the map stays bounded in a long-lived app.
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
}

/**
 * POST /api/workspaces/:id/files/resolve — returns the subset of the given
 * workspace-relative paths that exist as files. A caller-supplied signal is
 * composed with a 10s timeout so a hung request still fails (and lands in the
 * caller's catch) instead of pending forever.
 */
export async function resolveExistingWorkspacePaths(
  workspaceId: string,
  relativePaths: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
  const res = await fetch(`/api/workspaces/${workspaceId}/files/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: relativePaths }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { paths?: unknown }
  if (!Array.isArray(data.paths)) throw new Error('Invalid response')
  return new Set(data.paths.filter((p): p is string => typeof p === 'string'))
}
