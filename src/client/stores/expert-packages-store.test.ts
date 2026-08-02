import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExpertPackagesStore } from './expert-packages-store'

const originalFetch = global.fetch

function listResponse(slug: string): Response {
  return new Response(JSON.stringify({
    packages: [{
      slug,
      displayName: slug,
      summary: '',
      scene: 'tech',
      skillCount: 1,
      source: 'skillhub.cn',
    }],
    total: 1,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('useExpertPackagesStore', () => {
  beforeEach(() => useExpertPackagesStore.getState().reset())
  afterEach(() => { global.fetch = originalFetch })

  it('keeps the newest combined-filter list response', async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('keyword=first')) {
        return new Promise<Response>((resolve) => { resolveFirst = resolve })
      }
      return Promise.resolve(listResponse('second'))
    }) as typeof fetch

    const first = useExpertPackagesStore.getState().fetchPackages({ keyword: 'first', scene: 'tech' })
    const second = useExpertPackagesStore.getState().fetchPackages({ keyword: 'second', scene: 'tech' })
    await second
    resolveFirst?.(listResponse('first'))
    await first

    expect(useExpertPackagesStore.getState().packages.map((item) => item.slug)).toEqual(['second'])
  })

  it('caches package details by slug', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      package: {
        slug: 'test-pack', displayName: 'Test', summary: '', scene: 'tech', skillCount: 1,
        source: 'skillhub.cn', content: '# Test', children: [], complete: false,
      },
    }), { status: 200 }))) as typeof fetch

    await useExpertPackagesStore.getState().fetchPackage('test-pack')
    await useExpertPackagesStore.getState().fetchPackage('test-pack')
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps concurrent package details cached by their own slug', async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    const detailResponse = (slug: string) => new Response(JSON.stringify({
      package: {
        slug, displayName: slug, summary: '', scene: 'tech', skillCount: 1,
        source: 'skillhub.cn', content: `# ${slug}`, children: [], complete: false,
      },
    }), { status: 200 })
    global.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith('/first-pack')) {
        return new Promise<Response>((resolve) => { resolveFirst = resolve })
      }
      return Promise.resolve(detailResponse('second-pack'))
    }) as typeof fetch

    const first = useExpertPackagesStore.getState().fetchPackage('first-pack')
    const second = useExpertPackagesStore.getState().fetchPackage('second-pack')
    await second
    resolveFirst?.(detailResponse('first-pack'))
    await first

    expect(Object.keys(useExpertPackagesStore.getState().packageDetails).sort()).toEqual([
      'first-pack',
      'second-pack',
    ])
  })

  it('sends only the supplied failed item identities on retry', async () => {
    let requestBody: Record<string, unknown> = {}
    global.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }))
    }) as typeof fetch

    await useExpertPackagesStore.getState().installPackage({
      packageSlug: 'test-pack',
      scope: 'global',
      itemIds: ['skill:owner/failed'],
    })
    expect(requestBody.itemIds).toEqual(['skill:owner/failed'])
  })
})
