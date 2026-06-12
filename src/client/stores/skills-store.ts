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
 *   - `search` runs against skills.sh via `/api/skills/search` (not a local
 *     marketplace), and is debounced client-side by the caller
 *   - There is no enable/disable flow (skills are always-on once installed)
 *   - There is no per-plugin updates-check endpoint — `update` re-fetches the
 *     source and overwrites local files in one step
 */

export type SkillScope = 'project' | 'global'

/** Mirrors InstalledSkill from src/server/services/skills-service.ts */
export interface InstalledSkill {
  name: string
  scope: SkillScope
  source: string
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
  source: string
  installs: number
}

/** Mirrors DiscoveredSkill from src/server/services/skills/types.ts */
export interface DiscoveredSkill {
  name: string
  description: string
  skillPath: string
}

/** Mirrors InstallResult from src/server/services/skills/types.ts */
export interface InstallResult {
  skillName: string
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

  fetchInstalled: (workspaceId?: string) => Promise<void>
  search: (query: string) => Promise<void>
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

export const useSkillsStore = create<SkillsState>((set) => ({
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

  search: async (query) => {
    set({ isSearching: true, error: null })
    try {
      const url = `${API_BASE}/search?q=${encodeURIComponent(query)}`
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(i18next.t('settings:skills.searchFailed', 'Skill search failed'))
      }
      const data = await res.json()
      set({ searchResults: data.skills || [], isSearching: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isSearching: false,
      })
    }
  },

  resolveSource: async (source, workspaceId) => {
    set({ isResolving: true, error: null, discovered: [] })
    try {
      const body: Record<string, unknown> = { source }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
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
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isResolving: false,
      })
      return false
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

  clearDiscovered: () => set({ discovered: [] }),
  clearError: () => set({ error: null }),
  clearUpdateError: () => set({ updateError: null, failedUpdateSkillName: null }),
  clearRecentlyUpdated: () => set({ recentlyUpdatedSkillName: null }),
}))
