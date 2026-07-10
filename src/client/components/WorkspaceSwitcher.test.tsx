import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
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
    globalThis.ResizeObserver = class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })

  beforeEach(() => {
    mockStore.workspaces = []
    mockStore.openWorkspaceIds = []
    mockStore.activeWorkspaceId = null
    mockStore.openWorkspace.mockClear()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the Feishu status icon when the server reports a connected Feishu bot', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'Feishu WS', {})]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/feishu/status': 'connected', '/bot/status': 'not_configured' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Feishu bot connected' })).toBeInTheDocument()
    })
  })

  it('renders the WeCom status icon when the server reports a connected WeCom bot', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'WeCom WS', {})]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'connected', '/feishu/status': 'not_configured' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'WeCom bot connected' })).toBeInTheDocument()
    })
  })

  it('renders both icons when both bots are bound to one workspace', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'Both', {})]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'connected', '/feishu/status': 'connected' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'WeCom bot connected' })).toBeInTheDocument()
    })
    expect(screen.getByRole('img', { name: 'Feishu bot connected' })).toBeInTheDocument()
  })

  it('renders no bot icons when the server reports not_configured', async () => {
    mockStore.workspaces = [makeWorkspace('ws1', 'Plain', {})]
    mockStore.openWorkspaceIds = ['ws1']
    mockStore.activeWorkspaceId = 'ws1'
    mockFetchByStatus({ '/bot/status': 'not_configured', '/feishu/status': 'not_configured' })

    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('Plain')).toBeInTheDocument()
    })
    expect(screen.queryByRole('img', { name: /bot/ })).not.toBeInTheDocument()
  })
})

describe('WorkspaceSwitcher search and pin', () => {
  beforeEach(() => {
    mockStore.workspaces = []
    mockStore.openWorkspaceIds = []
    mockStore.activeWorkspaceId = null
    mockStore.openWorkspace.mockClear()
    localStorage.clear()
    mockFetchByStatus({})
  })

  afterEach(() => {
    cleanup()
  })

  function seedWorkspaces() {
    mockStore.workspaces = [
      makeWorkspace('ws-claude', 'claude-code-gui', {}),
      makeWorkspace('ws-comate', 'comate-website', {}),
      makeWorkspace('ws-play', 'playground', {}),
    ]
  }

  const rowFor = (name: string) =>
    screen.getAllByTestId('workspace-row').find((r) => r.textContent?.includes(name)) as HTMLElement

  it('AE1: filters workspaces by name as the query is typed', () => {
    seedWorkspaces()
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), {
      target: { value: 'claude' },
    })

    expect(screen.getByText('claude-code-gui')).toBeInTheDocument()
    expect(screen.queryByText('comate-website')).not.toBeInTheDocument()
    expect(screen.queryByText('playground')).not.toBeInTheDocument()
  })

  it('AE2: clicking the pin icon moves a workspace to the top', () => {
    seedWorkspaces()
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.click(within(rowFor('playground')).getByTestId('pin-toggle'))

    const ordered = screen.getAllByTestId('workspace-row').map((r) => r.textContent)
    expect(ordered[0]).toContain('playground')
    expect(ordered[1]).toContain('claude-code-gui')
    expect(ordered[2]).toContain('comate-website')
  })

  it('AE5: a pinned workspace that does not match the query is hidden', () => {
    seedWorkspaces()
    localStorage.setItem('workspace-pins', JSON.stringify(['ws-comate']))
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), {
      target: { value: 'claude' },
    })

    expect(screen.getByText('claude-code-gui')).toBeInTheDocument()
    expect(screen.queryByText('comate-website')).not.toBeInTheDocument()
  })

  it('AE4: removes the pin entry when a pinned workspace is deleted', async () => {
    seedWorkspaces()
    localStorage.setItem('workspace-pins', JSON.stringify(['ws-claude', 'ws-comate', 'ws-play']))
    const { rerender } = renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    mockStore.workspaces = [
      makeWorkspace('ws-claude', 'claude-code-gui', {}),
      makeWorkspace('ws-play', 'playground', {}),
    ]
    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkspaceSwitcher open onOpenChange={() => {}} />
      </I18nextProvider>,
    )

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('workspace-pins') ?? '[]')).toEqual([
        'ws-claude',
        'ws-play',
      ])
    })
  })

  it('resets the query when the popover closes and reopens', () => {
    seedWorkspaces()
    const { rerender } = renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), {
      target: { value: 'claude' },
    })
    expect(screen.queryByText('comate-website')).not.toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkspaceSwitcher open={false} onOpenChange={() => {}} />
      </I18nextProvider>,
    )
    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkspaceSwitcher open onOpenChange={() => {}} />
      </I18nextProvider>,
    )

    expect(screen.getByText('comate-website')).toBeInTheDocument()
    expect((screen.getByPlaceholderText('Search workspaces...') as HTMLInputElement).value).toBe('')
  })

  it('does not select the workspace when its pin icon is clicked', () => {
    seedWorkspaces()
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.click(within(rowFor('playground')).getByTestId('pin-toggle'))

    expect(mockStore.openWorkspace).not.toHaveBeenCalled()
  })

  it('shows the no-matches message when nothing matches the query', () => {
    seedWorkspaces()
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), {
      target: { value: 'zzznomatch' },
    })

    expect(screen.getByText('No matching workspaces')).toBeInTheDocument()
  })

  it('Escape clears the query, then a second Escape closes the popover', () => {
    seedWorkspaces()
    const onOpenChange = vi.fn()
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={onOpenChange} />)

    const input = screen.getByPlaceholderText('Search workspaces...')
    fireEvent.change(input, { target: { value: 'claude' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect((input as HTMLInputElement).value).toBe('')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('clear button empties the query and restores the full list', () => {
    seedWorkspaces()
    renderWithI18n(<WorkspaceSwitcher open onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), {
      target: { value: 'claude' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(screen.getByText('comate-website')).toBeInTheDocument()
    expect(screen.getByText('playground')).toBeInTheDocument()
  })
})
