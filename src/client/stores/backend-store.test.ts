import { afterEach, describe, it, expect, vi } from 'vitest'
import { backendAvailability, backendCapability, type BackendInfo, useBackendStore } from './backend-store'

const backends: BackendInfo[] = [
  {
    id: 'claude',
    availability: { status: 'available' },
    capabilities: { imageInput: { state: 'full' } },
  },
  {
    id: 'opencode',
    availability: { status: 'unavailable', reason: 'binary missing' },
    capabilities: {
      analytics: { state: 'full' },
      imageInput: { state: 'full' },
    },
  },
]

describe('backendAvailability', () => {
  it('returns the matching backend availability', () => {
    expect(backendAvailability(backends, 'opencode')?.status).toBe('unavailable')
    expect(backendAvailability(backends, 'claude')?.status).toBe('available')
    expect(backendAvailability(backends, undefined)).toBeUndefined()
  })
})

describe('backendCapability', () => {
  it('returns declared entries', () => {
    expect(backendCapability(backends, 'opencode', 'analytics').state).toBe('full')
    expect(backendCapability(backends, 'opencode', 'imageInput').state).toBe('full')
  })

  it('defaults undeclared to full on claude and unavailable elsewhere', () => {
    expect(backendCapability(backends, 'claude', 'hooks').state).toBe('full')
    expect(backendCapability(backends, 'opencode', 'hooks').state).toBe('unavailable')
    expect(backendCapability(backends, 'opencode', 'hooks').reasonKey).toBe('backend.capabilityUndeclared')
  })
})

describe('Codex account store', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useBackendStore.setState({
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
  })

  it('loads the Codex-owned account state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      }),
    }))

    await useBackendStore.getState().fetchCodexAccount()

    expect(useBackendStore.getState().codexAccount).toEqual({
      type: 'chatgpt',
      email: 'user@example.com',
      planType: 'plus',
    })
  })

  it('loads Codex account limits and token activity', async () => {
    const usage = {
      rateLimit: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        planType: 'plus',
        spendControlReached: false,
        rateLimitReachedType: null,
      },
      tokenUsage: {
        lifetimeTokens: '9007199254740993',
        peakDailyTokens: '4200',
        currentStreakDays: '3',
        longestStreakDays: '8',
        dailyUsageBuckets: [{ startDate: '2026-08-22', tokens: '1234' }],
      },
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => usage })
    vi.stubGlobal('fetch', fetchMock)

    await useBackendStore.getState().fetchCodexUsage()

    expect(fetchMock).toHaveBeenCalledWith('/api/backends/codex/usage')
    expect(useBackendStore.getState().codexUsage).toEqual(usage)
    expect(useBackendStore.getState().codexUsageError).toBeNull()
  })

  it('keeps usage failures separate from account state', async () => {
    useBackendStore.setState({
      codexAccount: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      codexAccountError: null,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Usage temporarily unavailable' }),
    }))

    await useBackendStore.getState().fetchCodexUsage()

    expect(useBackendStore.getState().codexAccount).not.toBeNull()
    expect(useBackendStore.getState().codexAccountError).toBeNull()
    expect(useBackendStore.getState().codexUsageError).toBe('Usage temporarily unavailable')
  })

  it('ignores usage that finishes after the account is cleared', async () => {
    let resolveUsage!: (response: Response) => void
    const usageResponse = new Promise<Response>((resolve) => { resolveUsage = resolve })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => usageResponse)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account: null, requiresOpenaiAuth: true }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const pendingUsage = useBackendStore.getState().fetchCodexUsage()
    await useBackendStore.getState().fetchCodexAccount()
    resolveUsage({
      ok: true,
      json: async () => ({ rateLimit: null, tokenUsage: { lifetimeTokens: '999' } }),
    } as Response)
    await pendingUsage

    expect(useBackendStore.getState().codexUsage).toBeNull()
    expect(useBackendStore.getState().codexUsageLoading).toBe(false)
  })

  it('sends an API key only in the login request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'apiKey' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await useBackendStore.getState().startCodexLogin('apiKey', 'sk-secret')

    expect(fetchMock).toHaveBeenCalledWith('/api/backends/codex/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'apiKey', apiKey: 'sk-secret' }),
    })
    expect(JSON.stringify(useBackendStore.getState())).not.toContain('sk-secret')
  })

  it('loads and updates the default model for new Codex sessions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'model-1', model: 'gpt-5.6-codex', displayName: 'GPT-5.6 Codex', hidden: false }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ model: 'gpt-5.6-codex', effort: 'high', speed: 'fast' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ model: null }) })
    vi.stubGlobal('fetch', fetchMock)

    await useBackendStore.getState().fetchCodexModels()
    expect(useBackendStore.getState().codexDefaultModel).toBe('gpt-5.6-codex')
    expect(useBackendStore.getState().codexDefaultEffort).toBe('high')
    expect(useBackendStore.getState().codexDefaultSpeed).toBe('fast')

    await useBackendStore.getState().setCodexDefaults({ model: null, effort: null, speed: null })
    expect(useBackendStore.getState().codexDefaultModel).toBeNull()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/backends/codex/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: null, effort: null, speed: null }),
    })
    expect(useBackendStore.getState().codexDefaultEffort).toBeNull()
    expect(useBackendStore.getState().codexDefaultSpeed).toBeNull()
  })

  it('waits for an in-flight defaults save before logging out', async () => {
    let resolveDefaults!: (response: Response) => void
    const defaultsResponse = new Promise<Response>((resolve) => { resolveDefaults = resolve })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => defaultsResponse)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const defaults = useBackendStore.getState().setCodexDefaults({
      model: 'gpt-5.6-codex',
      effort: 'high',
      speed: 'fast',
    })
    const logout = useBackendStore.getState().logoutCodex()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/backends/codex/defaults')

    resolveDefaults({ ok: true, json: async () => ({}) } as Response)
    await defaults
    await logout

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/backends/codex/logout')
  })
})
