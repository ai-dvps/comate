import { create } from 'zustand'
import i18next from 'i18next'

export interface Plugin {
  id: string
  name: string
  displayName?: string
  description?: string
  version: string
  author?: string
  keywords?: string[]
  sourceMarketplace?: string
  sourceUrl?: string
  sourceType?: 'git' | 'zip' | 'local'
  builtIn?: boolean
}

export type PluginScope = 'user' | 'project' | 'local'

export interface InstalledPlugin extends Plugin {
  scope: PluginScope
  enabled: boolean
  installedAt: string
  updatedAt?: string
}

export interface PluginUpdate {
  id: string
  currentVersion: string
  newVersion: string
}

interface PluginState {
  installedPlugins: InstalledPlugin[]
  marketplacePlugins: Plugin[]
  updates: PluginUpdate[]
  isLoading: boolean
  isSaving: boolean
  error: string | null
  marketplaceQuery: string
  selectedMarketplaces: string[]
  selectedKeywords: string[]
  expandedSections: Record<string, boolean>

  fetchInstalledPlugins: (workspaceId?: string) => Promise<void>
  fetchMarketplacePlugins: (query?: string) => Promise<void>
  installPlugin: (pluginId: string, source: string, scope: PluginScope, workspaceId?: string) => Promise<boolean>
  uninstallPlugin: (pluginId: string, scope: PluginScope, workspaceId?: string, purgeData?: boolean) => Promise<boolean>
  updatePlugin: (pluginId: string, scope: PluginScope, workspaceId?: string) => Promise<boolean>
  setPluginEnabled: (pluginId: string, scope: PluginScope, enabled: boolean, workspaceId?: string) => Promise<boolean>
  checkUpdates: (workspaceId?: string) => Promise<void>
  setMarketplaceQuery: (query: string) => void
  toggleMarketplaceFilter: (marketplace: string) => void
  clearMarketplaceFilters: () => void
  toggleKeywordFilter: (keyword: string) => void
  clearKeywordFilters: () => void
  toggleSection: (marketplace: string) => void
  resetFilters: () => void
  clearError: () => void
}

const API_BASE = '/api/plugins'

