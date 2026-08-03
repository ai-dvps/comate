import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import enSettings from '../../i18n/en/settings.json'
import ExpertPackagesView from './ExpertPackagesView'
import ExpertPackageDetail from './ExpertPackageDetail'
import ExpertPackageInstallModal from './ExpertPackageInstallModal'
import ExpertPackageSkillDetail from './ExpertPackageSkillDetail'
import { openUrlInBrowser } from '../../lib/open-url'
import { useExpertPackagesStore, type ExpertPackageDetail as ExpertPackageDetailData } from '../../stores/expert-packages-store'

vi.mock('../../lib/open-url', () => ({ openUrlInBrowser: vi.fn() }))

const originalFetch = global.fetch

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { settings: enSettings } },
  })
})

const summary = {
  slug: 'tech-test-automation',
  displayName: '自动化测试',
  summary: '完整自动化测试工作流',
  scene: 'tech',
  subScene: 'test-automation',
  skillCount: 1,
  source: 'skillhub.cn' as const,
}

describe('Expert Packages UI', () => {
  beforeEach(() => {
    useExpertPackagesStore.getState().reset()
    localStorage.removeItem('comate.expert-packages.view-mode')
    vi.clearAllMocks()
  })
  afterEach(() => { global.fetch = originalFetch })

  it('combines keyword and scene filters and opens a package detail', async () => {
    const requested: string[] = []
    global.fetch = vi.fn((input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('/tech-test-automation')) {
        return Promise.resolve(Response.json({
          package: { ...summary, content: '# Workflow', children: [], complete: false },
        }))
      }
      return Promise.resolve(Response.json({ packages: [summary], total: 1 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(
      <div data-testid="skills-scroll-container">
        <ExpertPackagesView active isOpen workspaceId="ws-1" onInstalled={() => undefined} />
      </div>,
    )

    expect(await screen.findByText('自动化测试')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Search Expert Packages|搜索专家包/), 'test')
    await user.selectOptions(screen.getByLabelText(/Filter by scenario|筛选场景/), 'tech')
    await waitFor(() => expect(requested.some((url) => url.includes('keyword=test') && url.includes('scene=tech'))).toBe(true))

    const scrollContainer = screen.getByTestId('skills-scroll-container')
    scrollContainer.scrollTop = 320
    await user.click(screen.getByRole('button', { name: /自动化测试.*完整自动化测试工作流/ }))
    expect(await screen.findByRole('button', { name: /Install package|安装专家包/ })).toBeEnabled()
    expect(screen.getByText(/Installation will still continue|仍可继续安装/)).toBeInTheDocument()
    scrollContainer.scrollTop = 0
    await user.click(screen.getByRole('button', { name: /Expert Packages|专家包/ }))
    expect(screen.getByLabelText(/Search Expert Packages|搜索专家包/)).toHaveValue('test')
    expect(screen.getByLabelText(/Filter by scenario|筛选场景/)).toHaveValue('tech')
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(320))
  })

  it('clears the keyword without clearing the selected scene', async () => {
    const requested: string[] = []
    global.fetch = vi.fn((input: string | URL | Request) => {
      requested.push(String(input))
      return Promise.resolve(Response.json({ packages: [], total: 0 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(<ExpertPackagesView active isOpen workspaceId="ws-1" onInstalled={() => undefined} />)

    await user.selectOptions(screen.getByLabelText(/Filter by scenario|筛选场景/), 'tech')
    await user.type(screen.getByLabelText(/Search Expert Packages|搜索专家包/), 'test')
    await waitFor(() => expect(requested.some((url) => url.includes('keyword=test') && url.includes('scene=tech'))).toBe(true))
    await user.click(screen.getByRole('button', { name: /Clear search|清除搜索/ }))
    await waitFor(() => expect(requested.some((url) => url.includes('scene=tech') && !url.includes('keyword='))).toBe(true))
    expect(screen.getByLabelText(/Filter by scenario|筛选场景/)).toHaveValue('tech')
  })

  it('persists the list or card presentation preference', async () => {
    global.fetch = vi.fn(() => Promise.resolve(Response.json({ packages: [summary], total: 1 }))) as typeof fetch
    const user = userEvent.setup()
    const first = render(<ExpertPackagesView active isOpen workspaceId="ws-1" onInstalled={() => undefined} />)
    await screen.findByText('自动化测试')
    await user.click(screen.getByRole('button', { name: /List view|列表视图/ }))
    expect(screen.getByRole('button', { name: /List view|列表视图/ })).toHaveAttribute('aria-pressed', 'true')
    first.unmount()

    render(<ExpertPackagesView active isOpen workspaceId="ws-1" onInstalled={() => undefined} />)
    expect(screen.getByRole('button', { name: /List view|列表视图/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows skeletons while package and Skill details are fetched', () => {
    const { container } = render(<>
      <ExpertPackageDetail
        loading
        onBack={() => undefined}
        onRetry={() => undefined}
        onSelectSkill={() => undefined}
        onInstall={() => undefined}
      />
      <ExpertPackageSkillDetail
        packageName="Package"
        loading
        onBack={() => undefined}
        onBackToList={() => undefined}
        onRetry={() => undefined}
        onInstall={() => undefined}
      />
    </>)

    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('renders package breadcrumbs, security coverage, and included Skill navigation', async () => {
    const user = userEvent.setup()
    const onSelectSkill = vi.fn()
    render(<ExpertPackageDetail
      detail={{
        ...summary,
        content: '# Workflow',
        complete: true,
        children: [{
          namespace: 'owner',
          slug: 'child-skill',
          displayName: 'Child Skill',
          summary: 'Child',
          available: true,
          source: 'skillhub-cn:owner/child-skill',
          securityReports: [{ provider: 'Keen', status: 'benign', statusText: 'Safe' }],
        }],
      }}
      loading={false}
      installed
      onBack={() => undefined}
      onRetry={() => undefined}
      onSelectSkill={onSelectSkill}
      onInstall={() => undefined}
    />)

    expect(screen.getByRole('navigation', { name: /Expert Package breadcrumb|专家包面包屑/ })).toHaveTextContent('自动化测试')
    expect(screen.getByRole('button', { name: /Installed|已安装/ })).toBeDisabled()
    expect(screen.getByText(/Security reports: 1\/1 Skills|安全报告：1\/1 个 Skill/)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Included Skills|包含的 Skill/ }))
    expect(screen.getByText(/1 reports|1 份报告/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Child Skill.*Child/ }))
    expect(onSelectSkill).toHaveBeenCalledWith('owner', 'child-skill')
  })

  it('renders included Skill metadata and opens a normalized security report', async () => {
    const user = userEvent.setup()
    render(<ExpertPackageSkillDetail
      packageName="自动化测试"
      detail={{
        namespace: 'owner',
        slug: 'child-skill',
        displayName: 'Child Skill',
        summary: 'Child summary',
        category: 'tech',
        owner: { handle: 'owner', displayName: 'Owner' },
        version: '1.0.0',
        stats: { downloads: 12, installs: 3 },
        securityReports: [{
          provider: 'Keen',
          status: 'benign',
          statusText: 'Safe',
          reportUrl: 'https://example.com/report',
        }],
        documentation: '# Child docs',
        source: 'skillhub-cn:owner/child-skill',
      }}
      loading={false}
      installed
      onBack={() => undefined}
      onBackToList={() => undefined}
      onRetry={() => undefined}
      onInstall={() => undefined}
    />)

    expect(screen.getByText('Owner · @owner')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Installed|已安装/ })).toBeDisabled()
    expect(screen.getByText('Child docs')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Keen.*Safe/ }))
    expect(openUrlInBrowser).toHaveBeenCalledWith('https://example.com/report')
  })

  it('separates orchestration from child Skills and sends an in-app install request', async () => {
    const detail: ExpertPackageDetailData = {
      ...summary,
      content: '# Workflow',
      complete: false,
      children: [{
        namespace: 'owner', slug: 'child-skill', displayName: 'Child Skill',
        summary: 'Child', available: true, source: 'skillhub-cn:owner/child-skill',
      }],
    }
    let body: Record<string, unknown> = {}
    global.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(Response.json({ results: [
        { id: 'orchestrator:tech-test-automation', kind: 'orchestrator', source: 'skillhub-package:tech-test-automation', name: 'tech-test-automation', status: 'installed' },
        { id: 'skill:owner/child-skill', kind: 'skill', source: 'skillhub-cn:owner/child-skill', name: 'child-skill', status: 'error', error: 'download failed' },
      ] }, { status: 201 }))
    }) as typeof fetch
    const completed = vi.fn()
    const user = userEvent.setup()
    render(<ExpertPackageInstallModal detail={detail} workspaceId="ws-1" onClose={() => undefined} onCompleted={completed} />)

    expect(screen.getByText(/Expert Package orchestration · not a standard industry Skill|专家包编排 · 非标准行业 Skill/)).toBeInTheDocument()
    expect(screen.getByText('Child Skill')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Confirm install|确认安装/ }))
    await waitFor(() => expect(completed).toHaveBeenCalled())
    expect(screen.getByText('download failed')).toBeInTheDocument()
    expect(body).toEqual({ scope: 'project', workspaceId: 'ws-1' })
  })
})
