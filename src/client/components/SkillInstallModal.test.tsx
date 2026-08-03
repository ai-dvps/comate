import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import enSettings from '../i18n/en/settings.json'
import { useSkillsStore } from '../stores/skills-store'
import SkillInstallModal from './SkillInstallModal'

const originalFetch = global.fetch

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { settings: enSettings } },
  })
})

describe('SkillInstallModal fixed selection', () => {
  beforeEach(() => {
    useSkillsStore.setState({ discovered: [], isResolving: false, isSaving: false, error: null })
  })
  afterEach(() => { global.fetch = originalFetch })

  it('submits only the fixed Expert Package child Skill', async () => {
    let installBody: Record<string, unknown> = {}
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/resolve')) {
        return Promise.resolve(Response.json({ skills: [
          { name: 'child-skill', description: 'Child', skillPath: 'SKILL.md' },
        ] }))
      }
      installBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(Response.json({ results: [
        { skillName: 'child-skill', status: 'installed' },
      ] }, { status: 201 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(<SkillInstallModal
      source="skillhub-cn:owner/child-skill"
      fixedSkillName="child-skill"
      workspaceId="ws-1"
      onClose={() => undefined}
      onInstalled={() => undefined}
    />)

    expect(await screen.findByRole('button', { name: /child-skill.*Child/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /Global.*Available in all/ }))
    await user.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(installBody).toEqual({
      source: 'skillhub-cn:owner/child-skill',
      skills: ['child-skill'],
      scope: 'global',
      workspaceId: 'ws-1',
    }))
  })

  it.each([
    ['zero Skills', []],
    ['multiple Skills', [
      { name: 'child-skill', description: 'Child', skillPath: 'SKILL.md' },
      { name: 'sibling', description: 'Sibling', skillPath: 'other/SKILL.md' },
    ]],
    ['a differently named Skill', [
      { name: 'renamed-skill', description: 'Renamed', skillPath: 'SKILL.md' },
    ]],
  ])('rejects fixed selection when resolution returns %s', async (_label, skills) => {
    let resolveAttempts = 0
    const installRequest = vi.fn()
    global.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith('/resolve')) {
        resolveAttempts += 1
        return Promise.resolve(Response.json({ skills }))
      }
      installRequest()
      return Promise.resolve(Response.json({ results: [] }, { status: 201 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(<SkillInstallModal
      source="skillhub-cn:owner/child-skill"
      fixedSkillName="child-skill"
      workspaceId="ws-1"
      onClose={() => undefined}
      onInstalled={() => undefined}
    />)

    expect(await screen.findByText('Install failed')).toBeInTheDocument()
    expect(screen.queryByText('Select installation scope')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    expect(installRequest).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(resolveAttempts).toBe(2))
    expect(installRequest).not.toHaveBeenCalled()
  })

  it('retains the existing reinstall path for a fixed Skill', async () => {
    const installBodies: Array<Record<string, unknown>> = []
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/resolve')) {
        return Promise.resolve(Response.json({ skills: [
          { name: 'child-skill', description: 'Child', skillPath: 'SKILL.md' },
        ] }))
      }
      installBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (installBodies.length === 1) {
        return Promise.resolve(Response.json({ error: 'Already installed', results: [] }, { status: 409 }))
      }
      return Promise.resolve(Response.json({ results: [
        { skillName: 'child-skill', status: 'overwritten' },
      ] }, { status: 201 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(<SkillInstallModal
      source="skillhub-cn:owner/child-skill"
      fixedSkillName="child-skill"
      workspaceId="ws-1"
      onClose={() => undefined}
      onInstalled={() => undefined}
    />)

    await screen.findByText('child-skill')
    await user.click(screen.getByRole('button', { name: /Project.*Shared with collaborators/ }))
    await user.click(screen.getByRole('button', { name: 'Install' }))
    await user.click(await screen.findByRole('button', { name: 'Reinstall' }))
    await waitFor(() => expect(installBodies).toHaveLength(2))
    expect(installBodies[1]).toMatchObject({ skills: ['child-skill'], force: true })
  })
})
