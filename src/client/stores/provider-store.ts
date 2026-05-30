import { create } from 'zustand'
import i18next from 'i18next'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  authToken: string
  model?: string
  isDefault: boolean
  defaultOpusModel?: string
  defaultSonnetModel?: string
  defaultHaikuModel?: string
  subagentModel?: string
  effortLevel?: string
  customEnvVars?: Record<string, string>
  createdAt: string
  updatedAt: string
}

interface ProviderFormData {
  name: string
  baseUrl: string
  authToken: string
  model: string
  defaultOpusModel: string
  defaultSonnetModel: string
  defaultHaikuModel: string
  subagentModel: string
  effortLevel: string
  customEnvVars: { key: string; value: string }[]
}

interface ProviderState {
  providers: Provider[]
  isLoading: boolean
  isSaving: boolean
  error: string | null
  healthCheckId: string | null

  fetchProviders: () => Promise<void>
  detectProviders: () => Promise<void>
  createProvider: (data: ProviderFormData) => Promise<Provider | null>
  updateProvider: (id: string, data: ProviderFormData) => Promise<Provider | null>
  deleteProvider: (id: string) => Promise<boolean>
  setDefaultProvider: (id: string) => Promise<void>
  runHealthCheck: (id: string) => Promise<{ ok: boolean; error?: string }>
  clearError: () => void
}

const API_BASE = '/api/providers'

function formToInput(data: ProviderFormData): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: data.name.trim(),
    baseUrl: data.baseUrl.trim(),
    authToken: data.authToken,
  }
  if (data.model) input.model = data.model.trim()
  if (data.defaultOpusModel) input.defaultOpusModel = data.defaultOpusModel.trim()
  if (data.defaultSonnetModel) input.defaultSonnetModel = data.defaultSonnetModel.trim()
  if (data.defaultHaikuModel) input.defaultHaikuModel = data.defaultHaikuModel.trim()
  if (data.subagentModel) input.subagentModel = data.subagentModel.trim()
  if (data.effortLevel) input.effortLevel = data.effortLevel.trim()

  const customEnvVars: Record<string, string> = {}
  for (const item of data.customEnvVars) {
    if (item.key.trim()) {
      customEnvVars[item.key.trim()] = item.value
    }
  }
  if (Object.keys(customEnvVars).length > 0) {
    input.customEnvVars = customEnvVars
  }

  return input
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  isLoading: false,
  isSaving: false,
  error: null,
  healthCheckId: null,

  fetchProviders: async () => {
    set({ isLoading: true, error: null })
    try {
      const res = await fetch(API_BASE)
      if (!res.ok) throw new Error(i18next.t('settings:providers.fetchFailed', 'Failed to fetch providers'))
      const data = await res.json()
      set({ providers: data.providers || [], isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false })
    }
  },

  detectProviders: async () => {
    set({ isLoading: true, error: null })
    try {
      const res = await fetch(`${API_BASE}/detect`, { method: 'POST' })
      if (!res.ok) throw new Error(i18next.t('settings:providers.detectFailed', 'Failed to detect providers'))
      const data = await res.json()
      if (data.provider) {
        set((state) => ({ providers: [data.provider, ...state.providers], isLoading: false }))
      } else {
        set({ isLoading: false })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isLoading: false })
    }
  },

  createProvider: async (data) => {
    set({ isSaving: true, error: null })
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToInput(data)),
      })
      const responseData = await res.json()
      if (!res.ok) {
        throw new Error(responseData.error || i18next.t('settings:providers.createFailed', 'Failed to create provider'))
      }
      set((state) => ({
        providers: [responseData.provider, ...state.providers],
        isSaving: false,
      }))
      return responseData.provider as Provider
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isSaving: false })
      return null
    }
  },

  updateProvider: async (id, data) => {
    set({ isSaving: true, error: null })
    try {
      const res = await fetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToInput(data)),
      })
      const responseData = await res.json()
      if (!res.ok) {
        throw new Error(responseData.error || i18next.t('settings:providers.updateFailed', 'Failed to update provider'))
      }
      set((state) => ({
        providers: state.providers.map((p) => (p.id === id ? responseData.provider : p)),
        isSaving: false,
      }))
      return responseData.provider as Provider
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'), isSaving: false })
      return null
    }
  },

  deleteProvider: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(i18next.t('settings:providers.deleteFailed', 'Failed to delete provider'))
      set((state) => ({
        providers: state.providers.filter((p) => p.id !== id),
      }))
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') })
      return false
    }
  },

  setDefaultProvider: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!res.ok) throw new Error(i18next.t('settings:providers.setDefaultFailed', 'Failed to set default provider'))
      const data = await res.json()
      set((state) => ({
        providers: state.providers.map((p) =>
          p.id === id ? data.provider : { ...p, isDefault: false }
        ),
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') })
    }
  },

  runHealthCheck: async (id) => {
    set({ healthCheckId: id })
    try {
      const res = await fetch(`${API_BASE}/${id}/health`, { method: 'POST' })
      const data = await res.json()
      set({ healthCheckId: null })
      return { ok: data.ok, error: data.error }
    } catch (err) {
      set({ healthCheckId: null })
      return { ok: false, error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') }
    }
  },

  clearError: () => set({ error: null }),
}))
