import { create } from 'zustand'
import i18next from 'i18next'
import type { BackendId } from './backend-store'

interface UsageProvider {
  configuration?: { preset?: { id: string } }
  availability?: Partial<Record<BackendId, { available: boolean }>>
}

export interface UsageSummary {
  used: number | null
  total: number | null
  remaining: number | null
  resetDate: string | null
  /** Secondary rolling rate-limit window (e.g. Kimi's 5-hour limit), settings-only. */
  rolling: { remaining: number | null; resetDate: string | null } | null
  lastUpdated: string
}

export type UsageStatus =
  | 'idle'
  | 'fetching'
  | 'ready'
  | 'relogin'
  | 'no-plan'
  | 'unsupported'
  | 'error'

export interface UsageState {
  summary: UsageSummary | null
  status: UsageStatus
  /** Client-side timestamp of the last fetch (throttle); the summary's own
   * lastUpdated is when the server fetched the quota live. */
  lastUpdated: number | null
}

export type LoginPhase = 'connecting' | 'ready' | 'capturing' | 'success' | 'failed' | 'cancelled'

export interface UsageLoginState {
  providerId: string
  sessionId: string
  phase: LoginPhase
  agent: BackendId
  error?: string
}

const API_BASE = '/api/providers'
/** Avoid refetching on every render/open; the server always fetches live. */
const CLIENT_FETCH_THROTTLE_MS = 10_000
const USAGE_AGENT_IDS = ['claude', 'codex', 'opencode'] as const

/** Usage is available only for Providers carrying trusted preset provenance. */
export function hasUsageSupport(provider: UsageProvider): boolean {
  const presetId = provider.configuration?.preset?.id
  return presetId === 'kimi' || presetId === 'bigmodel'
}

export function isBackendId(value: unknown): value is BackendId {
  return USAGE_AGENT_IDS.some((agent) => agent === value)
}

/** Pick an Agent that can actually route through this Provider. */
export function providerUsageAgent(provider: UsageProvider): BackendId {
  return USAGE_AGENT_IDS.find(
    (agent) => provider.availability?.[agent]?.available,
  ) ?? 'claude'
}

/** Usage percentage (0–100) for the progress bar; null when not computable. */
export function usagePercentage(summary: UsageSummary | null): number | null {
  if (!summary || summary.used === null || summary.total === null || summary.total === 0) return null
  return Math.min(100, Math.max(0, (summary.used / summary.total) * 100))
}

/** Semantic bar color by usage severity: green < 60%, yellow 60–80%, red > 80%. */
export function usageBarColor(pct: number | null): string {
  if (pct === null) return 'bg-text-tertiary'
  if (pct > 80) return 'bg-destructive'
  if (pct > 60) return 'bg-warning'
  return 'bg-success'
}

/** Format a remaining-quota value for the minimal selector line. */
export function formatRemaining(remaining: number | null | undefined): string {
  if (remaining === null || remaining === undefined) return ''
  return `${remaining} left`
}

/** Format remaining quota as a percentage of the plan ("80% left") for compact
 * displays; empty string when not computable. */
export function formatRemainingPercent(summary: UsageSummary | null): string {
  if (!summary || summary.total === null || summary.total === 0) return ''
  const remaining = summary.remaining ?? (summary.used !== null ? summary.total - summary.used : null)
  if (remaining === null) return ''
  const pct = Math.min(100, Math.max(0, (remaining / summary.total) * 100))
  return `${Math.round(pct)}% left`
}

interface ProviderUsageState {
  usageByProvider: Record<string, UsageState>
  login: UsageLoginState | null

  fetchUsage: (id: string, opts?: { force?: boolean; agent?: BackendId }) => Promise<void>
  startUsageLogin: (id: string, agent?: BackendId) => Promise<void>
  finalizeUsageLogin: () => Promise<void>
  cancelUsageLogin: () => Promise<void>
  clearUsage: (id: string) => void
}

