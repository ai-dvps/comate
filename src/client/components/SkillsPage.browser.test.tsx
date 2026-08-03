import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
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

function installFetch(installed: unknown[] = []): ReturnType<typeof vi.fn> {
  return vi.fn((input: string | URL | Request) => {
    const url = String(input)
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

describe('SkillsPage Expert Packages browser flow', () => {
  beforeEach(async () => {
    cleanup()
    await page.viewport(1280, 900)
    await i18n.changeLanguage('en')
    useExpertPackagesStore.getState().reset()
    useSkillsStore.setState({ installed: [], discovered: [], isFetchingInstalled: false, error: null })
    localStorage.removeItem('comate.expert-packages.view-mode')
    window.fetch = installFetch() as typeof fetch
  })

  it('traverses list, package, and child detail and opens both install flows', async () => {
    render(<I18nextProvider i18n={i18n}><SkillsPage workspaceId="ws-1" isOpen onClose={() => undefined} /></I18nextProvider>)

    await userEvent.click(await screen.findByRole('button', { name: 'Expert Packages' }))
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

    await userEvent.click(await screen.findByRole('button', { name: 'Expert Packages' }))
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
