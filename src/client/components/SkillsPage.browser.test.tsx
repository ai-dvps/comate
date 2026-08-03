import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { useEnterpriseZoneStore } from '../stores/enterprise-zone-store'
import { useExpertPackagesStore } from '../stores/expert-packages-store'
import { useSkillsStore } from '../stores/skills-store'
import SkillsPage from './SkillsPage'

const packageSummary = {
  slug: 'tech-test-automation',
  displayName: 'Automation Expert',
  summary: 'A complete testing workflow',
  scene: 'tech',
  subScene: 'test-automation',
  skillCount: 1,
  source: 'skillhub.cn',
}

const healthyProviders = [
  { id: 'skills.sh', label: 'skills.sh', status: 'available' },
  { id: 'skillshub', label: 'SkillsHub', status: 'available' },
  { id: 'xfyun', label: 'iFlytek SkillHub', status: 'available' },
  { id: 'skillhub-cn', label: 'Tencent SkillHub', status: 'available' },
  { id: 'weskillhub', label: 'WeSkillHub', status: 'available' },
]

function isProviderHealthUrl(url: string): boolean {
  return url.includes('/api/skills/search/providers')
}

function installFetch(installed: unknown[] = []): ReturnType<typeof vi.fn> {
  return vi.fn((input: string | URL | Request) => {
    const url = String(input)
    if (isProviderHealthUrl(url)) return Promise.resolve(Response.json({ providers: healthyProviders }))
    if (url.includes('/api/skills/installed')) return Promise.resolve(Response.json({ skills: installed }))
    if (url.includes('/expert-packages/tech-test-automation/skills/owner/child-skill')) {
      return Promise.resolve(Response.json({ skill: {
        namespace: 'owner',
        slug: 'child-skill',
        displayName: 'Child Skill',
        summary: 'Child summary',
        category: 'tech',
        owner: { handle: 'owner', displayName: 'Owner' },
        version: '1.0.0',
        stats: { downloads: 12, installs: 3 },
        securityReports: [],
        documentation: '# Child documentation',
        source: 'skillhub-cn:owner/child-skill',
      } }))
    }
    if (url.endsWith('/expert-packages/tech-test-automation')) {
      return Promise.resolve(Response.json({ package: {
        ...packageSummary,
        content: '# Workflow',
        complete: true,
        children: [{
          namespace: 'owner',
          slug: 'child-skill',
          displayName: 'Child Skill',
          summary: 'Child summary',
          available: true,
          source: 'skillhub-cn:owner/child-skill',
          securityReports: [],
        }],
      } }))
    }
    if (url.includes('/api/skills/expert-packages?')) {
      return Promise.resolve(Response.json({ packages: [packageSummary], total: 1 }))
    }
    if (url.endsWith('/api/skills/resolve')) {
      return Promise.resolve(Response.json({ skills: [
        { name: 'child-skill', description: 'Child summary', skillPath: 'SKILL.md' },
      ] }))
    }
    if (url.endsWith('/api/skills/install')) {
      return Promise.resolve(Response.json({ results: [
        { skillName: 'child-skill', status: 'installed' },
      ] }, { status: 201 }))
    }
    return Promise.resolve(new Response('', { status: 404 }))
  })
}