function emptyState(): UsageState {
  return { summary: null, status: 'idle', lastUpdated: null }
}

const inFlightUsageRequests = new Map<string, Promise<void>>()

export const useProviderUsageStore = create<ProviderUsageState>((set, get) => ({
  usageByProvider: {},
  login: null,

  fetchUsage: (id, opts) => {
    const agent = opts?.agent ?? 'claude'
    const requestKey = `${id}:${agent}`
    const inFlight = inFlightUsageRequests.get(requestKey)
    if (!opts?.force && inFlight) return inFlight

    const request = (async () => {
      const existing = get().usageByProvider[id]
      if (!opts?.force && existing?.lastUpdated && Date.now() - existing.lastUpdated < CLIENT_FETCH_THROTTLE_MS) return
      set((s) => ({
        usageByProvider: {
          ...s.usageByProvider,
          [id]: { ...(existing ?? emptyState()), status: 'fetching' },
        },
      }))
      try {
        const res = await fetch(`${API_BASE}/${id}/usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent }),
        })
        const data = (await res.json()) as { status?: UsageStatus; summary?: UsageSummary }
        set((s) => ({
          usageByProvider: {
            ...s.usageByProvider,
            [id]: {
              summary: data.summary ?? null,
              status: data.status ?? 'error',
              lastUpdated: Date.now(),
            },
          },
        }))
      } catch (err) {
        set((s) => ({
          usageByProvider: {
            ...s.usageByProvider,
            [id]: { summary: null, status: 'error', lastUpdated: Date.now() },
          },
        }))
        console.error('Failed to fetch provider usage:', err)
      }
    })()

    if (!opts?.force) {
      inFlightUsageRequests.set(requestKey, request)
      void request.finally(() => {
        if (inFlightUsageRequests.get(requestKey) === request) inFlightUsageRequests.delete(requestKey)
      })
    }
    return request
  },

  startUsageLogin: async (id, agent = 'claude') => {
    set({ login: { providerId: id, sessionId: '', phase: 'connecting', agent } })
    try {
      const res = await fetch(`${API_BASE}/${id}/usage-login/start`, { method: 'POST' })
      const data = (await res.json()) as { sessionId?: string; error?: string }
      if (!res.ok || !data.sessionId) {
        set({ login: null })
        throw new Error(data.error || i18next.t('settings:providers.usageLoginStartFailed', 'Failed to start login'))
      }
      set((s) => (s.login ? { login: { ...s.login, sessionId: data.sessionId!, phase: 'ready' } } : {}))
    } catch (err) {
      set({ login: null })
      throw err
    }
  },

  finalizeUsageLogin: async () => {
    const login = get().login
    if (!login) return
    set((s) => (s.login ? { login: { ...s.login, phase: 'capturing' } } : {}))
    try {
      const res = await fetch(`${API_BASE}/${login.providerId}/usage-login/finalize`, {
        method: 'POST',
      })
      const data = (await res.json()) as { status?: 'ready' | 'relogin'; reason?: string }
      if (data.status === 'ready') {
        set({ login: { ...login, phase: 'success' } })
        // Refetch usage for the provider now that a token is stored.
        await get().fetchUsage(login.providerId, { force: true, agent: login.agent })
        set({ login: null })
      } else {
        set({ login: { ...login, phase: 'failed', error: data.reason || 'relogin' } })
      }
    } catch (err) {
      set({ login: { ...login, phase: 'failed', error: err instanceof Error ? err.message : 'error' } })
    }
  },

  cancelUsageLogin: async () => {
    const login = get().login
    if (login?.sessionId) {
      await fetch(`${API_BASE}/${login.providerId}/usage-login/cancel`, { method: 'POST' }).catch(() => {})
    }
    set({ login: null })
  },

  clearUsage: (id) =>
    set((s) => {
      const next = { ...s.usageByProvider }
      delete next[id]
      return { usageByProvider: next }
    }),
}))
