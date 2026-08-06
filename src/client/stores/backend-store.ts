/**
 * backend-store — client mirror of the agent-backend registry (U5): per-backend
 * availability and capability table from /api/backends, plus the persisted
 * app-level default. The selector lists only available backends (R3); the
 * capability table drives disable+reason presentation (R10).
 */

import { create } from 'zustand'
import i18next from 'i18next'

export type BackendId = 'claude' | 'opencode'
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

interface BackendState {
  backends: BackendInfo[]
  defaultBackend: BackendId | null
  isLoading: boolean
  error: string | null
  fetchBackends: () => Promise<void>
  setDefaultBackend: (backend: BackendId) => Promise<void>
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
}))

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