function enterpriseInstallFetch(): ReturnType<typeof vi.fn> {
  let enterpriseSkillInstalled = false
  return vi.fn((input: string | URL | Request) => {
    const url = String(input)
    if (isProviderHealthUrl(url)) return Promise.resolve(Response.json({ providers: healthyProviders }))
    if (url.includes('/api/skills/installed')) return Promise.resolve(Response.json({ skills: enterpriseSkillInstalled ? [{
      name: 'enterprise-skill',
      kind: 'skill',
      scope: 'project',
      source: 'skillhub-cn:enterprise/enterprise-skill',
      installPath: '/skills/enterprise-skill',
      isLegacySymlink: false,
      description: 'Enterprise Skill summary',
    }] : [] }))
    if (url.endsWith('/enterprise-zone/industries')) return Promise.resolve(Response.json({ industries: [] }))
    if (url.endsWith('/enterprise-zone/enterprises/org-1')) return Promise.resolve(Response.json({ enterprise: {
      orgId: 'org-1', name: 'Acme Enterprise', description: 'Acme description', industryTags: [],
      publishedSkillCount: 1, totalDownloads: 20, totalStars: 4,
    } }))
    if (url.includes('/enterprise-zone/enterprises/org-1/skills?')) return Promise.resolve(Response.json({
      skills: [{ namespace: 'enterprise', slug: 'enterprise-skill', displayName: 'Enterprise Skill', summary: 'Enterprise Skill summary', downloads: 20, stars: 4, source: 'skillhub-cn:enterprise/enterprise-skill' }],
      page: 1, pageSize: 20, total: 1,
    }))
    if (url.endsWith('/enterprise-zone/enterprises/org-1/skills/enterprise/enterprise-skill')) return Promise.resolve(Response.json({ skill: {
      namespace: 'enterprise', slug: 'enterprise-skill', displayName: 'Enterprise Skill', summary: 'Enterprise Skill summary', category: 'productivity',
      owner: { handle: 'owner', displayName: 'Skill Owner' }, publisher: { orgId: 'org-1' }, version: '1.0.0',
      stats: { downloads: 20, installs: 3 }, securityReports: [], documentation: '# Enterprise documentation', source: 'skillhub-cn:enterprise/enterprise-skill',
    } }))
    if (url.includes('/enterprise-zone/enterprises?')) return Promise.resolve(Response.json({
      enterprises: [
        { orgId: 'org-1', name: 'Acme Enterprise', description: 'Acme description', industryTags: [], publishedSkillCount: 1, totalDownloads: 20 },
        { orgId: 'org-2', name: 'Beacon Enterprise', description: 'Beacon description', industryTags: [], publishedSkillCount: 2, totalDownloads: 40 },
      ],
      page: 1, pageSize: 20, total: 2,
    }))
    if (url.endsWith('/api/skills/resolve')) return Promise.resolve(Response.json({ skills: [
      { name: 'enterprise-skill', description: 'Enterprise Skill summary', skillPath: 'SKILL.md' },
    ] }))
    if (url.endsWith('/api/skills/install')) {
      enterpriseSkillInstalled = true
      return Promise.resolve(Response.json({ results: [{ skillName: 'enterprise-skill', status: 'installed' }] }, { status: 201 }))
    }
    if (url.includes('/api/skills/expert-packages?')) return Promise.resolve(Response.json({ packages: [], total: 0 }))
    return Promise.resolve(new Response('', { status: 404 }))
  })
}

function weskillhubInstallFetch(): ReturnType<typeof vi.fn> {
  let installed = false
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (isProviderHealthUrl(url)) return Promise.resolve(Response.json({ providers: healthyProviders }))
    if (url.includes('/api/skills/installed')) return Promise.resolve(Response.json({ skills: installed ? [{
      name: 'todo',
      kind: 'skill',
      scope: 'project',
      source: 'weskillhub:116/weoa-todo',
      installPath: '/skills/todo',
      isLegacySymlink: false,
      description: 'Manage WeCom tasks',
    }] : [] }))
    if (url.includes('/api/skills/search?')) return Promise.resolve(Response.json({ skills: [{
      id: 'weskillhub:116/weoa-todo',
      name: 'todo',
      slug: 'weoa-todo',
      source: 'WeSkillHub / weoa-todo',
      installSource: 'weskillhub:116/weoa-todo',
      sourceKind: 'weskillhub',
      description: 'Manage WeCom tasks',
      installs: 321,
    }], providers: healthyProviders }))
    if (url.endsWith('/api/skills/resolve')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        source: 'weskillhub:116/weoa-todo',
        workspaceId: 'ws-1',
      })
      return Promise.resolve(Response.json({ skills: [
        { name: 'todo', description: 'Manage WeCom tasks', skillPath: 'SKILL.md' },
      ] }))
    }
    if (url.endsWith('/api/skills/install')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        source: 'weskillhub:116/weoa-todo',
        skills: ['todo'],
        scope: 'project',
        workspaceId: 'ws-1',
      })
      installed = true
      return Promise.resolve(Response.json({ results: [
        { skillName: 'todo', status: 'installed' },
      ] }, { status: 201 }))
    }
    if (url.includes('/api/skills/expert-packages?')) return Promise.resolve(Response.json({ packages: [], total: 0 }))
    if (url.endsWith('/enterprise-zone/industries')) return Promise.resolve(Response.json({ industries: [] }))
    return Promise.resolve(new Response('', { status: 404 }))
  })
}

