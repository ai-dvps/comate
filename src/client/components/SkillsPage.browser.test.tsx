import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import '../index.css'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent, page } from 'vitest/browser'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { prepareSkillManagerDraft } from '../lib/skill-manager-draft'
import SkillsPage from './SkillsPage'

vi.mock('../lib/skill-manager-draft', () => ({ prepareSkillManagerDraft: vi.fn(async () => 'draft') }))
const manager = { id: 'app-manager', name: 'skill-manager', invocationName: 'skill-manager~stable', description: 'Find, install, remove and update Skills', scope: 'builtin', source: 'Comate', installPath: '/Comate/skills/skill-manager', realPath: '/Comate/skills/skill-manager', aliases: [], backends: ['claude', 'codex', 'opencode'], kind: 'skill' }
beforeEach(async () => { await i18n.changeLanguage('en'); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function show(installed: unknown[] = []) {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockImplementation(async () => Response.json({ skills: [manager, ...installed] }))
  vi.stubGlobal('fetch', fetch)
  const onClose = vi.fn()
  render(<I18nextProvider i18n={i18n}><div style={{ height: 760 }}><SkillsPage workspaceId="ws" isOpen onClose={onClose} presentation="embedded" /></div></I18nextProvider>)
  return { fetch, onClose }
}
describe('installed Skills guidance', () => {
  it('keeps guidance and four editable examples visible with no user installations', async () => {
    const { fetch, onClose } = show()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use skill-manager' })).toBeEnabled())
    expect(screen.getByText(/You have no user-installed Skills/)).toBeVisible()
    expect(screen.getByText('Maintained by Comate')).toBeVisible()
    const install = screen.getByRole('button', { name: /Install a Skill from this repository/ })
    await act(async () => { await userEvent.click(install) })
    expect(prepareSkillManagerDraft).toHaveBeenCalledWith('ws', expect.stringContaining('[paste HTTPS / Git URL]'), 'skill-manager~stable')
    expect(onClose).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.every(call => !call[1] || call[1].method !== 'POST')).toBe(true)
  })
  it('retains guidance beside real installation paths and filters without a catalog request', async () => {
    const { fetch } = show([{ ...manager, id: 'external', name: 'external-review', scope: 'project', source: 'owner/repo', installPath: '/project/.agents/skills/external-review' }])
    await waitFor(() => expect(screen.getByText('external-review')).toBeVisible())
    expect(screen.getByRole('button', { name: 'Use skill-manager' })).toBeVisible()
    expect(screen.getByText('/project/.agents/skills/external-review')).toBeVisible()
    await act(async () => { await userEvent.fill(screen.getByRole('textbox', { name: 'Filter installed Skills' }), 'external-review') })
    expect(screen.queryByRole('heading', { name: 'skill-manager' })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('shows actionable Chinese guidance in a narrow viewport', async () => {
    await page.viewport(390, 844)
    await i18n.changeLanguage('zh-CN')
    show()
    await waitFor(() => expect(screen.getByRole('button', { name: '使用 skill-manager' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '帮我找一个适合做演示文稿的 Skill。' })).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
    await page.screenshot({ path: '/tmp/comate-skills-guidance-zh.png' })
    await page.viewport(1280, 900)
  })
})
