import { create } from 'zustand'
import i18next from 'i18next'
import type { BackendId } from './backend-store'

export type ProviderOpenAiFormat = 'openai-responses' | 'openai-chat-completions'
export type ProviderOpenCodeProtocol = 'anthropic' | 'openai'
export type ProviderEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ProviderConfiguration {
  schemaVersion: 1
  endpoints: {
    anthropic?: { enabled: boolean; baseUrl: string }
    openai?: { enabled: boolean; baseUrl: string; format: ProviderOpenAiFormat }
  }
  models: { claudeCode?: string; codex?: string; openCode?: string }
  openCode: { protocol: ProviderOpenCodeProtocol }
  claude: {
    defaultOpusModel?: string
    defaultSonnetModel?: string
    defaultHaikuModel?: string
    subagentModel?: string
    effortLevel?: string
    customEnvVars?: Record<string, string>
  }
  codex: {
    promptCacheRouting?: 'auto' | 'unsupported'
    thinking?: 'required' | 'supported' | 'unsupported' | 'unknown'
    effortByModel?: Record<string, ProviderEffort[]>
    effortWireMappingByModel?: Record<string, Partial<Record<ProviderEffort, string>>>
  }
  preset?: { id: string; version: number }
}

export interface ProviderAvailability {
  available: boolean
  providerId: string
  agent: BackendId
  mode: string
  reason?: string
  model?: string
  vendorId?: string
  supportedEfforts: ProviderEffort[]
  speedSupported: false
}

export interface Provider {
  id: string
  name: string
  configuration?: ProviderConfiguration
  authTokenPresent: boolean
  isDefault: boolean
  availability: Record<BackendId, ProviderAvailability>
  baseUrl: string
  protocol: 'anthropic' | 'openai-responses'
  model?: string
  defaultOpusModel?: string
  defaultSonnetModel?: string
  defaultHaikuModel?: string
  subagentModel?: string
  effortLevel?: string
  customEnvVars?: Record<string, string>
  supportsFastMode?: boolean
  createdAt: string
  updatedAt: string
}

export interface ProviderPreset {
  id: string
  version: number
  name: string
  vendorId: string
  configuration: ProviderConfiguration
  capabilities: {
    promptCacheRouting: 'auto' | 'unsupported'
    thinking: 'required' | 'supported' | 'unknown'
    codexEffortWireMapping: Partial<Record<ProviderEffort, string>>
    thirdPartySpeed: false
  }
}

export interface ProviderFormData {
  name: string
  authToken: string
  configuration: ProviderConfiguration
}

export interface ProviderMutationResult { provider: Provider | null; status?: number; error?: string }

interface ProviderState {
  providers: Provider[]
  presets: ProviderPreset[]
  isLoading: boolean
  presetsLoading: boolean
  isSaving: boolean
  error: string | null
  healthCheckKey: string | null
  fetchProviders: () => Promise<void>
  fetchPresets: () => Promise<void>
  detectProviders: () => Promise<void>
  createProvider: (data: ProviderFormData, options?: { skipHealthCheck?: boolean; agent?: BackendId }) => Promise<ProviderMutationResult>
  updateProvider: (id: string, data: ProviderFormData, options?: { skipHealthCheck?: boolean; agent?: BackendId }) => Promise<ProviderMutationResult>
  deleteProvider: (id: string) => Promise<{ ok: boolean; affectedSessionCount?: number }>
  setDefaultProvider: (id: string) => Promise<void>
  runHealthCheck: (id: string, agent: BackendId) => Promise<{ ok: boolean; error?: string }>
  clearError: () => void
}

const API_BASE = '/api/providers'

function normalizeProvider(raw: Partial<Provider> & Pick<Provider, 'id' | 'name' | 'authTokenPresent' | 'isDefault' | 'createdAt' | 'updatedAt'>): Provider {
  const configuration = raw.configuration
  const openai = configuration?.endpoints.openai
  const anthropic = configuration?.endpoints.anthropic
  const baseUrl = openai?.baseUrl || anthropic?.baseUrl || raw.baseUrl || ''
  const protocol = openai?.enabled && !anthropic?.enabled ? 'openai-responses' : (raw.protocol ?? 'anthropic')
  const unavailable = (agent: BackendId): ProviderAvailability => ({
    available: false, providerId: raw.id, agent, mode: 'unavailable', reason: 'configuration-missing',
    supportedEfforts: [], speedSupported: false,
  })
  return {
    ...raw,
    availability: raw.availability ?? { claude: unavailable('claude'), codex: unavailable('codex'), opencode: unavailable('opencode') },
    baseUrl,
    protocol,
    model: configuration?.models.codex ?? configuration?.models.claudeCode ?? raw.model,
    defaultOpusModel: configuration?.claude.defaultOpusModel ?? raw.defaultOpusModel,
    defaultSonnetModel: configuration?.claude.defaultSonnetModel ?? raw.defaultSonnetModel,
    defaultHaikuModel: configuration?.claude.defaultHaikuModel ?? raw.defaultHaikuModel,
    subagentModel: configuration?.claude.subagentModel ?? raw.subagentModel,
    effortLevel: configuration?.claude.effortLevel ?? raw.effortLevel,
    customEnvVars: configuration?.claude.customEnvVars ?? raw.customEnvVars,
  }
}

