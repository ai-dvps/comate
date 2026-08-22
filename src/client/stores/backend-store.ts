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
  codexRequiresOpenaiAuth: boolean
  codexModels: CodexModel[]
  codexAccountLoading: boolean
  codexAccountError: string | null
  fetchBackends: () => Promise<void>
  setDefaultBackend: (backend: BackendId) => Promise<void>
  fetchCodexAccount: () => Promise<void>
  startCodexLogin: (type: 'chatgpt' | 'apiKey', apiKey?: string) => Promise<CodexLoginResult>
  cancelCodexLogin: (loginId: string) => Promise<void>
  logoutCodex: () => Promise<void>
  fetchCodexModels: () => Promise<void>
}

const API_BASE = '/api/backends'

export const useBackendStore = create<BackendState>((set) => ({
  backends: [],
  // The app-level default agent is 'claude' from first paint; the server
  // confirms or overrides this on fetch. Avoids the "nothing selected, must
  // click before chatting" state.
  defaultBackend: 'claude',
  isLoading: false,
  error: null,
  codexAccount: null,
  codexRequiresOpenaiAuth: true,
  codexModels: [],
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
      set({
        codexAccount: data.account ?? null,
        codexRequiresOpenaiAuth: Boolean(data.requiresOpenaiAuth),
        codexAccountLoading: false,
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
    set({ codexAccountLoading: true, codexAccountError: null })
    try {
      const res = await fetch(`${API_BASE}/codex/logout`, { method: 'POST' })
      if (!res.ok) throw new Error(await responseError(res))
      set({ codexAccount: null, codexModels: [], codexAccountLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error')
      set({ codexAccountError: message, codexAccountLoading: false })
      throw new Error(message)
    }
  },

  fetchCodexModels: async () => {
    try {
      const res = await fetch(`${API_BASE}/codex/models`)
      if (!res.ok) throw new Error(await responseError(res))
      const data = await res.json()
      set({ codexModels: (data.data ?? []).filter((model: CodexModel) => !model.hidden) })
    } catch (err) {
      set({ codexAccountError: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') })
    }
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