export const usePluginStore = create<PluginState>((set) => ({
  installedPlugins: [],
  marketplacePlugins: [],
  updates: [],
  isLoading: false,
  isSaving: false,
  error: null,
  marketplaceQuery: '',
  selectedMarketplaces: [],
  selectedKeywords: [],
  expandedSections: {},

  fetchInstalledPlugins: async (workspaceId) => {
    set({ isLoading: true, error: null })
    try {
      const url = workspaceId ? `${API_BASE}/installed?workspaceId=${encodeURIComponent(workspaceId)}` : `${API_BASE}/installed`
      const res = await fetch(url)
      if (!res.ok) throw new Error(i18next.t('settings:plugins.fetchFailed', 'Failed to fetch installed plugins'))
      const data = await res.json()
      set({ installedPlugins: data.plugins || [], isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false })
    }
  },

  fetchMarketplacePlugins: async (query) => {
    set({ isLoading: true, error: null })
    try {
      const url = query ? `${API_BASE}/marketplace?query=${encodeURIComponent(query)}` : `${API_BASE}/marketplace`
      const res = await fetch(url)
      if (!res.ok) throw new Error(i18next.t('settings:plugins.marketplaceFailed', 'Failed to fetch marketplace'))
      const data = await res.json()
      set({ marketplacePlugins: data.plugins || [], isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false })
    }
  },

  installPlugin: async (pluginId, source, scope, workspaceId) => {
    set({ isSaving: true, error: null })
    try {
      const body: Record<string, unknown> = { pluginId, source, scope }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        set({ error: data.error || i18next.t('settings:plugins.installFailed', 'Failed to install plugin'), isSaving: false })
        return false
      }
      set((state) => ({
        installedPlugins: [...state.installedPlugins, data.plugin],
        isSaving: false,
      }))
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isSaving: false })
      return false
    }
  },

  uninstallPlugin: async (pluginId, scope, workspaceId, purgeData) => {
    set({ isSaving: true, error: null })
    try {
      const body: Record<string, unknown> = { pluginId, scope, purgeData: purgeData ?? true }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        set({ error: data.error || i18next.t('settings:plugins.uninstallFailed', 'Failed to uninstall plugin'), isSaving: false })
        return false
      }
      set((state) => ({
        installedPlugins: state.installedPlugins.filter((p) => !(p.id === pluginId && p.scope === scope)),
        isSaving: false,
      }))
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isSaving: false })
      return false
    }
  },

  updatePlugin: async (pluginId, scope, workspaceId) => {
    set({ isSaving: true, error: null })
    try {
      const body: Record<string, unknown> = { pluginId, scope }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        set({ error: data.error || i18next.t('settings:plugins.updateFailed', 'Failed to update plugin'), isSaving: false })
        return false
      }
      set((state) => ({
        installedPlugins: state.installedPlugins.map((p) =>
          p.id === pluginId && p.scope === scope ? { ...p, version: data.version || p.version } : p
        ),
        updates: state.updates.filter((u) => u.id !== pluginId),
        isSaving: false,
      }))
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isSaving: false })
      return false
    }
  },

  setPluginEnabled: async (pluginId, scope, enabled, workspaceId) => {
    // Optimistic update
    set((state) => ({
      installedPlugins: state.installedPlugins.map((p) =>
        p.id === pluginId && p.scope === scope ? { ...p, enabled } : p
      ),
    }))
    try {
      const body: Record<string, unknown> = { pluginId, scope, enabled }
      if (workspaceId) body.workspaceId = workspaceId
      const res = await fetch(`${API_BASE}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        // Revert optimistic update
        set((state) => ({
          installedPlugins: state.installedPlugins.map((p) =>
            p.id === pluginId && p.scope === scope ? { ...p, enabled: !enabled } : p
          ),
          error: data.error || i18next.t('settings:plugins.enableFailed', 'Failed to change plugin state'),
        }))
        return false
      }
      return true
    } catch (err) {
      // Revert optimistic update
      set((state) => ({
        installedPlugins: state.installedPlugins.map((p) =>
          p.id === pluginId && p.scope === scope ? { ...p, enabled: !enabled } : p
        ),
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
      }))
      return false
    }
  },

  checkUpdates: async (workspaceId) => {
    try {
      const url = workspaceId ? `${API_BASE}/updates?workspaceId=${encodeURIComponent(workspaceId)}` : `${API_BASE}/updates`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      set({ updates: data.updates || [] })
    } catch (err) {
      console.error('Failed to check for updates:', err)
    }
  },

  setMarketplaceQuery: (query) => set({ marketplaceQuery: query }),
  toggleMarketplaceFilter: (marketplace) =>
    set((state) => {
      const selected = new Set(state.selectedMarketplaces)
      if (selected.has(marketplace)) {
        selected.delete(marketplace)
      } else {
        selected.add(marketplace)
      }
      return { selectedMarketplaces: Array.from(selected) }
    }),
  clearMarketplaceFilters: () => set({ selectedMarketplaces: [] }),
  toggleKeywordFilter: (keyword) =>
    set((state) => {
      const selected = new Set(state.selectedKeywords)
      if (selected.has(keyword)) {
        selected.delete(keyword)
      } else {
        selected.add(keyword)
      }
      return { selectedKeywords: Array.from(selected) }
    }),
  clearKeywordFilters: () => set({ selectedKeywords: [] }),
  toggleSection: (marketplace) =>
    set((state) => ({
      expandedSections: {
        ...state.expandedSections,
        [marketplace]: !state.expandedSections[marketplace],
      },
    })),
  resetFilters: () =>
    set({
      selectedMarketplaces: [],
      selectedKeywords: [],
      expandedSections: {},
      marketplaceQuery: '',
    }),
  clearError: () => set({ error: null }),
}))
