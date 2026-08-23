/**
 * backend-store — client mirror of the agent-backend registry (U5): per-backend
 * availability and capability table from /api/backends, plus the persisted
 * app-level default. The selector lists only available backends (R3); the
 * capability table drives disable+reason presentation (R10).
 */

import { create } from 'zustand'
import i18next from 'i18next'

export type BackendId = 'claude' | 'opencode' | 'codex'
export type CapabilityState = 'full' | 'degraded' | 'unavailable'

export interface CapabilityEntry {
  state: CapabilityState
  reasonKey?: string
}

export interface BackendInfo {
  id: BackendId
  availability: { status: 'available' | 'unavailable'; reason?: string }
  capabilities: Record<string, CapabilityEntry>
}

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  defaultReasoningEffort: string
  serviceTiers: Array<{ id: string; name: string; description: string }>
  defaultServiceTier: string | null
}

export interface CodexAccountUsage {
  rateLimit: {
    limitId: string | null
    limitName: string | null
    primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null
    secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
    planType: string | null
    spendControlReached: boolean | null
    rateLimitReachedType: string | null
  } | null
  tokenUsage: {
    lifetimeTokens: string | null
    peakDailyTokens: string | null
    currentStreakDays: string | null
    longestStreakDays: string | null
    dailyUsageBuckets: Array<{ startDate: string; tokens: string }>
  } | null
}

export type CodexLoginResult =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }

interface BackendState {
  backends: BackendInfo[]
  defaultBackend: BackendId | null
  isLoading: boolean
  error: string | null
  codexAccount: CodexAccount | null
  codexModels: CodexModel[]
  codexDefaultModel: string | null
  codexDefaultEffort: string | null
  codexDefaultSpeed: string | null
  codexUsage: CodexAccountUsage | null
  codexUsageLoading: boolean
  codexUsageError: string | null
  codexAccountLoading: boolean
  codexAccountError: string | null
  fetchBackends: () => Promise<void>
  setDefaultBackend: (backend: BackendId) => Promise<void>
  fetchCodexAccount: () => Promise<void>
  startCodexLogin: (type: 'chatgpt' | 'apiKey', apiKey?: string) => Promise<CodexLoginResult>
  cancelCodexLogin: (loginId: string) => Promise<void>
  logoutCodex: () => Promise<void>
  fetchCodexModels: () => Promise<void>
  fetchCodexUsage: () => Promise<void>
  setCodexDefaults: (defaults: { model: string | null; effort: string | null; speed: string | null }) => Promise<void>
}

const API_BASE = '/api/backends'
let codexDefaultsMutationId = 0
let codexUsageRequestId = 0
const pendingCodexDefaultsRequests = new Set<Promise<void>>()

