import { create } from 'zustand'
import i18next from 'i18next'

/**
 * Skills store — client-side state for the Skills page.
 *
 * Mirrors the shape and conventions of `plugin-store.ts`:
 *   - isLoading / isSaving flags guard UI affordances
 *   - All fetch errors surface as localized strings via i18next.t with fallbacks
 *   - updatePlugin carries a parallel per-row error channel
 *     (`updatingPluginId` / `updateError` / `failedUpdatePluginId`)
 *   - Optimistic update for the remove path, with revert-on-failure
 *
 * Differences from plugin-store (intentional):
 *   - `install` returns `InstallResult[]` because partial-success is possible
 *     when installing multiple skills at once (Coherence #3)
 *   - `install` carries a `force` flag for the Reinstall flow (Coherence #2)
 *   - `search` federates live registry queries via `/api/skills/search`; the
 *     server keeps no persistent marketplace index, and the caller debounces
 *     requests client-side
 *   - There is no enable/disable flow (skills are always-on once installed)
 *   - There is no per-plugin updates-check endpoint — `update` re-fetches the
 *     source and overwrites local files in one step
 */

export type SkillScope = 'project' | 'global'
export type SkillScene =
  | 'ai-agent'
  | 'office-efficiency'
  | 'development'
  | 'content-creation'
  | 'knowledge-management'
  | 'professional'
  | 'design-media'
export type SkillSort = 'score' | 'downloads' | 'newest'

export interface SkillSearchFilters {
  scene?: SkillScene
  preferChinese?: boolean
  noApiKey?: boolean
  sort?: SkillSort
}

/** Mirrors InstalledSkill from src/server/services/skills-service.ts */
export interface InstalledSkill {
  name: string
  kind?: 'skill' | 'expert-package-orchestrator'
  description?: string
  scope: SkillScope
  source: string
  /** Expert Package that installed this Skill, if it belongs to one. */
  packageSlug?: string
  /** Catalog summary cached at Expert Package installation time for offline display. */
  packageCatalog?: {
    slug: string
    displayName: string
    displayNameEn?: string
    summary: string
    summaryEn?: string
    scene: string
    subScene?: string
    skillCount: number
    source: 'skillhub.cn'
  }
  installPath: string
  isLegacySymlink: boolean
  computedHash?: string
  updatedAt?: string
  installedAt?: string
}

/** Mirrors SearchSkill from src/server/services/skills/types.ts */
export interface SearchSkill {
  id: string
  name: string
  slug: string
  source: string
  installSource: string
  sourceKind: 'skills.sh' | 'skillshub' | 'xfyun' | 'skillhub-cn' | 'weskillhub'
  description: string
  installs: number
  updatedAt?: number
}

export type SkillSearchProviderId = SearchSkill['sourceKind']
export type SkillProviderFailureReason = 'network' | 'timeout' | 'http' | 'invalid-response'

export interface SkillSearchProvider {
  id: SkillSearchProviderId
  label: string
  status: 'available' | 'unavailable'
  reason?: SkillProviderFailureReason
}

export type SearchProviderBlockReason = 'checking' | 'no-available' | null

/** Mirrors DiscoveredSkill from src/server/services/skills/types.ts */
export interface DiscoveredSkill {
  name: string
  description: string
  skillPath: string
}

/** Mirrors InstallResult from src/server/services/skills/types.ts */
export interface InstallResult {
  skillName: string
  kind?: 'skill' | 'expert-package-orchestrator'
  status: 'installed' | 'overwritten' | 'already-installed' | 'error'
  path?: string
  error?: string
}

/**
 * Discriminated return for install. The caller (SkillInstallModal) branches on
 * `status` to drive the phase machine — `success` advances to the result
 * phase, `already-installed` shows the Reinstall affordance, `error` shows
 * the Retry affordance. Partial-success (some installed, some failed) is
 * `success` with the results array carrying the per-skill detail.
 */
