import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import WorkspaceTabs from './WorkspaceTabs'
import i18n from '../i18n'

interface MockWorkspace {
  id: string
  name: string
  settings: Record<string, unknown>
}

const mockWorkspaceStore = {
  workspaces: [] as MockWorkspace[],
  openWorkspaceIds: [] as string[],
  activeWorkspaceId: null as string | null,
  setActiveWorkspace: vi.fn(),
  closeWorkspace: vi.fn(),
}

const mockChatStore = {
  sessions: {},
  isStreaming: {},
  sessionStatus: {},
  unreadCompletions: {},
  activeSessionIds: {},
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: () => mockWorkspaceStore,
}))

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (s: typeof mockChatStore) => unknown) => selector(mockChatStore),
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

describe('WorkspaceTabs bot indicators', () => {
  beforeAll(() => {
    globalThis.ResizeObserver = vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })) as unknown as typeof ResizeObserver
  })

  beforeEach(() => {
    mockWorkspaceStore.workspaces = []
    mockWorkspaceStore.openWorkspaceIds = []
    mockWorkspaceStore.activeWorkspaceId = null
    mockWorkspaceStore.setActiveWorkspace.mockClear()
    mockWorkspaceStore.closeWorkspace.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the Feishu indicator with the connected title for a Feishu-enabled workspace', async () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('ws1', 'Feishu WS', { feishuBotEnabled: true })]
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/feishu/status': 'connected' })

    renderWithI18n(<WorkspaceTabs />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Feishu bot connected' })).toBeInTheDocument()
    })
  })

  it('renders both WeCom and Feishu indicators when both bots are enabled', async () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace('ws1', 'Both', { wecomBotEnabled: true, feishuBotEnabled: true }),
    ]
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'connected', '/feishu/status': 'connected' })

    renderWithI18n(<WorkspaceTabs />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'WeCom bot connected' })).toBeInTheDocument()
    })
    expect(screen.getByRole('img', { name: 'Feishu bot connected' })).toBeInTheDocument()
  })

  it('maps the connecting status to the connecting title (distinct from connected/error)', async () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('ws1', 'Feishu WS', { feishuBotEnabled: true })]
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/feishu/status': 'connecting' })

    renderWithI18n(<WorkspaceTabs />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Feishu bot connecting' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('img', { name: 'Feishu bot connected' })).not.toBeInTheDocument()
  })

  it('renders no Feishu indicator when the workspace is not Feishu-enabled', async () => {
    mockWorkspaceStore.workspaces = [makeWorkspace('ws1', 'Plain', { wecomBotEnabled: true })]
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'connected' })

    renderWithI18n(<WorkspaceTabs />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'WeCom bot connected' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('img', { name: /Feishu bot/ })).not.toBeInTheDocument()
  })

  it('polls the Feishu status endpoint on mount', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString()
      const ok = u.endsWith('/feishu/status')
      return {
        ok,
        status: ok ? 200 : 404,
        json: async () => (ok ? { status: 'connected' } : {}),
      } as unknown as Response
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    mockWorkspaceStore.workspaces = [makeWorkspace('ws1', 'Feishu WS', { feishuBotEnabled: true })]
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.activeWorkspaceId = 'ws1'

    renderWithI18n(<WorkspaceTabs />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws1/feishu/status')
    })
  })
})
