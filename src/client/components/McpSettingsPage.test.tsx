import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useMcpStore } from '../stores/mcp-store'
import McpSettingsPage from './McpSettingsPage'

beforeEach(async () => {
  await i18n.changeLanguage('en')
  useMcpStore.setState({ scope: 'global', servers: [], applications: [], error: null, loading: false })
  useWorkspaceStore.setState({ workspaces: [{ id: 'one', name: 'Workspace One', description: '', folderPath: '/tmp',
    skills: [], mcpServers: [], hooks: [], settings: {}, createdAt: '', updatedAt: '' }] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('submits argv as independent values and clears the secret draft after saving', async () => {
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)))
    return { ok: true, status: 200, json: async () => url.includes('applications') ? { applications: [] } : { servers: [] } }
  }))
  render(<I18nextProvider i18n={i18n}><McpSettingsPage /></I18nextProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Add service' }))
  fireEvent.change(screen.getByLabelText('Service name'), { target: { value: 'example' } })
  fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'node' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add argument' }))
  fireEvent.change(screen.getByLabelText('Argument 1'), { target: { value: 'a b' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save service' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ scope: 'global', name: 'example', connection: { type: 'stdio', command: 'node', args: ['a b'] } })
  await waitFor(() => expect(screen.queryByLabelText('Service name')).not.toBeInTheDocument())
})

it('disables an inherited service only in the selected workspace', async () => {
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)))
    return { ok: true, status: 200, json: async () => url.includes('applications') ? { applications: [] } : { servers: [{
      id: 'global-id', scope: 'global', name: 'Inherited example', kind: 'server', enabled: true, revision: 1,
      argCount: 0, envKeys: [], headerKeys: [], oauth: false, authorization: 'not_required', inherited: url.includes('workspace'),
    }] } }
  }))
  render(<I18nextProvider i18n={i18n}><McpSettingsPage /></I18nextProvider>)
  await screen.findByText('Inherited example')
  fireEvent.change(screen.getByLabelText('Configuration scope'), { target: { value: 'workspace:one' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Disable in this workspace' }))
  await waitFor(() => expect(writes[0]).toEqual({ scope: 'workspace:one', name: 'Inherited example', kind: 'disabled', enabled: false }))
})
