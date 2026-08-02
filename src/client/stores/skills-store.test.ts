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
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('useSkillsStore search', () => {
  beforeEach(() => {
    useSkillsStore.setState({ searchResults: [], isSearching: false, error: null })
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
  })
})
