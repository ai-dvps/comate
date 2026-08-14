import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import type { ChatSession } from '../stores/chat-store'
import AgentCommandCenter from './AgentCommandCenter'

function renderCommandCenter(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const workspaceState = {
  workspaces: [
    { id: 'ws-1', name: 'Comate', settings: {} },
    { id: 'ws-2', name: 'Hidden tools', settings: {} },
  ],
  openWorkspaceIds: ['ws-1'],
  activeWorkspaceId: 'ws-1',
  openWorkspace: vi.fn(),
  setActiveWorkspace: vi.fn(),
}

const chatState = {
  sessions: {
    'ws-1': [
      {
        id: 'session-a',
        workspaceId: 'ws-1',
        name: 'Needs approval',
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z',
        isWip: true,
        source: 'wecom' as const,
      },
    ],
  } as Record<string, ChatSession[]>,
  activeSessionIds: { 'ws-1': 'session-a' },
  sessionStatus: { 'session-a': { pendingCount: 1, pendingKind: 'approval' } },
  sessionActivity: { 'session-a': { active: true, phase: 'background', backgroundTasks: [] } },
  isStreaming: { 'session-a': true },
  unreadCompletions: {},
  lastActivityAt: {} as Record<string, number>,
  setActiveSession: vi.fn(),
  createSession: vi.fn(() => Promise.resolve()),
  renameSession: vi.fn(() => Promise.resolve()),
  deleteSession: vi.fn(() => Promise.resolve({ ok: true })),
  forkSession: vi.fn(() => Promise.resolve({ ok: true })),
  toggleSessionWip: vi.fn(() => Promise.resolve()),
  toggleSessionArchive: vi.fn(() => Promise.resolve()),
  fetchSessions: vi.fn(() => Promise.resolve({ ok: true })),
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
}))

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}))

vi.mock('../hooks/use-channel-statuses', () => ({
  CHANNEL_STATUS_CLASS: {
    connected: 'opacity-100',
    disconnected: 'opacity-40 grayscale',
  },
  CHANNEL_STATUS_DOT: {
    connected: 'bg-green-500',
    disconnected: 'bg-text-tertiary',
  },
  useChannelStatuses: (_workspaceIds: string[], endpoint: string) => (
    endpoint === '/bot/status'
      ? { 'ws-1': 'connected' }
      : { 'ws-1': 'disconnected' }
  ),
  getChannelStatusLabel: () => '',
}))