function formToInput(data: ProviderFormData, options?: { skipHealthCheck?: boolean; agent?: BackendId }) {
  return {
    name: data.name.trim(), configuration: structuredClone(data.configuration),
    ...(data.authToken ? { authToken: data.authToken } : {}),
    ...(options?.skipHealthCheck ? { skipHealthCheck: true } : {}),
    agent: options?.agent ?? 'claude',
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json() as Record<string, unknown> } catch { return {} }
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [], presets: [], isLoading: false, presetsLoading: false, isSaving: false, error: null, healthCheckKey: null,

  fetchProviders: async () => {
    set({ isLoading: true, error: null })
    try {
      const res = await fetch(API_BASE)
      if (!res.ok) throw new Error(i18next.t('settings:providers.fetchFailed'))
      const data = await readJson(res)
      set({ providers: Array.isArray(data.providers) ? data.providers.map((entry) => normalizeProvider(entry as Provider)) : [], isLoading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : i18next.t('common:unknownError'), isLoading: false })
    }
  },

  fetchPresets: async () => {
    set({ presetsLoading: true })
    try {
      const res = await fetch(`${API_BASE}/presets`)
      if (!res.ok) throw new Error(i18next.t('settings:providers.presetsFetchFailed'))
      const data = await readJson(res)
      set({ presets: Array.isArray(data.presets) ? data.presets as ProviderPreset[] : [], presetsLoading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : i18next.t('common:unknownError'), presetsLoading: false })
    }
  },

  detectProviders: async () => {
    set({ isLoading: true, error: null })
    try {
      const res = await fetch(`${API_BASE}/detect`, { method: 'POST' })
      if (!res.ok) throw new Error(i18next.t('settings:providers.detectFailed'))
      const data = await readJson(res)
      set((state) => ({ providers: data.provider ? [normalizeProvider(data.provider as Provider), ...state.providers] : state.providers, isLoading: false }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : i18next.t('common:unknownError'), isLoading: false })
    }
  },

  createProvider: async (data, options) => {
    set({ isSaving: true, error: null })
    try {
      const res = await fetch(API_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formToInput(data, options)) })
      const response = await readJson(res)
      if (!res.ok) {
        const message = typeof response.error === 'string' ? response.error : i18next.t('settings:providers.createFailed')
        set({ error: message, isSaving: false })
        return { provider: null, status: res.status, error: message }
      }
      const provider = normalizeProvider(response.provider as Provider)
      set((state) => ({ providers: [provider, ...state.providers], isSaving: false }))
      return { provider }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18next.t('common:unknownError')
      set({ error: message, isSaving: false })
      return { provider: null, error: message }
    }
  },

  updateProvider: async (id, data, options) => {
    set({ isSaving: true, error: null })
    try {
      const res = await fetch(`${API_BASE}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formToInput(data, options)) })
      const response = await readJson(res)
      if (!res.ok) {
        const message = typeof response.error === 'string' ? response.error : i18next.t('settings:providers.updateFailed')
        set({ error: message, isSaving: false })
        return { provider: null, status: res.status, error: message }
      }
      const provider = normalizeProvider(response.provider as Provider)
      set((state) => ({ providers: state.providers.map((entry) => entry.id === id ? provider : entry), isSaving: false }))
      return { provider }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18next.t('common:unknownError')
      set({ error: message, isSaving: false })
      return { provider: null, error: message }
    }
  },

  deleteProvider: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' })
      const data = await readJson(res)
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : i18next.t('settings:providers.deleteFailed'))
      set((state) => ({ providers: state.providers.filter((provider) => provider.id !== id) }))
      return { ok: true, ...(typeof data.affectedSessionCount === 'number' ? { affectedSessionCount: data.affectedSessionCount } : {}) }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : i18next.t('common:unknownError') })
      return { ok: false }
    }
  },

  setDefaultProvider: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isDefault: true }) })
      const data = await readJson(res)
      if (!res.ok) throw new Error(i18next.t('settings:providers.setDefaultFailed'))
      const updated = normalizeProvider(data.provider as Provider)
      set((state) => ({ providers: state.providers.map((provider) => provider.id === id ? updated : { ...provider, isDefault: false }) }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : i18next.t('common:unknownError') })
    }
  },

  runHealthCheck: async (id, agent) => {
    const key = `${id}:${agent}`
    set({ healthCheckKey: key })
    try {
      const res = await fetch(`${API_BASE}/${id}/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
      const data = await readJson(res)
      set({ healthCheckKey: null })
      return { ok: data.ok === true, ...(typeof data.error === 'string' ? { error: data.error } : {}) }
    } catch (error) {
      set({ healthCheckKey: null })
      return { ok: false, error: error instanceof Error ? error.message : i18next.t('common:unknownError') }
    }
  },

  clearError: () => set({ error: null }),
}))

export function providerReasonKey(reason?: string): string {
  return reason ? `provider.reasons.${reason}` : 'provider.reasons.unavailable'
}
