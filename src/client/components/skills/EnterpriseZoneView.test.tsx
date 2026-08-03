import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import enSettings from '../../i18n/en/settings.json'
import { useEnterpriseZoneStore } from '../../stores/enterprise-zone-store'
import EnterpriseZoneView from './EnterpriseZoneView'

const originalFetch = global.fetch

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { settings: enSettings } },
  })
})

function enterprise(index: number) {
  return {
    orgId: `org-${index}`,
    name: `Enterprise ${index}`,
    fullName: `Enterprise ${index} Limited`,
    description: `Enterprise ${index} description`,
    industryTags: ['technology'],
    publishedSkillCount: 1001,
    totalDownloads: 5000 + index,
  }
}

function skill(index: number) {
  return {
    namespace: 'enterprise',
    slug: `skill-${index}`,
    displayName: `Skill ${index}`,
    summary: `Skill ${index} summary`,
    downloads: 100 + index,
    stars: 10 + index,
    source: `skillhub-cn:enterprise/skill-${index}`,
  }
}

function page<T>(key: 'enterprises' | 'skills', items: T[], currentPage: number, total: number) {
  return Response.json({ [key]: items, page: currentPage, pageSize: 20, total })
}

describe('Enterprise Zone UI', () => {
  beforeEach(() => {
    useEnterpriseZoneStore.getState().reset()
    vi.clearAllMocks()
  })

  afterEach(() => { global.fetch = originalFetch })

  it('combines keyword and industry, resets to page one, and keeps industry when search clears', async () => {
    const requested: string[] = []
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({
        industries: [{ key: 'technology', displayName: 'Technology', sortOrder: 1 }],
      }))
      const currentPage = Number(new URL(url, 'http://localhost').searchParams.get('page'))
      return Promise.resolve(page('enterprises', [enterprise(1)], currentPage, 881))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen />)

    await screen.findByRole('button', { name: /Enterprise 1/ })
    await user.click(screen.getByRole('button', { name: 'Next enterprise page' }))
    await waitFor(() => expect(requested.some((url) => url.includes('/enterprises?page=2'))).toBe(true))
    await user.selectOptions(screen.getByLabelText('Filter enterprises by industry'), 'technology')
    await user.type(screen.getByLabelText('Search enterprises'), 'cloud')
    await waitFor(() => expect(requested.some((url) => (
      url.includes('page=1') && url.includes('keyword=cloud') && url.includes('industry=technology')
    ))).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Clear enterprise search' }))
    await waitFor(() => expect(requested.some((url) => (
      url.includes('industry=technology') && !url.includes('keyword=')
    ))).toBe(true))
    expect(screen.getByLabelText('Filter enterprises by industry')).toHaveValue('technology')
  })

  it('keeps the catalog usable when industries fail and retries only the filter resource', async () => {
    const requested: string[] = []
    let industryAttempts = 0
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/industries')) {
        industryAttempts += 1
        if (industryAttempts === 1) {
          return Promise.resolve(Response.json({ error: 'Industries unavailable' }, { status: 502 }))
        }
        return Promise.resolve(Response.json({ industries: [] }))
      }
      return Promise.resolve(page('enterprises', [enterprise(1)], 1, 1))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen />)

    expect(await screen.findByRole('button', { name: /Enterprise 1/ })).toBeEnabled()
    expect(screen.getByRole('status', { name: 'Industry filters unavailable' })).toHaveTextContent('Industries unavailable')
    const catalogRequests = requested.filter((url) => url.includes('/enterprises?')).length
    await user.click(screen.getByRole('button', { name: 'Retry industry filters' }))
    await waitFor(() => expect(industryAttempts).toBe(2))
    expect(requested.filter((url) => url.includes('/enterprises?'))).toHaveLength(catalogRequests)
  })

  it('opens an enterprise and combines Skill keyword, sort, and bounded pagination', async () => {
    const requested: string[] = []
    const onSelectSkill = vi.fn()
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({ industries: [] }))
      if (url.endsWith('/enterprises/org-1')) return Promise.resolve(Response.json({
        enterprise: { ...enterprise(1), totalStars: 321 },
      }))
      if (url.includes('/enterprises/org-1/skills?')) {
        const currentPage = Number(new URL(url, 'http://localhost').searchParams.get('page'))
        return Promise.resolve(page('skills', Array.from({ length: 20 }, (_, index) => skill(index + 1)), currentPage, 1001))
      }
      return Promise.resolve(page('enterprises', [enterprise(1)], 1, 881))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen onSelectSkill={onSelectSkill} />)

    await user.click(await screen.findByRole('button', { name: /Enterprise 1/ }))
    expect(await screen.findByRole('heading', { name: 'Enterprise 1' })).toBeInTheDocument()
    expect(screen.getByText('1,001 published Skills')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Skill \d+/ })).toHaveLength(20)

    await user.type(screen.getByLabelText('Search Enterprise Skills'), 'deploy')
    await user.selectOptions(screen.getByLabelText('Sort Enterprise Skills'), 'stars')
    await waitFor(() => expect(requested.some((url) => (
      url.includes('page=1') && url.includes('keyword=deploy') && url.includes('sort=stars')
    ))).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Next Skill page' }))
    await waitFor(() => expect(requested.some((url) => (
      url.includes('page=2') && url.includes('keyword=deploy') && url.includes('sort=stars')
    ))).toBe(true))
    expect(requested.filter((url) => url.includes('/skills?')).length).toBeLessThanOrEqual(4)

    await user.click(screen.getAllByRole('button', { name: /Skill \d+/ })[0])
    expect(onSelectSkill).toHaveBeenCalledWith('org-1', 'enterprise', expect.stringMatching(/^skill-/))
  })

  it('distinguishes catalog and filtered empty states at both levels', async () => {
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({ industries: [] }))
      return Promise.resolve(page('enterprises', [], 1, 0))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen />)

    await waitFor(() => expect(useEnterpriseZoneStore.getState().enterprisePage).not.toBeNull())
    expect(screen.getByText('No enterprises are available yet.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search enterprises'), 'missing')
    expect(await screen.findByText('No enterprises match your filters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear enterprise filters' })).toBeInTheDocument()
  })

  it('distinguishes an enterprise with no Skills from a filtered Skill result', async () => {
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({ industries: [] }))
      if (url.endsWith('/enterprises/org-1')) return Promise.resolve(Response.json({
        enterprise: { ...enterprise(1), publishedSkillCount: 0, totalStars: 0 },
      }))
      if (url.includes('/enterprises/org-1/skills?')) return Promise.resolve(page('skills', [], 1, 0))
      return Promise.resolve(page('enterprises', [enterprise(1)], 1, 1))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen />)
    await user.click(await screen.findByRole('button', { name: /Enterprise 1/ }))

    expect(await screen.findByText('This enterprise has not published any Skills yet.')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Sort Enterprise Skills'), 'latest')
    await user.type(screen.getByLabelText('Search Enterprise Skills'), 'missing')
    expect(await screen.findByText('No Skills match your search.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear Skill filters' }))
    expect(screen.getByLabelText('Sort Enterprise Skills')).toHaveValue('latest')
  })

  it('offers scoped retry for an initial enterprise catalog failure', async () => {
    let enterpriseAttempts = 0
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({ industries: [] }))
      enterpriseAttempts += 1
      if (enterpriseAttempts === 1) return Promise.resolve(Response.json({ error: 'Catalog unavailable' }, { status: 502 }))
      return Promise.resolve(page('enterprises', [enterprise(1)], 1, 1))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen />)
    expect(await screen.findByText('Enterprise catalog could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry enterprises' }))
    expect(await screen.findByRole('button', { name: /Enterprise 1/ })).toBeEnabled()
    expect(enterpriseAttempts).toBe(2)
  })

  it('offers Retry and Back when the enterprise Skill list fails', async () => {
    let skillAttempts = 0
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({ industries: [] }))
      if (url.endsWith('/enterprises/org-1')) return Promise.resolve(Response.json({
        enterprise: { ...enterprise(1), totalStars: 5 },
      }))
      if (url.includes('/enterprises/org-1/skills?')) {
        skillAttempts += 1
        return Promise.resolve(Response.json({ error: 'Skills unavailable' }, { status: 404 }))
      }
      return Promise.resolve(page('enterprises', [enterprise(1)], 1, 1))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<EnterpriseZoneView active isOpen />)
    await user.click(await screen.findByRole('button', { name: /Enterprise 1/ }))
    expect(await screen.findByText('Enterprise Skills could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to enterprises' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry Skills' }))
    await waitFor(() => expect(skillAttempts).toBe(2))
  })

  it('restores enterprise list controls, page, scroll, and selected focus after Back', async () => {
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/industries')) return Promise.resolve(Response.json({
        industries: [{ key: 'technology', displayName: 'Technology', sortOrder: 1 }],
      }))
      if (url.endsWith('/enterprises/org-1')) return Promise.resolve(Response.json({
        enterprise: { ...enterprise(1), totalStars: 5 },
      }))
      if (url.includes('/enterprises/org-1/skills?')) return Promise.resolve(page('skills', [], 1, 0))
      const currentPage = Number(new URL(url, 'http://localhost').searchParams.get('page'))
      return Promise.resolve(page('enterprises', [enterprise(1)], currentPage, 881))
    }) as typeof fetch

    const user = userEvent.setup()
    render(<div data-testid="scroll-container"><EnterpriseZoneView active isOpen /></div>)

    await user.type(screen.getByLabelText('Search enterprises'), 'cloud')
    await user.selectOptions(screen.getByLabelText('Filter enterprises by industry'), 'technology')
    await user.click(screen.getByRole('button', { name: 'Next enterprise page' }))
    await screen.findByText('Page 2 of 45')
    const scrollContainer = screen.getByTestId('scroll-container')
    scrollContainer.scrollTop = 420
    await user.click(await screen.findByRole('button', { name: /Enterprise 1/ }))
    scrollContainer.scrollTop = 0
    await user.click(await screen.findByRole('button', { name: 'Back to enterprises' }))

    expect(screen.getByLabelText('Search enterprises')).toHaveValue('cloud')
    expect(screen.getByLabelText('Filter enterprises by industry')).toHaveValue('technology')
    expect(screen.getByText('Page 2 of 45')).toBeInTheDocument()
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(420))
    await waitFor(() => expect(within(scrollContainer).getByRole('button', { name: /Enterprise 1/ })).toHaveFocus())
  })

  it('preserves view state across tab switches and resets it when the Skills panel closes', async () => {
    global.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith('/industries')) return Promise.resolve(Response.json({ industries: [] }))
      return Promise.resolve(page('enterprises', [enterprise(1)], 1, 1))
    }) as typeof fetch

    const user = userEvent.setup()
    const { rerender } = render(<EnterpriseZoneView active isOpen />)
    await user.type(screen.getByLabelText('Search enterprises'), 'cloud')

    rerender(<EnterpriseZoneView active={false} isOpen />)
    expect(screen.getByLabelText('Search enterprises')).toHaveValue('cloud')

    rerender(<EnterpriseZoneView active={false} isOpen={false} />)
    await waitFor(() => expect(screen.getByLabelText('Search enterprises')).toHaveValue(''))
    expect(useEnterpriseZoneStore.getState().enterprisePage).toBeNull()
  })
})
