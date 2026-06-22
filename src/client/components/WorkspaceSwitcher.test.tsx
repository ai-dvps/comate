import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import i18n from '../i18n'

interface MockWorkspace {
  id: string
  name: string
  settings: Record<string, unknown>
}

const mockStore = {
  workspaces: [] as MockWorkspace[],
  openWorkspaceIds: [] as string[],
  activeWorkspaceId: null as string | null,
  openWorkspace: vi.fn(),
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (s: typeof mockStore) => unknown) => selector(mockStore),
}))

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

function makeWorkspace(id: string, name: string, settings: Record<string, unknown>): MockWorkspace {
  return { id, name, settings }
}

/** Configures global fetch to return the given status string per URL suffix. */
function mockFetchByStatus(map: Record<string, string>) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString()
    for (const [suffix, status] of Object.entries(map)) {
      if (u.endsWith(suffix)) {
        return { ok: true, status: 200, json: async () => ({ status }) } as unknown as Response
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }) as unknown as typeof fetch
}

describe('WorkspaceSwitcher bot indicators', () => {
  beforeAll(() => {
    globalThis.ResizeObserver = vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })) as unknown as typeof ResizeObserver
  })

  beforeEach(() => {
    mockStore.workspaces = []
    mockStore.openWorkspaceIds = []
    mockStore.activeWorkspaceId = null
    mockStore.openWorkspace.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the Feishu status icon for a Feishu-enabled workspace', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'Feishu WS', { feishuBotEnabled: true })]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/feishu/status': 'connected' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Feishu bot connected' })).toBeInTheDocument()
    })
  })

  it('renders the WeCom status icon for a WeCom-enabled workspace', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'WeCom WS', { wecomBotEnabled: true })]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'connected' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'WeCom bot connected' })).toBeInTheDocument()
    })
  })

  it('renders both icons when both bots are enabled on one workspace', async () => {
    mockStore.workspaces = [
      makeWorkspace('ws1', 'Both', { wecomBotEnabled: true, feishuBotEnabled: true }),
    ]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'connected', '/feishu/status': 'connected' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'WeCom bot connected' })).toBeInTheDocument()
    })
    expect(screen.getByRole('img', { name: 'Feishu bot connected' })).toBeInTheDocument()
  })

  it('renders no bot icons for a workspace without bots enabled', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'Plain', {})]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({})

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('Plain')).toBeInTheDocument()
    })
    expect(screen.queryByRole('img', { name: /bot/ })).not.toBeInTheDocument()
  })
})
