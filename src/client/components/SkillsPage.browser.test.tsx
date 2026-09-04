import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import '../index.css'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent, page } from 'vitest/browser'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { prepareSkillManagerDraft } from '../lib/skill-manager-draft'
import { useBackendStore } from '../stores/backend-store'
import SkillsPage from './SkillsPage'

vi.mock('../lib/skill-manager-draft', () => ({ prepareSkillManagerDraft: vi.fn(async () => 'draft') }))
const manager = { id: 'app-manager', name: 'skill-manager', invocationName: 'skill-manager', description: 'Find, install, remove and update Skills', scope: 'builtin', source: 'Comate', installPath: '/Comate/skills/skill-manager', realPath: '/Comate/skills/skill-manager', aliases: [], backends: ['claude', 'codex', 'opencode'], kind: 'skill' }
beforeEach(async () => { await i18n.changeLanguage('en'); vi.clearAllMocks(); useBackendStore.setState({ backends: (['claude', 'codex', 'opencode'] as const).map(id => ({ id, availability: { status: 'available' }, capabilities: {} })) }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function show(installed: unknown[] = []) {
  const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockImplementation(async () => Response.json({ skills: [manager, ...installed] }))
  vi.stubGlobal('fetch', fetch)
  const onClose = vi.fn()
  const onInstallSkill = vi.fn()
  render(<I18nextProvider i18n={i18n}><div style={{ height: 760 }}><SkillsPage onInstallSkill={onInstallSkill} workspaceId="ws" isOpen onClose={onClose} presentation="embedded" /></div></I18nextProvider>)
  return { fetch, onClose, onInstallSkill }
}
const project = { ...manager, id: 'project', name: 'review', scope: 'project', version: '1.2', source: 'owner/repo', installPath: '/project/.agents/skills/review', realPath: '/project/.agents/skills/review', backends: ['codex', 'opencode'] }
const global = { ...project, id: 'global', scope: 'global', version: undefined, installPath: '/home/.codex/skills/review', realPath: '/home/.codex/skills/review', backends: ['codex'] }
const click = async (element: HTMLElement) => { await act(async () => { await userEvent.click(element) }) }
describe('installed Skills contextual management', () => {
  it('ranks name matches before descriptions, preserves ties and restores default order', async () => {
    const names = ['guide-b', 'my-code-review', 'code-review-extra', 'code-review', 'guide-a', 'unrelated']
    show(names.map((name, index) => ({ ...project, id: String(index), name, description: name.startsWith('guide') ? 'Use code-review for checking changes' : 'Test capability' })))
    const listNames = () => within(screen.getByRole('region', { name: 'Your Skills' })).queryAllByRole('heading', { level: 3 }).map(node => node.textContent)
    await waitFor(() => expect(listNames()).toEqual(names))
    const search = screen.getByRole('textbox', { name: 'Filter installed Skills' })
    await act(async () => { await userEvent.fill(search, ' CODE-REVIEW ') })
    expect(listNames()).toEqual(['code-review', 'code-review-extra', 'my-code-review', 'guide-b', 'guide-a'])
    await click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    expect(listNames()).toEqual(names)
    await act(async () => { await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by scope' }), 'global'); await userEvent.fill(search, 'code-review') })
    expect(listNames()).toEqual([])
  })
  it('keeps help collapsed and prepares an editable installation draft', async () => {
    const { fetch, onClose, onInstallSkill } = show()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Install Skill' })[0]).toBeEnabled())
    expect(screen.queryByRole('button', { name: /Install a Skill from this repository/ })).toBeNull()
    expect(screen.getByText(/No user-installed Skills yet/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Actions for skill-manager' })).toBeNull()
    await click(screen.getAllByRole('button', { name: 'Install Skill' })[0])
    expect(onInstallSkill).toHaveBeenCalledWith('ws', expect.stringContaining('[paste HTTPS / Git URL]'), 'skill-manager')
    expect(prepareSkillManagerDraft).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(fetch.mock.calls.every(call => !call[1] || call[1].method !== 'POST')).toBe(true)
  })
  it('filters scope independently and retains every affected Agent in the selected installation draft', async () => {
    show([project, global])
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'review' })).toHaveLength(2))
    expect(screen.getByText('1.2')).not.toBeVisible()
    expect(screen.getByText('Version unknown')).not.toBeVisible()
    await act(async () => { await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by Agent' }), 'codex'); await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by scope' }), 'project') })
    expect(screen.getAllByRole('heading', { name: 'review' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'skill-manager' })).toBeVisible()
    await click(screen.getByRole('button', { name: 'Actions for review' }))
    await click(screen.getByRole('button', { name: 'Update…' }))
    const draft = vi.mocked(prepareSkillManagerDraft).mock.calls[0][1]
    expect(draft).toContain(project.installPath)
    expect(draft).toContain('OpenCode')
    expect(draft).toContain('Codex')
    expect(draft).toContain('"scope": "project"')
    expect(draft).not.toContain(global.installPath)
  })
  it('removes only the chosen same-name installation and carries aliases', async () => {
    show([project, { ...global, aliases: ['/home/shared/review'] }])
    await waitFor(() => expect(screen.getByText(global.installPath)).toBeInTheDocument())
    const row = screen.getByText(global.installPath).closest('li')!
    await click(within(row).getByRole('button', { name: 'Actions for review' }))
    await click(screen.getByRole('button', { name: 'Remove…' }))
    const draft = vi.mocked(prepareSkillManagerDraft).mock.calls[0][1]
    expect(draft).toContain(global.installPath)
    expect(draft).toContain('/home/shared/review')
    expect(draft).not.toContain(project.installPath)
  })
  it('shows help on demand, closes with Escape, and carries an unmatched search into discovery', async () => {
    show([project])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'review' })).toBeVisible())
    await click(screen.getByRole('button', { name: 'Skill management help' }))
    expect(screen.getByRole('button', { name: /Install a Skill from this repository/ })).toBeVisible()
    await act(async () => { await userEvent.keyboard('{Escape}') })
    expect(screen.queryByRole('button', { name: /Install a Skill from this repository/ })).toBeNull()
    await act(async () => { await userEvent.fill(screen.getByRole('textbox', { name: 'Filter installed Skills' }), 'presentation') })
    await click(screen.getByRole('button', { name: 'Find more Skills' }))
    expect(prepareSkillManagerDraft).toHaveBeenCalledWith('ws', expect.stringContaining('presentation'), 'skill-manager')
  })
  it('keeps paths inside installation details even for same-scope copies', async () => {
    show([project, { ...project, id: 'second', installPath: '/project/.codex/skills/review' }])
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'review' })).toHaveLength(2))
    const row = screen.getAllByRole('heading', { name: 'review' })[0].closest('li')!
    expect(within(row).getByText(project.installPath)).not.toBeVisible()
    expect(within(row).getByText('1.2')).not.toBeVisible()
    await click(within(row).getByText('Installation details'))
    expect(within(row).getByText('1.2')).toBeVisible()
    expect(within(row).getByText(project.installPath)).toBeVisible()
    expect(within(row).getByRole('button', { name: 'Copy path' })).toBeVisible()
  })
  it('hides unavailable Agent names in the summary while retaining full details and action scope', async () => {
    useBackendStore.setState({ backends: [
      { id: 'codex', availability: { status: 'available' }, capabilities: {} },
      { id: 'opencode', availability: { status: 'unavailable' }, capabilities: {} },
    ] })
    show([project])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'review' })).toBeVisible())
    const row = screen.getByRole('heading', { name: 'review' }).closest('li')!
    expect(within(row).getByText('Available to Codex')).toBeVisible()
    expect(within(row).getByText('Codex、OpenCode')).not.toBeVisible()
    await click(within(row).getByText('Installation details'))
    expect(within(row).getByText('Codex、OpenCode')).toBeVisible()
    await click(within(row).getByRole('button', { name: 'Actions for review' }))
    await click(screen.getByRole('button', { name: 'Update…' }))
    expect(vi.mocked(prepareSkillManagerDraft).mock.calls[0][1]).toContain('OpenCode')
  })
  it('fits Chinese content at narrow and desktop widths', async () => {
    await i18n.changeLanguage('zh-CN')
    show([{ ...project, name: 'ui-ux-pro-max', description: '为界面设计提供布局、配色和交互建议。' }, { ...global, name: 'ui-ux-pro-max', description: '为界面设计提供布局、配色和交互建议。' }])
    await waitFor(() => expect(screen.getByRole('button', { name: '安装 Skill' })).toBeEnabled())
    await page.viewport(1280, 900)
    await click(screen.getAllByText('安装详情')[1])
    await page.screenshot({ path: '/tmp/comate-skills-desktop.png' })
    await page.viewport(390, 844)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
    await page.screenshot({ path: '/tmp/comate-skills-guidance-zh.png' })
    await page.viewport(1280, 900)
  })
})
