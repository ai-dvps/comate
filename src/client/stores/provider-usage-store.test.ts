import {
  hasUsageSupport,
  providerUsageAgent,
  useProviderUsageStore,
} from './provider-usage-store'

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('useProviderUsageStore', () => {
  let calls: string[]

  beforeEach(() => {
    useProviderUsageStore.setState({ usageByProvider: {}, login: null })
    calls = []
    vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
    const mocked = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    mocked.mockImplementation((url: string) => Promise.resolve(handler(url)))
  }

  it('uses persisted preset provenance as the usage capability source', () => {
    expect(hasUsageSupport({ configuration: { preset: { id: 'kimi' } } })).toBe(true)
    expect(hasUsageSupport({ configuration: { preset: { id: 'bigmodel' } } })).toBe(true)
    expect(hasUsageSupport({ configuration: { preset: { id: 'custom' } } })).toBe(false)
  })

  it('selects an Agent that is available for the Provider', () => {
    expect(providerUsageAgent({ availability: { codex: { available: true } } })).toBe('codex')
    expect(providerUsageAgent({})).toBe('claude')
  })

  it('fetchUsage stores a ready summary', async () => {
    mockFetch((url) => {
      calls.push(url)
      return jsonRes({ status: 'ready', summary: { used: 3, total: 10, remaining: 7, resetDate: null, lastUpdated: 'x' } })
    })
    await useProviderUsageStore.getState().fetchUsage('p1')
    const st = useProviderUsageStore.getState().usageByProvider['p1']
    expect(st?.status).toBe('ready')
    expect(st?.summary?.used).toBe(3)
  })

  it('sends the selected Agent required by the Provider usage contract', async () => {
    const mocked = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    mocked.mockResolvedValue(jsonRes({ status: 'idle' }))

    await useProviderUsageStore.getState().fetchUsage('p1', { agent: 'codex' })

    expect(mocked).toHaveBeenCalledWith('/api/providers/p1/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'codex' }),
    })
  })

  it('fetchUsage throttles repeated calls within the window', async () => {
    mockFetch((url) => {
      calls.push(url)
      return jsonRes({ status: 'ready', summary: { used: 1, total: 2, remaining: 1, resetDate: null, lastUpdated: 'x' } })
    })
    await useProviderUsageStore.getState().fetchUsage('p1')
    await useProviderUsageStore.getState().fetchUsage('p1')
    expect(calls.length).toBe(1)
  })

  it('coalesces concurrent calls for the same Provider and Agent', async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    const mocked = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    mocked.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))

    const first = useProviderUsageStore.getState().fetchUsage('p1', { agent: 'codex' })
    const second = useProviderUsageStore.getState().fetchUsage('p1', { agent: 'codex' })
    expect(mocked).toHaveBeenCalledTimes(1)

    resolveResponse?.(jsonRes({ status: 'ready' }))
    await Promise.all([first, second])
  })

  it('fetchUsage force bypasses the throttle', async () => {
    mockFetch((url) => {
      calls.push(url)
      return jsonRes({ status: 'ready', summary: { used: 1, total: 2, remaining: 1, resetDate: null, lastUpdated: 'x' } })
    })
    await useProviderUsageStore.getState().fetchUsage('p1')
    await useProviderUsageStore.getState().fetchUsage('p1', { force: true })
    expect(calls.length).toBe(2)
  })

  it('fetchUsage surfaces error status on failure', async () => {
    mockFetch(() => Promise.reject(new Error('boom')) as unknown as Response)
    await useProviderUsageStore.getState().fetchUsage('p1')
    expect(useProviderUsageStore.getState().usageByProvider['p1']?.status).toBe('error')
  })

  it('startUsageLogin sets login ready with the sessionId', async () => {
    mockFetch((url) => {
      calls.push(url)
      return jsonRes({ sessionId: 'usage-login-p1' })
    })
    await useProviderUsageStore.getState().startUsageLogin('p1')
    const login = useProviderUsageStore.getState().login
    expect(login?.phase).toBe('ready')
    expect(login?.sessionId).toBe('usage-login-p1')
  })

  it('finalizeUsageLogin ready clears login and refetches usage', async () => {
    useProviderUsageStore.setState({
      login: { providerId: 'p1', sessionId: 'usage-login-p1', phase: 'ready', agent: 'claude' },
    })
    mockFetch((url) => {
      calls.push(url)
      if (url.endsWith('/finalize')) return jsonRes({ status: 'ready' })
      return jsonRes({ status: 'ready', summary: { used: 1, total: 2, remaining: 1, resetDate: null, lastUpdated: 'x' } })
    })
    await useProviderUsageStore.getState().finalizeUsageLogin()
    expect(useProviderUsageStore.getState().login).toBeNull()
    expect(useProviderUsageStore.getState().usageByProvider['p1']?.status).toBe('ready')
  })

  it('finalizeUsageLogin relogin sets phase failed', async () => {
    useProviderUsageStore.setState({
      login: { providerId: 'p1', sessionId: 'usage-login-p1', phase: 'ready', agent: 'claude' },
    })
    mockFetch(() => jsonRes({ status: 'relogin', reason: 'wrong-origin' }))
    await useProviderUsageStore.getState().finalizeUsageLogin()
    expect(useProviderUsageStore.getState().login?.phase).toBe('failed')
  })

  it('cancelUsageLogin clears login', async () => {
    useProviderUsageStore.setState({
      login: { providerId: 'p1', sessionId: 'usage-login-p1', phase: 'ready', agent: 'claude' },
    })
    mockFetch(() => jsonRes({ ok: true }))
    await useProviderUsageStore.getState().cancelUsageLogin()
    expect(useProviderUsageStore.getState().login).toBeNull()
  })
})