describe('SkillsPage Expert Packages browser flow', () => {
  beforeEach(async () => {
    cleanup()
    await page.viewport(1280, 900)
    await i18n.changeLanguage('en')
    useExpertPackagesStore.getState().reset()
    useEnterpriseZoneStore.getState().reset()
    useSkillsStore.setState({
      installed: [],
      discovered: [],
      isFetchingInstalled: false,
      error: null,
      searchProviders: [],
      selectedSearchProviderIds: [],
      knownSearchProviderIds: [],
      newSearchProviderIds: [],
      checkingSearchProviderIds: [],
      isCheckingSearchProviders: false,
      isSearchProviderPreferenceInitialized: false,
      searchProviderBlockReason: 'checking',
      lastSearchIncompleteProviderIds: [],
    })
    localStorage.removeItem('comate.skills.search-providers.v1')
    localStorage.removeItem('comate.skills.search-view-mode')
    localStorage.removeItem('comate.expert-packages.view-mode')
    localStorage.removeItem('comate.enterprise-zone.view-mode')
    window.fetch = installFetch() as typeof fetch
  })

  it('exposes Enterprise Zone as a peer tab and hides Add from URL there', async () => {
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    const tabList = screen.getByRole('tablist', { name: 'Skills sections' })
    expect(within(tabList).getAllByRole('tab')).toHaveLength(4)
    const enterpriseTab = within(tabList).getByRole('tab', { name: 'Enterprise Zone' })
    expect(enterpriseTab).toHaveAttribute('aria-selected', 'false')

    within(tabList).getByRole('tab', { name: 'Installed' }).focus()
    await userEvent.keyboard('{End}')
    expect(enterpriseTab).toHaveAttribute('aria-selected', 'true')
    expect(enterpriseTab).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Add from URL' })).not.toBeInTheDocument()
    expect(await screen.findByRole('textbox', { name: 'Search enterprises' })).toBeVisible()
  })

  it('switches the Enterprise catalog between card and list layouts', async () => {
    window.fetch = enterpriseInstallFetch() as typeof fetch
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    await userEvent.click(await screen.findByRole('tab', { name: 'Enterprise Zone' }))
    const acme = await screen.findByRole('button', { name: /Acme Enterprise/ })
    const beacon = await screen.findByRole('button', { name: /Beacon Enterprise/ })
    expect(Math.round(acme.getBoundingClientRect().top)).toBe(Math.round(beacon.getBoundingClientRect().top))
    expect(Math.round(acme.getBoundingClientRect().left)).not.toBe(Math.round(beacon.getBoundingClientRect().left))

    await userEvent.click(screen.getByRole('button', { name: 'Enterprise list view' }))
    await waitFor(() => {
      const listAcme = screen.getByRole('button', { name: /Acme Enterprise/ })
      const listBeacon = screen.getByRole('button', { name: /Beacon Enterprise/ })
      expect(screen.getByRole('button', { name: 'Enterprise list view' })).toHaveAttribute('aria-pressed', 'true')
      expect(listAcme.parentElement).toBe(listBeacon.parentElement)
      expect(listAcme.parentElement).toHaveClass('grid-cols-1')
      expect(listAcme.parentElement).not.toHaveClass('md:grid-cols-2')
    })
    expect(localStorage.getItem('comate.enterprise-zone.view-mode')).toBe('list')
  })

  it('uses the generic WeSkillHub search-to-install flow with localized five-provider guidance', async () => {
    window.fetch = weskillhubInstallFetch() as typeof fetch
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    const tabList = screen.getByRole('tablist', { name: 'Skills sections' })
    expect(within(tabList).getByRole('tab', { name: 'Expert Packages' })).toBeVisible()
    expect(within(tabList).getByRole('tab', { name: 'Enterprise Zone' })).toBeVisible()
    await userEvent.click(within(tabList).getByRole('tab', { name: 'Search' }))
    await userEvent.type(screen.getByLabelText('Find skills for the work at hand'), 'todo')

    const resultName = await screen.findByRole('heading', { name: 'todo' })
    const resultCard = resultName.closest<HTMLElement>('div.group')
    expect(resultCard).not.toBeNull()
    expect(resultCard!).toHaveTextContent('Manage WeCom tasks')
    expect(resultCard!).toHaveTextContent('WeSkillHub / weoa-todo')
    expect(resultCard!).toHaveTextContent('from weskillhub')
    expect(resultCard!).toHaveTextContent('321 installs')

    await userEvent.click(within(resultCard!).getByRole('button', { name: 'Install' }))
    const dialog = await screen.findByRole('dialog', { name: 'Install skill' })
    expect(dialog).toHaveTextContent('weskillhub:116/weoa-todo')
    expect(within(dialog).getByRole('button', { name: /Project.*Shared with collaborators/ })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /Global.*Available in all your workspaces/ })).toBeVisible()
    await userEvent.click(within(dialog).getByRole('button', { name: /todo.*Manage WeCom tasks/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: /Project.*Shared with collaborators/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }))

    await waitFor(
      () => expect(useSkillsStore.getState().installed).toContainEqual(expect.objectContaining({
        name: 'todo', source: 'weskillhub:116/weoa-todo', scope: 'project',
      })),
      { timeout: 2500 },
    )
    expect(within(resultCard!).getByRole('button', { name: 'Already installed' })).toBeDisabled()

    await userEvent.click(within(tabList).getByRole('tab', { name: 'Installed' }))
    expect(await screen.findByText('Manage WeCom tasks')).toBeInTheDocument()
    const providers = ['skills.sh', 'SkillsHub', 'iFlytek SkillHub', 'Tencent SkillHub', 'WeSkillHub']
    const englishHint = i18n.t('settings:skills.searchHint')
    providers.forEach((provider) => expect(englishHint).toContain(provider))

    await i18n.changeLanguage('zh-CN')
    const chineseHint = i18n.t('settings:skills.searchHint')
    ;['skills.sh', 'SkillsHub', '讯飞 SkillHub', '腾讯 SkillHub', 'WeSkillHub'].forEach((provider) => {
      expect(chineseHint).toContain(provider)
    })
  })

  it('filters providers, explains partial results, and retries an unavailable provider', async () => {
    let retryHealthy = false
    window.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/api/skills/installed')) return Promise.resolve(Response.json({ skills: [] }))
      if (url.includes('/api/skills/search/providers?provider=skillshub')) {
        retryHealthy = true
        return Promise.resolve(Response.json({ providers: [
          { id: 'skillshub', label: 'SkillsHub', status: 'available' },
        ] }))
      }
      if (isProviderHealthUrl(url)) return Promise.resolve(Response.json({ providers: [
        { id: 'skills.sh', label: 'skills.sh', status: 'available' },
        { id: 'skillshub', label: 'SkillsHub', status: 'unavailable', reason: 'timeout' },
      ] }))
      if (url.includes('/api/skills/search?')) return Promise.resolve(Response.json({
        skills: [{
          id: 'skills.sh:review', name: 'review', slug: 'review', source: 'acme/review',
          installSource: 'acme/review', sourceKind: 'skills.sh', description: 'Review changes', installs: 5,
        }],
        providers: [{ id: 'skills.sh', label: 'skills.sh', status: 'available' }],
      }))
      return Promise.resolve(new Response('', { status: 404 }))
    }) as typeof fetch

    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }))
    expect(await screen.findByRole('button', { name: 'Providers, 2 of 2 selected' })).toBeVisible()

    await userEvent.type(screen.getByLabelText('Find skills for the work at hand'), 'review')
    expect(await screen.findByRole('heading', { name: 'review' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Results may be incomplete because SkillsHub is unavailable.')

    await userEvent.click(screen.getByRole('button', { name: 'Providers, 2 of 2 selected' }))
    const providerFilter = screen.getByRole('group', { name: 'Search providers' })
    expect(within(providerFilter).getByRole('checkbox', { name: /SkillsHub/ })).toBeChecked()
    expect(providerFilter).toHaveTextContent('Timed out')
    await userEvent.click(within(providerFilter).getByRole('button', { name: 'Retry SkillsHub' }))
    await waitFor(() => expect(retryHealthy).toBe(true))
    const skillsHubRow = within(providerFilter).getByRole('checkbox', { name: 'SkillsHub' }).closest('div')
    expect(skillsHubRow).not.toBeNull()
    expect(within(skillsHubRow!).getByText('Available')).toBeVisible()

    await userEvent.click(within(providerFilter).getByRole('checkbox', { name: /skills.sh/ }))
    expect(JSON.parse(localStorage.getItem('comate.skills.search-providers.v1') || '{}').selectedProviderIds)
      .toEqual(['skillshub'])
  })

  it('uses the same compact height for Installed and Skill Search inputs', async () => {
    window.fetch = installFetch([{
      name: 'review', kind: 'skill', scope: 'project', source: 'skills.sh:review',
      installPath: '/skills/review', isLegacySymlink: false, description: 'Review changes',
    }]) as typeof fetch
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    const installedSearch = await screen.findByRole('textbox', { name: 'Search installed skills' })
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }))
    const skillSearch = screen.getByRole('textbox', { name: 'Find skills for the work at hand' })

    expect(installedSearch).toHaveClass('h-10')
    expect(skillSearch).toHaveClass('h-10')
  })

  it('switches search results between card and list modes and remembers the choice', async () => {
    window.fetch = weskillhubInstallFetch() as typeof fetch
    const firstRender = render(
      <I18nextProvider i18n={i18n}>
        <SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} />
      </I18nextProvider>,
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Search' }))
    const searchPanel = screen.getByRole('tabpanel', { name: 'Search' })
    expect(within(searchPanel).getByRole('button', { name: 'Card view' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(searchPanel).getByRole('button', { name: 'List view' })).toBeVisible()

    const skillSearch = screen.getByLabelText('Find skills for the work at hand')
    await userEvent.type(skillSearch, 'todo')
    const results = await within(searchPanel).findByRole('list', {
      name: i18n.t('settings:skills.resultsCount', { count: 1 }),
    })
    expect(results).toHaveAttribute('data-view-mode', 'cards')

    await userEvent.click(within(searchPanel).getByRole('button', { name: 'List view' }))
    expect(results).toHaveAttribute('data-view-mode', 'list')
    expect(localStorage.getItem('comate.skills.search-view-mode')).toBe('list')

    firstRender.unmount()
    render(
      <I18nextProvider i18n={i18n}>
        <SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} />
      </I18nextProvider>,
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }))
    const restoredSearchPanel = screen.getByRole('tabpanel', { name: 'Search' })
    expect(await within(restoredSearchPanel).findByRole('button', { name: 'List view' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('preserves the Enterprise journey across tabs, resets on close, and refreshes an ordinary installed Skill', async () => {
    window.fetch = enterpriseInstallFetch() as typeof fetch
    const { rerender } = render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    await userEvent.click(await screen.findByRole('tab', { name: 'Enterprise Zone' }))
    const enterpriseSearch = await screen.findByLabelText('Search enterprises')
    await userEvent.type(enterpriseSearch, 'cloud')
    await userEvent.click(await screen.findByRole('button', { name: /Acme Enterprise.*Acme description/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Enterprise Skill.*Enterprise Skill summary/ }))
    expect(await screen.findByRole('heading', { name: 'Enterprise Skill' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Search' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Enterprise Zone' }))
    expect(screen.getByRole('heading', { name: 'Enterprise Skill' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Install this Skill' }))
    await userEvent.click(await screen.findByRole('button', { name: /Project.*Shared with collaborators/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(
      () => expect(useSkillsStore.getState().installed.some((skill) => skill.name === 'enterprise-skill')).toBe(true),
      { timeout: 2500 },
    )
    await userEvent.click(await screen.findByRole('tab', { name: 'Installed' }))
    const installedPanel = screen.getByRole('tabpanel', { name: 'Installed' })
    expect(await within(installedPanel).findByText('enterprise-skill')).toBeInTheDocument()
    expect(useSkillsStore.getState().installed[0]).toMatchObject({
      name: 'enterprise-skill', kind: 'skill', source: 'skillhub-cn:enterprise/enterprise-skill',
    })
    expect(useSkillsStore.getState().installed[0]?.packageSlug).toBeUndefined()
    expect(within(installedPanel).queryByText('Expert Package orchestration')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Enterprise Zone' }))
    rerender(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen={false} onClose={() => undefined} /></I18nextProvider>)
    rerender(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)
    expect(await screen.findByLabelText('Search enterprises')).toHaveValue('')
    expect(screen.queryByRole('heading', { name: 'Enterprise Skill' })).not.toBeInTheDocument()
    expect(useEnterpriseZoneStore.getState().activeEnterpriseOrgId).toBeNull()
  })

  it('keeps Enterprise discovery usable at a narrow viewport', async () => {
    await page.viewport(390, 844)
    window.fetch = enterpriseInstallFetch() as typeof fetch
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    await userEvent.click(await screen.findByRole('tab', { name: 'Enterprise Zone' }))
    expect(await screen.findByLabelText('Search enterprises')).toBeVisible()
    expect(screen.getByLabelText('Filter enterprises by industry')).toBeVisible()
    expect(await screen.findByRole('button', { name: /Acme Enterprise/ })).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth)
  })

  it('loads the complete Chinese Enterprise navigation resources', async () => {
    await i18n.changeLanguage('zh-CN')
    window.fetch = enterpriseInstallFetch() as typeof fetch
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    const enterpriseTab = await screen.findByRole('tab', { name: '企业专区' })
    await userEvent.click(enterpriseTab)
    expect(await screen.findByLabelText('搜索企业')).toBeVisible()
    expect(screen.getByLabelText('按行业筛选企业')).toBeVisible()
  })

  it('traverses list, package, and child detail and opens both install flows', async () => {
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    await userEvent.click(await screen.findByRole('tab', { name: 'Expert Packages' }))
    await userEvent.click(await screen.findByRole('button', { name: /Automation Expert.*complete testing workflow/ }))
    await userEvent.click(await screen.findByRole('tab', { name: /Included Skills/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Child Skill.*Child summary/ }))
    expect(await screen.findByText('Child documentation')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Install this Skill' }))
    const singleDialog = await screen.findByRole('dialog', { name: 'Install skill' })
    expect(singleDialog).toHaveTextContent('skillhub-cn:owner/child-skill')
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)

    await userEvent.click(screen.getByRole('button', { name: 'Back to package' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Install package' }))
    const packageDialog = await screen.findByRole('dialog', { name: 'Install Expert Package' })
    expect(packageDialog).toHaveTextContent('Expert Package orchestration')
    expect(packageDialog).toHaveTextContent('Child Skill')
  })

  it('keeps package discovery controls usable at a narrow viewport', async () => {
    await page.viewport(390, 844)
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    await userEvent.click(await screen.findByRole('tab', { name: 'Expert Packages' }))
    expect(await screen.findByLabelText('Search Expert Packages')).toBeVisible()
    expect(screen.getByLabelText('Filter by scenario')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Card view' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'List view' })).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth)
  })

  it('groups installed Expert Package Skills in a package card', async () => {
    window.fetch = installFetch([
      {
        name: 'tech-test-automation',
        kind: 'expert-package-orchestrator',
        scope: 'project',
        source: 'skillhub-package:tech-test-automation',
        packageCatalog: {
          slug: 'tech-test-automation',
          displayName: 'Automation Expert',
          summary: 'A complete testing workflow',
          scene: 'tech',
          skillCount: 1,
          source: 'skillhub.cn',
        },
        installPath: '/skills/tech-test-automation',
        isLegacySymlink: false,
        description: 'A complete testing workflow',
      },
      {
        name: 'child-skill',
        kind: 'skill',
        scope: 'project',
        source: 'skillhub-cn:owner/child-skill',
        packageSlug: 'tech-test-automation',
        installPath: '/skills/child-skill',
        isLegacySymlink: false,
        description: 'Child workflow step',
      },
      {
        name: 'standalone-skill-one',
        kind: 'skill',
        scope: 'project',
        source: 'skillhub-cn:owner/standalone-skill-one',
        installPath: '/skills/standalone-skill-one',
        isLegacySymlink: false,
      },
      {
        name: 'standalone-skill-two',
        kind: 'skill',
        scope: 'project',
        source: 'skillhub-cn:owner/standalone-skill-two',
        installPath: '/skills/standalone-skill-two',
        isLegacySymlink: false,
      },
    ]) as typeof fetch

    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    expect(await screen.findByText('Automation Expert')).toBeInTheDocument()
    expect(screen.getByText('A complete testing workflow')).toBeInTheDocument()
    expect(screen.getByText('Expert Package orchestration')).toBeInTheDocument()
    expect(screen.getByText('Included Skills (1)')).toBeInTheDocument()
    expect(screen.getByText('child-skill')).toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: 'Included Skills (1)' })
    const childGroup = document.getElementById('package-skills-tech-test-automation-project')
    expect(childGroup).not.toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(childGroup!).not.toBeVisible()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(childGroup!).toBeVisible()

    const firstStandaloneCard = screen.getByText('standalone-skill-one').closest('div.overflow-hidden.rounded-xl')
    const secondStandaloneCard = screen.getByText('standalone-skill-two').closest('div.overflow-hidden.rounded-xl')
    expect(firstStandaloneCard).not.toBeNull()
    expect(secondStandaloneCard).not.toBeNull()
    expect(firstStandaloneCard).not.toBe(secondStandaloneCard)

    const installedSearch = screen.getByLabelText('Search installed skills')
    await userEvent.type(installedSearch, 'standalone-skill-one')
    expect(screen.getByText('standalone-skill-one')).toBeInTheDocument()
    expect(screen.queryByText('standalone-skill-two')).not.toBeInTheDocument()

    await userEvent.clear(installedSearch)
    const installedViewMode = screen.getByLabelText('Installed skills view mode')
    const listViewButton = installedViewMode.querySelectorAll('button')[1]!
    await userEvent.click(listViewButton)
    expect(listViewButton).toHaveAttribute('aria-pressed', 'true')
    const firstListCard = screen.getByText('standalone-skill-one').closest('div.overflow-hidden.rounded-xl')
    const secondListCard = screen.getByText('standalone-skill-two').closest('div.overflow-hidden.rounded-xl')
    expect(firstListCard).not.toBe(secondListCard)
  })
})
