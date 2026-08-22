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
      analytics: { state: 'unavailable', reasonKey: 'backend.analyticsNotCounted' },
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
    expect(backendCapability(backends, 'opencode', 'analytics').state).toBe('unavailable')
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
})