vi.mock('../hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}))

describe('AgentCommandCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatState.sessions['ws-1'] = [{
      id: 'session-a',
      workspaceId: 'ws-1',
      name: 'Needs approval',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
      isDraft: true,
      isWip: true,
      source: 'wecom',
    }, {
      id: 'session-feishu',
      workspaceId: 'ws-1',
      name: 'Feishu conversation',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      isWip: false,
      source: 'feishu',
    }]
    chatState.sessions['ws-2'] = []
    chatState.lastActivityAt = {}
  })

  it('shows Workspace groups, Session supervision state, and footer controls', () => {
    const onNewChat = vi.fn()
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onNewChat={onNewChat}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    expect(screen.getByRole('complementary', { name: 'Agent Command Center' })).toBeInTheDocument()
    const newChatButton = screen.getByRole('button', { name: 'New chat' })
    const todosButton = screen.getByRole('button', { name: 'Todos' })
    expect(newChatButton.compareDocumentPosition(todosButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(newChatButton)
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Comate')).toBeInTheDocument()
    expect(screen.getByText('Needs approval')).toBeInTheDocument()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    expect(screen.getByText('WIP')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Comate' }).parentElement).not.toHaveClass('bg-surface-active')
    expect(screen.getByRole('button', { name: /Needs approval/ }).querySelector('img')).toHaveAttribute(
      'src',
      '/wecom-icon.svg',
    )
    expect(screen.getByRole('button', { name: /Feishu conversation/ }).querySelector('img')).toHaveAttribute(
      'src',
      '/feishu-icon.svg',
    )
    expect(screen.getByLabelText('WeCom bot connected').querySelector('img')).toHaveAttribute(
      'src',
      '/wecom-icon.svg',
    )
    expect(screen.getByLabelText('Feishu bot disconnected').querySelector('img')).toHaveAttribute(
      'src',
      '/feishu-icon.svg',
    )
    const workspaceRegion = screen.getByRole('region', { name: 'Comate' })
    expect(workspaceRegion.querySelector('.lucide-folder-open')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Comate' }))
    expect(workspaceRegion.querySelector('.lucide-folder')).toBeInTheDocument()
    expect(workspaceRegion.querySelector('.lucide-folder-open')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Filter sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'User account' })).toBeInTheDocument()

    const primaryNavigation = screen.getByRole('navigation', { name: 'Management destinations' })
    const todos = screen.getByRole('button', { name: 'Todos' })
    const capabilities = screen.getByRole('button', { name: 'Plugins / Skills' })
    expect(primaryNavigation).not.toHaveClass('border-b')
    expect(todos).toHaveClass('w-full', 'justify-start')
    expect(capabilities).toHaveClass('w-full', 'justify-start')
    expect(todos).toHaveTextContent('Todos')
    expect(capabilities).toHaveTextContent('Plugins / Skills')
  })

  it('opens Analytics and Settings from the user account menu', () => {
    const onOpenAnalytics = vi.fn()
    const onOpenSettings = vi.fn()
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={onOpenAnalytics}
        onOpenSettings={onOpenSettings}
        onOpenCapabilities={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Analytics' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()

    const accountButton = screen.getByRole('button', { name: 'User account' })
    fireEvent.click(accountButton)
    expect(accountButton).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Analytics' }))
    expect(onOpenAnalytics).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(accountButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('removes the outer divider when the command center is collapsed', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={0}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    expect(screen.getByRole('complementary', { name: 'Agent Command Center' })).not.toHaveClass('border-r')
  })

  it('closes the user account menu with Escape and restores focus', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    const accountButton = screen.getByRole('button', { name: 'User account' })
    fireEvent.click(accountButton)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(accountButton).toHaveFocus()
  })

  it('shows and opens a defined Workspace that is not already open', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Hidden tools' }))
    expect(workspaceState.openWorkspace).toHaveBeenCalledWith('ws-2')
  })

  it('reveals Workspace search on demand and closes it with Escape or its close button', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    expect(screen.queryByRole('searchbox', { name: 'Search workspaces and sessions' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Search workspaces and sessions' }))
    const search = screen.getByRole('searchbox', { name: 'Search workspaces and sessions' })
    expect(search).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Search workspaces and sessions' }))
    expect(screen.queryByRole('searchbox', { name: 'Search workspaces and sessions' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Search workspaces and sessions' }))
    const reopenedSearch = screen.getByRole('searchbox', { name: 'Search workspaces and sessions' })
    expect(reopenedSearch).toHaveFocus()
    fireEvent.change(reopenedSearch, { target: { value: 'Needs' } })
    fireEvent.keyDown(reopenedSearch, { key: 'Escape' })
    expect(screen.queryByRole('searchbox', { name: 'Search workspaces and sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search workspaces and sessions' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Search workspaces and sessions' }))
    expect(screen.getByRole('searchbox', { name: 'Search workspaces and sessions' })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }))
    expect(screen.queryByRole('searchbox', { name: 'Search workspaces and sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search workspaces and sessions' })).toHaveFocus()
  })

  it('keeps Session status on one line and scrolls an overflowing name on hover', () => {
    chatState.sessions['ws-1'][0].name = 'A very long Session name that cannot fit beside every status badge'

    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    const line = screen.getByTestId('session-line-session-a')
    const nameViewport = screen.getByTestId('session-name-session-a')
    const name = nameViewport.firstElementChild as HTMLElement
    Object.defineProperty(nameViewport, 'clientWidth', { configurable: true, value: 90 })
    Object.defineProperty(name, 'scrollWidth', { configurable: true, value: 210 })

    expect(line).toContainElement(screen.getByText('Approval'))
    expect(line).toContainElement(screen.getByText('Draft'))
    expect(line).toContainElement(screen.getByText('WIP'))
    fireEvent.mouseEnter(nameViewport)
    expect(name).toHaveStyle({ transform: 'translateX(-120px)' })
    fireEvent.mouseLeave(nameViewport)
    expect(name).toHaveStyle({ transform: 'translateX(0px)' })
  })

  it('shows recent Sessions five at a time until all are visible', () => {
    chatState.sessions['ws-1'] = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${index + 1}`,
      workspaceId: 'ws-1',
      name: `Session ${index + 1}`,
      createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      updatedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      isWip: false,
    }))

    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    expect(screen.getByText('Session 12')).toBeInTheDocument()
    expect(screen.getByText('Session 8')).toBeInTheDocument()
    expect(screen.queryByText('Session 7')).not.toBeInTheDocument()

    const showMore = () => screen.getByRole('button', { name: 'Show more sessions in Comate' })
    fireEvent.click(showMore())
    expect(screen.getByText('Session 7')).toBeInTheDocument()
    expect(screen.getByText('Session 3')).toBeInTheDocument()
    expect(screen.queryByText('Session 2')).not.toBeInTheDocument()

    fireEvent.click(showMore())
    expect(screen.getByText('Session 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more sessions in Comate' })).not.toBeInTheDocument()
  })

  it('asks for a name before creating a Session', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'New session in Comate' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), {
      target: { value: 'Release planning' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(chatState.createSession).toHaveBeenCalledWith('ws-1', { name: 'Release planning' })
  })

  it('restores the Session context menu and renames a Session', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: /Needs approval/ }), {
      clientX: 40,
      clientY: 80,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename session' }))
    const input = screen.getByRole('textbox', { name: 'Rename session' })
    fireEvent.change(input, { target: { value: 'Renamed draft' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(chatState.renameSession).toHaveBeenCalledWith('ws-1', 'session-a', 'Renamed draft')
  })

  it('only offers deletion for Draft Sessions and confirms it', () => {
    renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: /Feishu conversation/ }))
    expect(screen.queryByRole('menuitem', { name: 'Delete session' })).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(screen.getByRole('button', { name: /Needs approval/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    expect(screen.getByRole('dialog', { name: 'Delete session?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(chatState.deleteSession).toHaveBeenCalledWith('ws-1', 'session-a')
  })
})
