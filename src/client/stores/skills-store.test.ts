import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSkillsStore } from './skills-store'

const originalFetch = global.fetch

function response(name: string): Response {
  return new Response(JSON.stringify({
    skills: [{
      id: name,
      name,
      slug: name,
      source: 'acme/skills',
      installSource: 'acme/skills',
      sourceKind: 'skills.sh',
      description: '',
      installs: 1,
    }],
    providers: [{ id: 'skills.sh', label: 'skills.sh', status: 'available' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const allProviders = [
  { id: 'skills.sh', label: 'skills.sh', status: 'available' },
  { id: 'skillshub', label: 'SkillsHub', status: 'available' },
] as const

function providerResponse(providers: unknown = allProviders): Response {
  return Response.json({ providers })
}

describe('useSkillsStore search', () => {
  beforeEach(() => {
    localStorage.clear()
    useSkillsStore.setState({
      searchResults: [],
      isSearching: false,
      error: null,
      searchProviders: [...allProviders],
      selectedSearchProviderIds: ['skills.sh', 'skillshub'],
      knownSearchProviderIds: ['skills.sh', 'skillshub'],
      newSearchProviderIds: [],
      checkingSearchProviderIds: [],
      isCheckingSearchProviders: false,
      searchProviderBlockReason: null,
      lastSearchIncompleteProviderIds: [],
      isSearchProviderPreferenceInitialized: true,
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('keeps the newest search result when an older request resolves last', async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    let firstSignal: AbortSignal | undefined
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('q=first')) {
        firstSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(response('second-result'))
    }) as typeof fetch

    const firstSearch = useSkillsStore.getState().search('first')
    const secondSearch = useSkillsStore.getState().search('second')
    await secondSearch
    resolveFirst?.(response('first-result'))
    await firstSearch

    expect(useSkillsStore.getState().searchResults.map((skill) => skill.name)).toEqual(['second-result'])
    expect(useSkillsStore.getState().isSearching).toBe(false)
    expect(firstSignal?.aborted).toBe(true)
  })

  it('serializes the unified structured filters into the search request', async () => {
    useSkillsStore.setState({
      searchProviders: [...allProviders],
      selectedSearchProviderIds: ['skills.sh', 'skillshub'],
      knownSearchProviderIds: ['skills.sh', 'skillshub'],
      isSearchProviderPreferenceInitialized: true,
    })
    let requestedUrl = ''
    global.fetch = vi.fn((input: string | URL | Request) => {
      requestedUrl = typeof input === 'string' ? input : input.toString()
      return Promise.resolve(response('review-result'))
    }) as typeof fetch

    await useSkillsStore.getState().search('review', {
      scene: 'development',
      preferChinese: true,
      noApiKey: true,
      sort: 'downloads',
    })

    const url = new URL(requestedUrl, 'http://localhost')
    expect(url.searchParams.get('q')).toBe('review')
    expect(url.searchParams.get('scene')).toBe('development')
    expect(url.searchParams.get('preferChinese')).toBe('true')
    expect(url.searchParams.get('noApiKey')).toBe('true')
    expect(url.searchParams.get('sort')).toBe('downloads')
    expect(url.searchParams.get('providers')).toBe('skills.sh,skillshub')
  })

  it('selects all providers on first check and persists the global preference', async () => {
    useSkillsStore.setState({
      searchProviders: [],
      selectedSearchProviderIds: [],
      knownSearchProviderIds: [],
      isSearchProviderPreferenceInitialized: false,
    })
    global.fetch = vi.fn(() => Promise.resolve(providerResponse())) as typeof fetch

    await useSkillsStore.getState().checkSearchProviders()

    expect(useSkillsStore.getState().selectedSearchProviderIds).toEqual(['skills.sh', 'skillshub'])
    expect(useSkillsStore.getState().newSearchProviderIds).toEqual([])
    expect(JSON.parse(localStorage.getItem('comate.skills.search-providers.v1') || '{}')).toEqual({
      version: 1,
      selectedProviderIds: ['skills.sh', 'skillshub'],
      knownProviderIds: ['skills.sh', 'skillshub'],
    })
  })

  it('restores an empty saved selection and auto-selects a newly discovered provider', async () => {
    localStorage.setItem('comate.skills.search-providers.v1', JSON.stringify({
      version: 1,
      selectedProviderIds: [],
      knownProviderIds: ['skills.sh'],
    }))
    useSkillsStore.setState({
      searchProviders: [],
      selectedSearchProviderIds: [],
      knownSearchProviderIds: [],
      isSearchProviderPreferenceInitialized: false,
    })
    global.fetch = vi.fn(() => Promise.resolve(providerResponse())) as typeof fetch

    await useSkillsStore.getState().checkSearchProviders()

    expect(useSkillsStore.getState().selectedSearchProviderIds).toEqual(['skillshub'])
    expect(useSkillsStore.getState().newSearchProviderIds).toEqual(['skillshub'])
  })

  it('falls back to all selected when persisted state is corrupt', async () => {
    localStorage.setItem('comate.skills.search-providers.v1', '{bad json')
    useSkillsStore.setState({
      searchProviders: [],
      selectedSearchProviderIds: [],
      knownSearchProviderIds: [],
      isSearchProviderPreferenceInitialized: false,
    })
    global.fetch = vi.fn(() => Promise.resolve(providerResponse())) as typeof fetch

    await useSkillsStore.getState().checkSearchProviders()

    expect(useSkillsStore.getState().selectedSearchProviderIds).toEqual(['skills.sh', 'skillshub'])
  })

  it('searches only selected available providers and records incomplete result coverage', async () => {
    useSkillsStore.setState({
      searchProviders: [
        allProviders[0],
        { ...allProviders[1], status: 'unavailable', reason: 'timeout' },
      ],
      selectedSearchProviderIds: ['skills.sh', 'skillshub'],
      knownSearchProviderIds: ['skills.sh', 'skillshub'],
      isSearchProviderPreferenceInitialized: true,
    })
    let requestedUrl = ''
    global.fetch = vi.fn((input: string | URL | Request) => {
      requestedUrl = String(input)
      return Promise.resolve(response('healthy-result'))
    }) as typeof fetch

    await useSkillsStore.getState().search('review')

    expect(new URL(requestedUrl, 'http://localhost').searchParams.get('providers')).toBe('skills.sh')
    expect(useSkillsStore.getState().lastSearchIncompleteProviderIds).toEqual(['skillshub'])
  })

  it('does not request search when no selected provider is available', async () => {
    useSkillsStore.setState({
      searchProviders: [{ ...allProviders[0], status: 'unavailable', reason: 'network' }],
      selectedSearchProviderIds: ['skills.sh'],
      knownSearchProviderIds: ['skills.sh'],
      isSearchProviderPreferenceInitialized: true,
    })
    global.fetch = vi.fn() as typeof fetch

    await useSkillsStore.getState().search('review')

    expect(global.fetch).not.toHaveBeenCalled()
    expect(useSkillsStore.getState().searchProviderBlockReason).toBe('no-available')
  })

  it('keeps the newer Retry result when an older all-provider check resolves last', async () => {
    useSkillsStore.setState({
      searchProviders: [...allProviders],
      selectedSearchProviderIds: ['skills.sh', 'skillshub'],
      knownSearchProviderIds: ['skills.sh', 'skillshub'],
      isSearchProviderPreferenceInitialized: true,
    })
    let resolveCheck: ((value: Response) => void) | undefined
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (!url.includes('provider=')) {
        return new Promise<Response>((resolve) => { resolveCheck = resolve })
      }
      return Promise.resolve(providerResponse([
        { id: 'skills.sh', label: 'skills.sh', status: 'available' },
      ]))
    }) as typeof fetch

    const check = useSkillsStore.getState().checkSearchProviders()
    const retry = useSkillsStore.getState().retrySearchProvider('skills.sh')
    await retry
    resolveCheck?.(providerResponse([
      { id: 'skills.sh', label: 'skills.sh', status: 'unavailable', reason: 'network' },
      allProviders[1],
    ]))
    await check

    expect(useSkillsStore.getState().searchProviders.find(({ id }) => id === 'skills.sh')?.status)
      .toBe('available')
  })
})