export type InstallOutcome =
  | { status: 'success'; results: InstallResult[] }
  | { status: 'already-installed'; results: InstallResult[]; message: string }
  | { status: 'error'; message: string; results?: InstallResult[] }

interface SkillsState {
  installed: InstalledSkill[]
  searchResults: SearchSkill[]
  /** Discovered skills when the user picks a source to install from */
  discovered: DiscoveredSkill[]
  isFetchingInstalled: boolean
  isSearching: boolean
  isResolving: boolean
  isSaving: boolean
  /** Top-level error banner (full-page or full-tab) */
  error: string | null
  /** Per-skill row error from the most recent update attempt */
  updateError: string | null
  /** Skill name whose update just failed, so the error can render inline */
  failedUpdateSkillName: string | null
  /** Skill name currently being updated (spinner per row) */
  updatingSkillName: string | null
  /** Skill name that just updated successfully (transient highlight) */
  recentlyUpdatedSkillName: string | null
  searchProviders: SkillSearchProvider[]
  selectedSearchProviderIds: SkillSearchProviderId[]
  knownSearchProviderIds: SkillSearchProviderId[]
  newSearchProviderIds: SkillSearchProviderId[]
  checkingSearchProviderIds: SkillSearchProviderId[]
  isCheckingSearchProviders: boolean
  isSearchProviderPreferenceInitialized: boolean
  searchProviderBlockReason: SearchProviderBlockReason
  /** Providers omitted from the latest accepted result set. */
  lastSearchIncompleteProviderIds: SkillSearchProviderId[]

  fetchInstalled: (workspaceId?: string) => Promise<void>
  search: (query: string, filters?: SkillSearchFilters) => Promise<void>
  checkSearchProviders: () => Promise<void>
  retrySearchProvider: (providerId: SkillSearchProviderId) => Promise<void>
  setSearchProviderSelected: (providerId: SkillSearchProviderId, selected: boolean) => void
  selectAllSearchProviders: () => void
  resolveSource: (source: string, workspaceId?: string) => Promise<boolean>
  install: (args: {
    source: string
    skills: string[]
    scope: SkillScope
    workspaceId?: string
    force?: boolean
  }) => Promise<InstallOutcome>
  uninstall: (args: {
    skillName: string
    scope: SkillScope
    workspaceId?: string
  }) => Promise<boolean>
  update: (args: {
    skillName: string
    scope: SkillScope
    workspaceId?: string
  }) => Promise<boolean>
  updateAll: (workspaceId?: string) => Promise<void>
  clearDiscovered: () => void
  clearError: () => void
  clearUpdateError: () => void
  clearRecentlyUpdated: () => void
}

const API_BASE = '/api/skills'
let activeSearchController: AbortController | null = null
let activeSearchId = 0
let activeResolveController: AbortController | null = null
let activeResolveId = 0
let activeProviderCheckId = 0
let providerRequestGeneration = 0
const providerGenerations = new Map<SkillSearchProviderId, number>()

const PROVIDER_PREFERENCE_KEY = 'comate.skills.search-providers.v1'

interface PersistedProviderPreference {
  version: 1
  selectedProviderIds: SkillSearchProviderId[]
  knownProviderIds: SkillSearchProviderId[]
}

function readProviderPreference(): PersistedProviderPreference | null {
  try {
    const value = JSON.parse(localStorage.getItem(PROVIDER_PREFERENCE_KEY) || 'null') as unknown
    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    if (
      candidate.version !== 1
      || !Array.isArray(candidate.selectedProviderIds)
      || !candidate.selectedProviderIds.every((id) => typeof id === 'string')
      || !Array.isArray(candidate.knownProviderIds)
      || !candidate.knownProviderIds.every((id) => typeof id === 'string')
    ) return null
    return candidate as unknown as PersistedProviderPreference
  } catch {
    return null
  }
}

