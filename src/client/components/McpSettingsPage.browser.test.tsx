import { afterEach, expect, it, vi } from 'vitest'
import '../index.css'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from 'vitest/browser'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { useMcpStore } from '../stores/mcp-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import McpSettingsPage from './McpSettingsPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps a failed import editable and displays saved configuration separately from a failed session application', async () => {
  await i18n.changeLanguage('en')
  useWorkspaceStore.setState({ workspaces: [] })
  useMcpStore.setState({ scope: 'global', servers: [], applications: [], error: null, loading: false })
  let imported = false
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/import')) {
      const body = JSON.parse(String(init?.body))
      writes.push(body)
      if (body.configuration === '{bad') return Response.json({ error: 'Invalid JSON at position 1' }, { status: 400 })
      imported = true
      return Response.json({ servers: [] }, { status: 201 })
    }
    if (input.endsWith('/applications')) return Response.json({ applications: [{ sessionId: 'session1', workspaceId: 'workspace1', backend: 'codex', name: 'remote', desired: 2, applied: 1, state: 'failed', error: 'Saved, but this session could not apply the MCP configuration.' }] })
    return Response.json({ servers: imported ? [{ id: 'remote-id', scope: 'global', name: 'remote', type: 'http', url: 'https://example.test/mcp', kind: 'server', enabled: true, revision: 1, argCount: 0, envKeys: [], headerKeys: ['Authorization'], oauth: false, authorization: 'manual' }] : [] })
  }))
  const view = render(<I18nextProvider i18n={i18n}><div style={{ width: 480 }}><McpSettingsPage /></div></I18nextProvider>)
  const click = async (element: HTMLElement) => act(async () => { await userEvent.click(element) })
  await click(await screen.findByRole('button', { name: 'Import JSON' }))
  const json = screen.getByRole('textbox', { name: 'MCP configuration JSON' })
  await act(async () => { await userEvent.fill(json, '{bad') })
  await click(screen.getAllByRole('button', { name: 'Import JSON' })[1])
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid JSON at position 1')
  expect(json).toHaveValue('{bad')
  const configuration = '{"mcpServers":{"remote":{"url":"https://example.test/mcp","headers":{"Authorization":"browser-secret-sentinel"}}}}'
  await act(async () => { await userEvent.fill(json, configuration) })
  await click(screen.getAllByRole('button', { name: 'Import JSON' })[1])
  await screen.findByRole('heading', { name: 'remote' })
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  expect(writes).toHaveLength(2)
  expect(view.container.textContent).not.toContain('browser-secret-sentinel')
  expect(screen.getByRole('button', { name: 'Retry application' })).toBeVisible()
  expect(screen.getByText('Saved, but this session could not apply the MCP configuration.')).toBeVisible()
  const section = view.container.querySelector('section')!
  expect(section.scrollWidth).toBeLessThanOrEqual(480)
})
