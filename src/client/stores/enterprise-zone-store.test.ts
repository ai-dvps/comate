import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEnterpriseZoneStore } from './enterprise-zone-store'

const originalFetch = global.fetch

function enterprise(orgId: string) {
  return {
    orgId,
    name: orgId,
    description: `${orgId} description`,
    industryTags: ['technology'],
    publishedSkillCount: 1,
    totalDownloads: 10,
  }
}

function skill(slug: string) {
  return {
    namespace: 'acme',
    slug,
    displayName: slug,
    summary: `${slug} summary`,
    downloads: 10,
    stars: 2,
    source: 'skillhub.cn',
  }
}

function enterprisePage(orgId: string, page = 1): Response {
  return Response.json({ enterprises: [enterprise(orgId)], page, pageSize: 20, total: 25 })
}

function skillPage(slug: string, page = 1): Response {
  return Response.json({ skills: [skill(slug)], page, pageSize: 20, total: 25 })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

describe('useEnterpriseZoneStore', () => {
  beforeEach(() => useEnterpriseZoneStore.getState().reset())
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('serializes a fixed-size combined enterprise query and keeps only the latest response', async () => {
    const firstResponse = deferredResponse()
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('keyword=first')) return firstResponse.promise
      return Promise.resolve(enterprisePage('org-second'))
    }) as typeof fetch

    const first = useEnterpriseZoneStore.getState().fetchEnterprises({
      keyword: ' first ', industry: 'software_services', page: 1,
    })
    const second = useEnterpriseZoneStore.getState().fetchEnterprises({
      keyword: 'second', industry: 'software_services', page: 1,
    })
    await second
    firstResponse.resolve(enterprisePage('org-first'))
    await first

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      '/api/skills/enterprise-zone/enterprises?page=1&pageSize=20&keyword=first&industry=software_services',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(useEnterpriseZoneStore.getState().enterprisePage?.enterprises[0].orgId).toBe('org-second')
  })

  it('serializes a fixed-size Skill query and keeps only the latest keyword and sort response', async () => {
    const firstResponse = deferredResponse()
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('keyword=first')) return firstResponse.promise
      return Promise.resolve(skillPage('second'))
    }) as typeof fetch

    const first = useEnterpriseZoneStore.getState().fetchEnterpriseSkills('org-acme', {
      keyword: ' first ', sort: 'downloads', page: 1,
    })
    const second = useEnterpriseZoneStore.getState().fetchEnterpriseSkills('org-acme', {
      keyword: 'second', sort: 'latest', page: 1,
    })
    await second
    firstResponse.resolve(skillPage('first'))
    await first

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      '/api/skills/enterprise-zone/enterprises/org-acme/skills?page=1&pageSize=20&keyword=second&sort=latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(useEnterpriseZoneStore.getState().skillPage?.skills[0].slug).toBe('second')
  })

  it('retains the last valid page and page identity when a later-page request fails', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(enterprisePage('org-page-one', 1))
      .mockResolvedValueOnce(Response.json({ error: 'Page unavailable' }, { status: 502 })) as typeof fetch

    await useEnterpriseZoneStore.getState().fetchEnterprises({ page: 1 })
    await useEnterpriseZoneStore.getState().fetchEnterprises({ page: 2 })

    const state = useEnterpriseZoneStore.getState()
    expect(state.enterprisePage?.page).toBe(1)
    expect(state.enterprisePage?.enterprises[0].orgId).toBe('org-page-one')
    expect(state.enterprisesError).toBe('Page unavailable')
    expect(state.isLoadingEnterprises).toBe(false)
  })

  it('isolates industry failure from the enterprise page and replaces only its error on retry', async () => {
    global.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith('/industries')) {
        return Promise.resolve(Response.json({ error: 'Tags unavailable' }, { status: 502 }))
      }
      return Promise.resolve(enterprisePage('org-acme'))
    }) as typeof fetch

    await Promise.all([
      useEnterpriseZoneStore.getState().fetchIndustries(),
      useEnterpriseZoneStore.getState().fetchEnterprises(),
    ])
    expect(useEnterpriseZoneStore.getState().industriesError).toBe('Tags unavailable')
    expect(useEnterpriseZoneStore.getState().enterprisePage?.enterprises[0].orgId).toBe('org-acme')

    global.fetch = vi.fn(() => Promise.resolve(Response.json({
      industries: [{ key: 'technology', displayName: 'Technology', sortOrder: 1 }],
    }))) as typeof fetch
    await useEnterpriseZoneStore.getState().fetchIndustries()

    const state = useEnterpriseZoneStore.getState()
    expect(state.industriesError).toBeNull()
    expect(state.industries).toHaveLength(1)
    expect(state.enterprisePage?.enterprises[0].orgId).toBe('org-acme')
  })

  it('prevents a slow enterprise A detail from overwriting enterprise B', async () => {
    const firstResponse = deferredResponse()
    global.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith('/org-a')) return firstResponse.promise
      return Promise.resolve(Response.json({ enterprise: { ...enterprise('org-b'), totalStars: 5 } }))
    }) as typeof fetch

    const first = useEnterpriseZoneStore.getState().fetchEnterprise('org-a')
    const second = useEnterpriseZoneStore.getState().fetchEnterprise('org-b')
    await second
    firstResponse.resolve(Response.json({ enterprise: { ...enterprise('org-a'), totalStars: 1 } }))
    await first

    const state = useEnterpriseZoneStore.getState()
    expect(state.activeEnterpriseOrgId).toBe('org-b')
    expect(state.enterpriseDetail?.orgId).toBe('org-b')
  })

  it('keys Skill authorization by enterprise and coordinate', async () => {
    const firstResponse = deferredResponse()
    const detail = (orgId: string) => Response.json({ skill: {
      ...skill('deploy'),
      publisher: { orgId },
      category: 'devops', owner: { handle: 'acme', displayName: 'Acme' },
      version: '1.0.0', stats: { downloads: 10, installs: 3 }, securityReports: [],
    } })
    global.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).includes('/org-a/')) return firstResponse.promise
      return Promise.resolve(detail('org-b'))
    }) as typeof fetch

    const first = useEnterpriseZoneStore.getState().fetchEnterpriseSkill('org-a', 'acme', 'deploy')
    const second = useEnterpriseZoneStore.getState().fetchEnterpriseSkill('org-b', 'acme', 'deploy')
    await second
    firstResponse.resolve(detail('org-a'))
    await first

    const state = useEnterpriseZoneStore.getState()
    expect(state.activeSkillKey).toBe('org-b:acme/deploy')
    expect(state.skillDetail?.publisher?.orgId).toBe('org-b')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('retains only the active enterprise and Skill detail chain', async () => {
    global.fetch = vi.fn((input: string | URL | Request) => {
      const parts = String(input).split('/')
      if (/\/enterprises\/[^/]+\/skills\//.test(String(input))) {
        const orgId = parts.at(-4)!
        const namespace = parts.at(-2)!
        const slug = parts.at(-1)!
        return Promise.resolve(Response.json({ skill: {
          ...skill(slug), namespace, publisher: { orgId }, category: '',
          owner: { handle: namespace, displayName: namespace }, version: '1',
          stats: { downloads: 1, installs: 1 }, securityReports: [],
        } }))
      }
      const orgId = parts.at(-1)!
      return Promise.resolve(Response.json({ enterprise: { ...enterprise(orgId), totalStars: 1 } }))
    }) as typeof fetch

    for (let index = 0; index < 12; index += 1) {
      const orgId = `org-${index}`
      await useEnterpriseZoneStore.getState().fetchEnterprise(orgId)
      await useEnterpriseZoneStore.getState().fetchEnterpriseSkill(orgId, 'acme', `skill-${index}`)
    }

    const state = useEnterpriseZoneStore.getState()
    expect(state.enterpriseDetail?.orgId).toBe('org-11')
    expect(state.activeSkillKey).toBe('org-11:acme/skill-11')
    expect(state.skillDetail?.slug).toBe('skill-11')
    expect(state).not.toHaveProperty('enterpriseDetails')
    expect(state).not.toHaveProperty('skillDetails')
  })

  it('invalidates every pending response on reset', async () => {
    const responses = Array.from({ length: 5 }, deferredResponse)
    global.fetch = vi.fn()
      .mockImplementationOnce(() => responses[0].promise)
      .mockImplementationOnce(() => responses[1].promise)
      .mockImplementationOnce(() => responses[2].promise)
      .mockImplementationOnce(() => responses[3].promise)
      .mockImplementationOnce(() => responses[4].promise) as typeof fetch

    const pending = [
      useEnterpriseZoneStore.getState().fetchIndustries(),
      useEnterpriseZoneStore.getState().fetchEnterprises(),
      useEnterpriseZoneStore.getState().fetchEnterprise('org-acme'),
      useEnterpriseZoneStore.getState().fetchEnterpriseSkills('org-acme'),
      useEnterpriseZoneStore.getState().fetchEnterpriseSkill('org-acme', 'acme', 'deploy'),
    ]
    useEnterpriseZoneStore.getState().reset()

    responses[0].resolve(Response.json({ industries: [{ key: 'tech', displayName: 'Tech', sortOrder: 1 }] }))
    responses[1].resolve(enterprisePage('org-acme'))
    responses[2].resolve(Response.json({ enterprise: { ...enterprise('org-acme'), totalStars: 1 } }))
    responses[3].resolve(skillPage('deploy'))
    responses[4].resolve(Response.json({ skill: {
      ...skill('deploy'), category: '', owner: { handle: 'acme', displayName: 'Acme' }, version: '1',
      stats: { downloads: 1, installs: 1 }, securityReports: [], publisher: { orgId: 'org-acme' },
    } }))
    await Promise.all(pending)

    const state = useEnterpriseZoneStore.getState()
    expect(state.industries).toEqual([])
    expect(state.enterprisePage).toBeNull()
    expect(state.enterpriseDetail).toBeNull()
    expect(state.skillPage).toBeNull()
    expect(state.skillDetail).toBeNull()
    expect(state.isLoadingIndustries).toBe(false)
    expect(state.isLoadingEnterprises).toBe(false)
    expect(state.isLoadingEnterprise).toBe(false)
    expect(state.isLoadingSkills).toBe(false)
    expect(state.isLoadingSkill).toBe(false)
  })

  it('uses scoped fallback errors and preserves valid Skill page data during refresh failure', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(skillPage('stable'))
      .mockResolvedValueOnce(new Response('not json', { status: 502 })) as typeof fetch

    await useEnterpriseZoneStore.getState().fetchEnterpriseSkills('org-acme', { page: 1 })
    await useEnterpriseZoneStore.getState().fetchEnterpriseSkills('org-acme', { page: 2 })

    const state = useEnterpriseZoneStore.getState()
    expect(state.skillPage?.page).toBe(1)
    expect(state.skillPage?.skills[0].slug).toBe('stable')
    expect(state.skillsError).toBe('Failed to load Enterprise Skills')
  })
})