function persistProviderPreference(
  selectedProviderIds: SkillSearchProviderId[],
  knownProviderIds: SkillSearchProviderId[]
): void {
  try {
    localStorage.setItem(PROVIDER_PREFERENCE_KEY, JSON.stringify({
      version: 1,
      selectedProviderIds,
      knownProviderIds,
    }))
  } catch {
    // Storage can be unavailable (for example, in privacy-restricted contexts).
  }
}

function beginProviderRequest(providerIds: SkillSearchProviderId[]): number {
  const generation = ++providerRequestGeneration
  for (const providerId of providerIds) providerGenerations.set(providerId, generation)
  return generation
}

function isCurrentProviderRequest(providerId: SkillSearchProviderId, generation: number): boolean {
  return providerGenerations.get(providerId) === generation
}

function uniqueProviderIds(providerIds: SkillSearchProviderId[]): SkillSearchProviderId[] {
  return [...new Set(providerIds)]
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  installed: [],
  searchResults: [],
  discovered: [],
  isFetchingInstalled: false,
  isSearching: false,
  isResolving: false,
  isSaving: false,
  error: null,
  updateError: null,
  failedUpdateSkillName: null,
  updatingSkillName: null,
  recentlyUpdatedSkillName: null,
  searchProviders: [],
  selectedSearchProviderIds: [],
  knownSearchProviderIds: [],
  newSearchProviderIds: [],
  checkingSearchProviderIds: [],
  isCheckingSearchProviders: false,
  isSearchProviderPreferenceInitialized: false,
  searchProviderBlockReason: 'checking',
  lastSearchIncompleteProviderIds: [],

  fetchInstalled: async (workspaceId) => {
    set({ isFetchingInstalled: true, error: null })
    try {
      const url = workspaceId
        ? `${API_BASE}/installed?workspaceId=${encodeURIComponent(workspaceId)}`
        : `${API_BASE}/installed`
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(
          i18next.t('settings:skills.fetchInstalledFailed', 'Failed to fetch installed skills')
        )
      }
      const data = await res.json()
      set({ installed: data.skills || [], isFetchingInstalled: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isFetchingInstalled: false,
      })
    }
  },

  search: async (query, filters = {}) => {
    if (!query.trim()) {
      activeSearchId += 1
      activeSearchController?.abort()
      activeSearchController = null
      set({
        searchResults: [],
        isSearching: false,
        error: null,
        searchProviderBlockReason: null,
        lastSearchIncompleteProviderIds: [],
      })
      return
    }

    const providerState = get()
    if (!providerState.isSearchProviderPreferenceInitialized) {
      set({ isSearching: false, searchProviderBlockReason: 'checking' })
      return
    }
    const selectedProviders = providerState.searchProviders.filter(({ id }) =>
      providerState.selectedSearchProviderIds.includes(id)
    )
    const availableProviderIds = selectedProviders
      .filter(({ status }) => status === 'available')
      .map(({ id }) => id)
    const unavailableProviderIds = selectedProviders
      .filter(({ status }) => status === 'unavailable')
      .map(({ id }) => id)
    if (availableProviderIds.length === 0) {
      set({
        searchResults: [],
        isSearching: false,
        error: null,
        searchProviderBlockReason: 'no-available',
        lastSearchIncompleteProviderIds: unavailableProviderIds,
      })
      return
    }

    const requestId = ++activeSearchId
    const providerGeneration = beginProviderRequest(availableProviderIds)
    activeSearchController?.abort()
    const controller = new AbortController()
    activeSearchController = controller
    set({ isSearching: true, error: null, searchProviderBlockReason: null })
    try {
      const params = new URLSearchParams({ q: query, sort: filters.sort || 'score' })
      if (filters.scene) params.set('scene', filters.scene)
      if (filters.preferChinese) params.set('preferChinese', 'true')
      if (filters.noApiKey) params.set('noApiKey', 'true')
      params.set('providers', availableProviderIds.join(','))
      const url = `${API_BASE}/search?${params.toString()}`
      const res = await fetch(url, { signal: controller.signal })
      if (requestId !== activeSearchId) return
      if (!res.ok) {
        throw new Error(i18next.t('settings:skills.searchFailed', 'Skill search failed'))
      }
      const data = await res.json()
      if (requestId !== activeSearchId) return
      const outcomes = Array.isArray(data.providers) ? data.providers as SkillSearchProvider[] : []
      const outcomeById = new Map(outcomes.map((provider) => [provider.id, provider]))
      set((state) => ({
        searchResults: data.skills || [],
        isSearching: false,
        searchProviders: state.searchProviders.map((provider) => {
          const outcome = outcomeById.get(provider.id)
          return outcome && isCurrentProviderRequest(provider.id, providerGeneration)
            ? outcome
            : provider
        }),
        lastSearchIncompleteProviderIds: uniqueProviderIds([
          ...unavailableProviderIds,
          ...outcomes
            .filter(({ status }) => status === 'unavailable')
            .map(({ id }) => id),
        ]),
      }))
    } catch (err) {
      if (requestId !== activeSearchId || controller.signal.aborted) return
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isSearching: false,
      })
    } finally {
      if (requestId === activeSearchId) activeSearchController = null
    }
  },

  checkSearchProviders: async () => {
    const checkId = ++activeProviderCheckId
    const requestedProviderIds = get().searchProviders.map(({ id }) => id)
    const generation = beginProviderRequest(requestedProviderIds)
    set({
      isCheckingSearchProviders: true,
      checkingSearchProviderIds: requestedProviderIds,
      searchProviderBlockReason: get().isSearchProviderPreferenceInitialized ? null : 'checking',
    })
    try {
      const res = await fetch(`${API_BASE}/search/providers`)
      if (!res.ok) throw new Error('provider health check failed')
      const data = await res.json()
      const providers = Array.isArray(data.providers) ? data.providers as SkillSearchProvider[] : []
      set((state) => {
        const previousById = new Map(state.searchProviders.map((provider) => [provider.id, provider]))
        const mergedProviders = providers.map((provider) => {
          if (!requestedProviderIds.includes(provider.id) || isCurrentProviderRequest(provider.id, generation)) {
            return provider
          }
          return previousById.get(provider.id) || provider
        })

        let selectedProviderIds = state.selectedSearchProviderIds
        let knownProviderIds = state.knownSearchProviderIds
        let newSearchProviderIds = state.newSearchProviderIds
        if (!state.isSearchProviderPreferenceInitialized) {
          const persisted = readProviderPreference()
          const liveIds = providers.map(({ id }) => id)
          if (persisted) {
            const addedIds = liveIds.filter((id) => !persisted.knownProviderIds.includes(id))
            selectedProviderIds = uniqueProviderIds([
              ...persisted.selectedProviderIds.filter((id) => liveIds.includes(id)),
              ...addedIds,
            ])
            newSearchProviderIds = addedIds
          } else {
            selectedProviderIds = liveIds
            newSearchProviderIds = []
          }
          knownProviderIds = liveIds
        } else {
          const liveIds = providers.map(({ id }) => id)
          const addedIds = liveIds.filter((id) => !state.knownSearchProviderIds.includes(id))
          selectedProviderIds = uniqueProviderIds([...selectedProviderIds, ...addedIds])
          knownProviderIds = uniqueProviderIds([...knownProviderIds, ...liveIds])
          newSearchProviderIds = uniqueProviderIds([...newSearchProviderIds, ...addedIds])
        }
        persistProviderPreference(selectedProviderIds, knownProviderIds)

        return {
          searchProviders: mergedProviders,
          selectedSearchProviderIds: selectedProviderIds,
          knownSearchProviderIds: knownProviderIds,
          newSearchProviderIds,
          isSearchProviderPreferenceInitialized: true,
          searchProviderBlockReason: null,
        }
      })
    } catch {
      set((state) => ({
        searchProviders: state.searchProviders.map((provider) =>
          isCurrentProviderRequest(provider.id, generation)
            ? { ...provider, status: 'unavailable' as const, reason: 'network' as const }
            : provider
        ),
      }))
    } finally {
      if (checkId === activeProviderCheckId) {
        set({ isCheckingSearchProviders: false, checkingSearchProviderIds: [] })
      }
    }
  },

  retrySearchProvider: async (providerId) => {
    const generation = beginProviderRequest([providerId])
    set((state) => ({
      checkingSearchProviderIds: uniqueProviderIds([...state.checkingSearchProviderIds, providerId]),
    }))
    try {
      const params = new URLSearchParams({ provider: providerId })
      const res = await fetch(`${API_BASE}/search/providers?${params.toString()}`)
      if (!res.ok) throw new Error('provider health check failed')
      const data = await res.json()
      const outcome = Array.isArray(data.providers)
        ? data.providers.find((provider: SkillSearchProvider) => provider.id === providerId)
        : undefined
      if (!outcome || !isCurrentProviderRequest(providerId, generation)) return
      set((state) => ({
        searchProviders: state.searchProviders.map((provider) =>
          provider.id === providerId ? outcome : provider
        ),
      }))
    } catch {
      if (!isCurrentProviderRequest(providerId, generation)) return
      set((state) => ({
        searchProviders: state.searchProviders.map((provider) =>
          provider.id === providerId
            ? { ...provider, status: 'unavailable' as const, reason: 'network' as const }
            : provider
        ),
      }))
    } finally {
      if (isCurrentProviderRequest(providerId, generation)) {
        set((state) => ({
          checkingSearchProviderIds: state.checkingSearchProviderIds.filter((id) => id !== providerId),
        }))
      }
    }
  },

  setSearchProviderSelected: (providerId, selected) => {
    set((state) => {
      const selectedProviderIds = selected
        ? uniqueProviderIds([...state.selectedSearchProviderIds, providerId])
        : state.selectedSearchProviderIds.filter((id) => id !== providerId)
      persistProviderPreference(selectedProviderIds, state.knownSearchProviderIds)
      return { selectedSearchProviderIds: selectedProviderIds }
    })
  },

  selectAllSearchProviders: () => {
    set((state) => {
      const selectedProviderIds = state.searchProviders.map(({ id }) => id)
      persistProviderPreference(selectedProviderIds, state.knownSearchProviderIds)
      return { selectedSearchProviderIds: selectedProviderIds }
    })
  },

  resolveSource: async (source, workspaceId) => {
    const requestId = ++activeResolveId
    activeResolveController?.abort()
    const controller = new AbortController()
    activeResolveController = controller
    set({ isResolving: true, error: null, discovered: [] })
    try {
      const body: Record<string, unknown> = { source }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (requestId !== activeResolveId) return false
      const data = await res.json()
      if (requestId !== activeResolveId) return false
      if (!res.ok) {
        set({
          error: data.error || i18next.t('settings:skills.resolveFailed', 'Failed to resolve source'),
          isResolving: false,
        })
        return false
      }
      set({ discovered: data.skills || [], isResolving: false })
      return true
    } catch (err) {
      if (requestId !== activeResolveId || controller.signal.aborted) return false
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isResolving: false,
      })
      return false
    } finally {
      if (requestId === activeResolveId) activeResolveController = null
    }
  },

  install: async ({ source, skills, scope, workspaceId, force }) => {
    set({ isSaving: true, error: null })
    try {
      const body: Record<string, unknown> = { source, skills, scope }
      if (workspaceId) body.workspaceId = workspaceId
      if (force) body.force = true
      const res = await fetch(`${API_BASE}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.status === 409) {
        // Every requested skill was already installed — let the caller show the
        // Reinstall affordance (R8).
        set({ isSaving: false })
        return {
          status: 'already-installed',
          results: data.results || [],
          message: data.error || i18next.t('settings:skills.alreadyInstalled', 'Skill is already installed'),
        }
      }
      if (!res.ok) {
        // 400 (validation) or 422 (all-failed) or 500 — surface message.
        set({
          error: data.error || i18next.t('settings:skills.installFailed', 'Failed to install skill'),
          isSaving: false,
        })
        return {
          status: 'error',
          message: data.error || i18next.t('settings:skills.installFailed', 'Failed to install skill'),
          results: data.results,
        }
      }
      // 201 success — refresh installed list so the UI reflects the new state.
      set({ isSaving: false })
      // Lazy refresh: callers (SkillInstallModal) invoke fetchInstalled on
      // their own after onInstalled fires, to avoid racing with the modal close.
      return { status: 'success', results: data.results || [] }
    } catch (err) {
      const message = err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error')
      set({ error: message, isSaving: false })
      return { status: 'error', message }
    }
  },

  uninstall: async ({ skillName, scope, workspaceId }) => {
    set({ isSaving: true, error: null })
    // Optimistic update — remove from installed immediately so the UI feels
    // responsive. We snapshot the previous list to revert on failure.
    const previousInstalled = useSkillsStore.getState().installed
    set((state) => ({
      installed: state.installed.filter(
        (s) => !(s.name === skillName && s.scope === scope)
      ),
    }))
    try {
      const body: Record<string, unknown> = { skillName, scope }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        // Revert optimistic update.
        set({
          installed: previousInstalled,
          error: data.error || i18next.t('settings:skills.uninstallFailed', 'Failed to uninstall skill'),
          isSaving: false,
        })
        return false
      }
      set({ isSaving: false })
      return true
    } catch (err) {
      // Revert optimistic update.
      set({
        installed: previousInstalled,
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isSaving: false,
      })
      return false
    }
  },

  update: async ({ skillName, scope, workspaceId }) => {
    set({
      updatingSkillName: skillName,
      updateError: null,
      failedUpdateSkillName: null,
      recentlyUpdatedSkillName: null,
      error: null,
    })
    try {
      const body: Record<string, unknown> = { skillName, scope }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        set({
          updatingSkillName: null,
          updateError: data.error || i18next.t('settings:skills.updateFailed', 'Failed to update skill'),
          failedUpdateSkillName: skillName,
        })
        return false
      }
      set({
        updatingSkillName: null,
        recentlyUpdatedSkillName: skillName,
      })
      // Refresh the installed list so the UI reflects the updated hash/timestamp.
      try {
        await useSkillsStore.getState().fetchInstalled(workspaceId)
      } catch {
        // Non-fatal — the per-row success indicator still renders.
      }
      return true
    } catch (err) {
      set({
        updatingSkillName: null,
        updateError: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        failedUpdateSkillName: skillName,
      })
      return false
    }
  },

  updateAll: async (workspaceId) => {
    set({ isSaving: true, error: null })
    try {
      const body: Record<string, unknown> = {}
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/update-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        set({
          error: data.error || i18next.t('settings:skills.updateAllFailed', 'Failed to update all skills'),
          isSaving: false,
        })
        return
      }
      set({ isSaving: false })
      // Refresh to pick up updated hashes/timestamps.
      try {
        await useSkillsStore.getState().fetchInstalled(workspaceId)
      } catch {
        // Non-fatal.
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isSaving: false,
      })
    }
  },

  clearDiscovered: () => {
    activeResolveId += 1
    activeResolveController?.abort()
    activeResolveController = null
    set({ discovered: [], isResolving: false })
  },
  clearError: () => set({ error: null }),
  clearUpdateError: () => set({ updateError: null, failedUpdateSkillName: null }),
  clearRecentlyUpdated: () => set({ recentlyUpdatedSkillName: null }),
}))