export const useBackendStore = create<BackendState>((set, get) => ({
  backends: [],
  // The app-level default agent is 'claude' from first paint; the server
  // confirms or overrides this on fetch. Avoids the "nothing selected, must
  // click before chatting" state.
  defaultBackend: 'claude',
  isLoading: false,
  error: null,
  codexAccount: null,
  codexModels: [],
  codexDefaultModel: null,
  codexDefaultEffort: null,
  codexDefaultSpeed: null,
  codexUsage: null,
  codexUsageLoading: false,
  codexUsageError: null,
  codexAccountLoading: false,
  codexAccountError: null,

  fetchBackends: async () => {
    set({ isLoading: true, error: null })
    try {
      const [listRes, defaultRes] = await Promise.all([
        fetch(API_BASE),
        fetch(`${API_BASE}/default`),
      ])
      if (!listRes.ok) throw new Error(i18next.t('common:fetchFailed', 'Fetch failed'))
      const listData = await listRes.json()
      const defaultData = defaultRes.ok ? await defaultRes.json() : { backend: null }
      set({
        backends: listData.backends || [],
        defaultBackend: defaultData.backend ?? 'claude',
        isLoading: false,
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isLoading: false,
      })
    }
  },

  setDefaultBackend: async (backend: BackendId) => {
    const res = await fetch(`${API_BASE}/default`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend }),
    })
    if (!res.ok) throw new Error(i18next.t('common:failedToUpdateSession', 'Failed to update'))
    set({ defaultBackend: backend })
  },

  fetchCodexAccount: async () => {
    set({ codexAccountLoading: true, codexAccountError: null })
    try {
      const res = await fetch(`${API_BASE}/codex/account`)
      if (!res.ok) throw new Error(await responseError(res))
      const data = await res.json()
      codexUsageRequestId += 1
      set({
        codexAccount: data.account ?? null,
        codexAccountLoading: false,
        codexUsageLoading: false,
        ...(data.account ? {} : { codexUsage: null, codexUsageError: null }),
      })
    } catch (err) {
      set({
        codexAccountError: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        codexAccountLoading: false,
      })
    }
  },

  startCodexLogin: async (type, apiKey) => {
    set({ codexAccountLoading: true, codexAccountError: null })
    try {
      const res = await fetch(`${API_BASE}/codex/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(type === 'apiKey' ? { type, apiKey } : { type }),
      })
      if (!res.ok) throw new Error(await responseError(res))
      const result = await res.json() as CodexLoginResult
      set({ codexAccountLoading: false })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error')
      set({ codexAccountError: message, codexAccountLoading: false })
      throw new Error(message)
    }
  },

  cancelCodexLogin: async (loginId) => {
    const res = await fetch(`${API_BASE}/codex/login/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId }),
    })
    if (!res.ok) throw new Error(await responseError(res))
  },

  logoutCodex: async () => {
    codexUsageRequestId += 1
    set({ codexAccountLoading: true, codexAccountError: null })
    try {
      while (pendingCodexDefaultsRequests.size > 0) {
        await Promise.allSettled([...pendingCodexDefaultsRequests])
      }
      const res = await fetch(`${API_BASE}/codex/logout`, { method: 'POST' })
      if (!res.ok) throw new Error(await responseError(res))
      set({
        codexAccount: null,
        codexModels: [],
        codexDefaultModel: null,
        codexDefaultEffort: null,
        codexDefaultSpeed: null,
        codexUsage: null,
        codexUsageLoading: false,
        codexUsageError: null,
        codexAccountLoading: false,
        codexAccountError: null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error')
      set({ codexAccountError: message, codexAccountLoading: false })
      throw new Error(message)
    }
  },

  fetchCodexModels: async () => {
    try {
      const [modelsRes, preferenceRes] = await Promise.all([
        fetch(`${API_BASE}/codex/models`),
        fetch(`${API_BASE}/codex/defaults`),
      ])
      if (!modelsRes.ok) throw new Error(await responseError(modelsRes))
      if (!preferenceRes.ok) throw new Error(await responseError(preferenceRes))
      const modelsData = await modelsRes.json()
      const preferenceData = await preferenceRes.json()
      set({
        codexModels: (modelsData.data ?? []).filter((model: CodexModel) => !model.hidden),
        codexDefaultModel: typeof preferenceData.model === 'string' ? preferenceData.model : null,
        codexDefaultEffort: typeof preferenceData.effort === 'string' ? preferenceData.effort : null,
        codexDefaultSpeed: typeof preferenceData.speed === 'string' ? preferenceData.speed : null,
      })
    } catch (err) {
      set({ codexAccountError: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') })
    }
  },

  fetchCodexUsage: async () => {
    const requestId = ++codexUsageRequestId
    set({ codexUsageLoading: true, codexUsageError: null })
    try {
      const res = await fetch(`${API_BASE}/codex/usage`)
      if (!res.ok) throw new Error(await responseError(res))
      const codexUsage = await res.json() as CodexAccountUsage
      if (requestId !== codexUsageRequestId) return
      set({
        codexUsage,
        codexUsageLoading: false,
      })
    } catch (err) {
      if (requestId !== codexUsageRequestId) return
      set({
        codexUsageError: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        codexUsageLoading: false,
      })
    }
  },

  setCodexDefaults: (defaults) => {
    const request = (async () => {
      const mutationId = ++codexDefaultsMutationId
      const previous = {
        codexDefaultModel: get().codexDefaultModel,
        codexDefaultEffort: get().codexDefaultEffort,
        codexDefaultSpeed: get().codexDefaultSpeed,
      }
      set({
        codexDefaultModel: defaults.model,
        codexDefaultEffort: defaults.effort,
        codexDefaultSpeed: defaults.speed,
        codexAccountError: null,
      })
      try {
        const res = await fetch(`${API_BASE}/codex/defaults`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(defaults),
        })
        if (!res.ok) throw new Error(await responseError(res))
      } catch (err) {
        const message = err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error')
        if (mutationId === codexDefaultsMutationId) set({ ...previous, codexAccountError: message })
        throw new Error(message)
      }
    })()
    pendingCodexDefaultsRequests.add(request)
    void request.finally(() => pendingCodexDefaultsRequests.delete(request)).catch(() => undefined)
    return request
  },
}))

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // Use the stable fallback below for non-JSON errors.
  }
  return i18next.t('common:fetchFailed', 'Fetch failed')
}

/** Availability lookup helper for components. */
export function backendAvailability(
  backends: BackendInfo[],
  id: BackendId | string | undefined,
): BackendInfo['availability'] | undefined {
  if (!id) return undefined
  return backends.find((b) => b.id === id)?.availability
}

/** Capability lookup helper (defaults to full for claude, unavailable otherwise). */
export function backendCapability(
  backends: BackendInfo[],
  id: BackendId | string | undefined,
  capability: string,
): CapabilityEntry {
  const backend = backends.find((b) => b.id === id)
  const declared = backend?.capabilities?.[capability]
  if (declared) return declared
  return id === 'claude'
    ? { state: 'full' }
    : { state: 'unavailable', reasonKey: 'backend.capabilityUndeclared' }
}
