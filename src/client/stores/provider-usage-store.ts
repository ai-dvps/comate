import { create } from 'zustand'
import i18next from 'i18next'

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
   * lastUpdated is the server cache time. */
  lastUpdated: number | null
}

export type LoginPhase = 'connecting' | 'ready' | 'capturing' | 'success' | 'failed' | 'cancelled'

export interface UsageLoginState {
  providerId: string
  sessionId: string
  phase: LoginPhase
  error?: string
}

const API_BASE = '/api/providers'
/** Avoid refetching on every render/open; the server holds the 24h cache. */
const CLIENT_FETCH_THROTTLE_MS = 10_000

/**
 * Client-side gate: does this provider's baseUrl belong to a provider whose
 * coding-plan usage we support (kimi.com or bigmodel.cn)?
 */
export function hasUsageSupport(baseUrl: string): boolean {
  const url = baseUrl.toLowerCase()
  return url.includes('kimi.com') || url.includes('bigmodel.cn')
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

interface ProviderUsageState {
  usageByProvider: Record<string, UsageState>
  login: UsageLoginState | null

  fetchUsage: (id: string, opts?: { force?: boolean }) => Promise<void>
  startUsageLogin: (id: string) => Promise<void>
  finalizeUsageLogin: () => Promise<void>
  cancelUsageLogin: () => Promise<void>
  clearUsage: (id: string) => void
}

function emptyState(): UsageState {
  return { summary: null, status: 'idle', lastUpdated: null }
}

export const useProviderUsageStore = create<ProviderUsageState>((set, get) => ({
  usageByProvider: {},
  login: null,

  fetchUsage: async (id, opts) => {
    const existing = get().usageByProvider[id]
    if (!opts?.force && existing && existing.lastUpdated && Date.now() - existing.lastUpdated < CLIENT_FETCH_THROTTLE_MS) {
      return
    }
    set((s) => ({
      usageByProvider: { ...s.usageByProvider, [id]: { ...(existing ?? emptyState()), status: 'fetching' } },
    }))
    try {
      const res = await fetch(`${API_BASE}/${id}/usage`, { method: 'POST' })
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
  },

  startUsageLogin: async (id) => {
    set({ login: { providerId: id, sessionId: '', phase: 'connecting' } })
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
        await get().fetchUsage(login.providerId, { force: true })
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
