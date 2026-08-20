import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import type { ChatSession } from '../stores/chat-store'
import { useToastStore } from '../stores/toast-store'
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
  workspaceLastTurnStartedAt: {} as Record<string, number>,
  setActiveSession: vi.fn(),
  createSession: vi.fn(() => Promise.resolve()),
  renameSession: vi.fn(() => Promise.resolve()),
  deleteSession: vi.fn(() => Promise.resolve({ ok: true })),
  forkSession: vi.fn(() => Promise.resolve({ ok: true })),
  toggleSessionWip: vi.fn(() => Promise.resolve()),
  toggleSessionArchive: vi.fn(() => Promise.resolve()),
  fetchSessions: vi.fn(() => Promise.resolve({ ok: true })),
}

const openFolderMock = vi.fn((path: string): Promise<void> => {
  void path
  return Promise.resolve()
})

vi.mock('../lib/desktop-api', () => ({
  openFolder: (path: string) => openFolderMock(path),
}))

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
    chatState.workspaceLastTurnStartedAt = {}
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
    const sessionRegion = screen.getByTestId('workspace-sessions-ws-1')
    expect(workspaceRegion.querySelector('.lucide-folder-open')).toBeInTheDocument()
    expect(sessionRegion).toHaveClass('grid-rows-[1fr]', 'opacity-100', 'duration-200')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Comate' }))
    expect(workspaceRegion.querySelector('.lucide-folder')).toBeInTheDocument()
    expect(workspaceRegion.querySelector('.lucide-folder-open')).not.toBeInTheDocument()
    expect(sessionRegion).toHaveClass('grid-rows-[0fr]', 'opacity-0', 'duration-200')
    expect(sessionRegion).toHaveAttribute('aria-hidden', 'true')
    expect(sessionRegion).toHaveAttribute('inert')
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

  it('toggles a workspace group without opening it when the workspace item is clicked', () => {
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

    const workspaceRegion = screen.getByRole('region', { name: 'Comate' })
    fireEvent.click(screen.getByRole('button', { name: 'Comate' }))

    expect(workspaceRegion.querySelector('.lucide-folder')).toBeInTheDocument()
    expect(workspaceRegion.querySelector('.lucide-folder-open')).not.toBeInTheDocument()
    expect(workspaceState.openWorkspace).not.toHaveBeenCalled()
  })

  it('reorders a collapsed Workspace after a turn start without changing its UI state', () => {
    chatState.sessions['ws-2'] = [{
      id: 'session-hidden',
      workspaceId: 'ws-2',
      name: 'Background task',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    }]
    const center = () => (
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
      />
    )
    const view = renderCommandCenter(center())

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Hidden tools' }))
    // Turn-start keys are the only ordering signal (activity sort position
    // stability): the workspace rises when its server-carried key advances.
    chatState.workspaceLastTurnStartedAt = { 'ws-2': Date.parse('2026-08-15T00:00:00.000Z') }
    view.rerender(<I18nextProvider i18n={i18n}>{center()}</I18nextProvider>)

    const hiddenWorkspace = screen.getByRole('region', { name: 'Hidden tools' })
    const olderSelectedWorkspace = screen.getByRole('region', { name: 'Comate' })
    expect(
      hiddenWorkspace.compareDocumentPosition(olderSelectedWorkspace)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand Hidden tools' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Search workspaces and sessions' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search workspaces and sessions' }), {
      target: { value: 'Needs' },
    })
    expect(
      hiddenWorkspace.compareDocumentPosition(olderSelectedWorkspace)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
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

  it('toggles a workspace that is not already open without opening it', () => {
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

    const workspaceRegion = screen.getByRole('region', { name: 'Hidden tools' })
    fireEvent.click(screen.getByRole('button', { name: 'Hidden tools' }))

    expect(workspaceRegion.querySelector('.lucide-folder')).toBeInTheDocument()
    expect(workspaceState.openWorkspace).not.toHaveBeenCalled()
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

  it('asks for a name before creating a Session', async () => {
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

    const newSessionButton = screen.getByRole('button', { name: 'New session in Comate' })
    fireEvent.click(newSessionButton)
    fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), {
      target: { value: 'Release planning' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(chatState.createSession).toHaveBeenCalledWith('ws-1', { name: 'Release planning' })
    await waitFor(() => expect(newSessionButton).toHaveFocus())
  })

  it('animates the new Session form when opening and cancelling it', () => {
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

    const formRegion = screen.getByTestId('new-session-form-ws-1')
    expect(formRegion).toHaveClass('grid-rows-[0fr]', 'opacity-0', 'duration-200')
    expect(formRegion).toHaveAttribute('inert')

    fireEvent.click(screen.getByRole('button', { name: 'New session in Comate' }))
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveFocus()
    expect(formRegion).toHaveClass('grid-rows-[1fr]', 'opacity-100', 'duration-200')
    expect(formRegion).not.toHaveAttribute('inert')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(formRegion).toHaveClass('grid-rows-[0fr]', 'opacity-0', 'duration-200')
    expect(formRegion).toHaveAttribute('aria-hidden', 'true')
    expect(formRegion).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'New session in Comate' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'New session in Comate' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Session name' }), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'New session in Comate' })).toHaveFocus()
  })

  it('keeps session rows as the workspace navigation boundary', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Needs approval/ }))

    expect(chatState.setActiveSession).toHaveBeenCalledWith('ws-1', 'session-a')
    expect(workspaceState.openWorkspace).not.toHaveBeenCalled()
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

describe('AgentCommandCenter workspace context menu', () => {
  function renderCenter(overrides: Partial<React.ComponentProps<typeof AgentCommandCenter>> = {}) {
    return renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
        {...overrides}
      />,
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    openFolderMock.mockReset().mockReturnValue(Promise.resolve())
    ;(workspaceState.workspaces[0] as { folderPath?: string }).folderPath = '/tmp/comate'
    delete (workspaceState.workspaces[1] as { folderPath?: string }).folderPath
    chatState.sessions['ws-1'] = [{
      id: 'session-a',
      workspaceId: 'ws-1',
      name: 'Needs approval',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
      isDraft: true,
      isWip: true,
      source: 'wecom',
    }]
    chatState.sessions['ws-2'] = []
    useToastStore.setState({ toasts: [] })
  })

  it('opens a three-action menu on workspace row right-click and closes on Escape', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Comate' }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Edit Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open Folder' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Reload Sessions' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes the menu on outside click', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Comate' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes the menu after an action fires', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Comate' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reload Sessions' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('deep-links settings to the right-clicked workspace', () => {
    const onOpenSettingsForWorkspace = vi.fn()
    renderCenter({ onOpenSettingsForWorkspace })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Hidden tools' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit Workspace' }))

    expect(onOpenSettingsForWorkspace).toHaveBeenCalledWith('ws-2')
  })

  it('invokes the desktop bridge with the workspace folder path', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Comate' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Folder' }))

    expect(openFolderMock).toHaveBeenCalledWith('/tmp/comate')
  })

  it('disables Open Folder when the workspace has no folder path', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Hidden tools' }))

    expect(screen.getByRole('menuitem', { name: 'Open Folder' })).toBeDisabled()
  })

  it('shows an error toast when opening the folder fails', async () => {
    openFolderMock.mockReturnValue(Promise.reject(new Error('nope')))
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Comate' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Folder' }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((toast) => toast.severity === 'error')).toBe(true)
    })
  })

  it('refetches sessions for the reloaded workspace only', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Hidden tools' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reload Sessions' }))

    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-2')
    expect(chatState.fetchSessions).not.toHaveBeenCalledWith('ws-1')
  })

  it('still opens the session-row menu (regression)', () => {
    renderCenter()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Comate' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(screen.getByRole('button', { name: /Needs approval/ }))
    expect(screen.getByRole('menuitem', { name: 'Rename session' })).toBeInTheDocument()
  })
})

describe('AgentCommandCenter focus-time session refresh', () => {
  const FOCUS_DEBOUNCE_MS = 800

  function renderCenter(overrides: Partial<React.ComponentProps<typeof AgentCommandCenter>> = {}) {
    return renderCommandCenter(
      <AgentCommandCenter
        width={288}
        onWidthChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenTodos={vi.fn()}
        onOpenAnalytics={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCapabilities={vi.fn()}
        {...overrides}
      />,
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(workspaceState.workspaces[0] as { folderPath?: string }).folderPath = '/tmp/comate'
    delete (workspaceState.workspaces[1] as { folderPath?: string }).folderPath
    chatState.sessions['ws-1'] = [{
      id: 'session-a',
      workspaceId: 'ws-1',
      name: 'Needs approval',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
      isDraft: true,
      isWip: true,
      source: 'wecom',
    }]
    chatState.sessions['ws-2'] = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes expanded workspaces on window focus after the debounce', () => {
    renderCenter()
    // Mount already fetched each workspace once; clear so only focus-driven
    // calls are counted.
    vi.mocked(chatState.fetchSessions).mockClear()

    fireEvent.focus(window)
    expect(chatState.fetchSessions).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-1')
    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-2')
  })

  it('refreshes expanded workspaces when the document becomes visible', () => {
    renderCenter()
    vi.mocked(chatState.fetchSessions).mockClear()

    act(() => {
      fireEvent(document, new Event('visibilitychange'))
    })
    expect(chatState.fetchSessions).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-1')
  })

  it('does not refresh collapsed workspaces on focus', () => {
    renderCenter()
    // Collapse ws-2 by clicking its workspace row toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Hidden tools' }))
    vi.mocked(chatState.fetchSessions).mockClear()

    fireEvent.focus(window)
    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-1')
    expect(chatState.fetchSessions).not.toHaveBeenCalledWith('ws-2')
  })

  it('collapses rapid re-focus into one fetch per workspace', () => {
    renderCenter()
    vi.mocked(chatState.fetchSessions).mockClear()

    fireEvent.focus(window)
    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS / 2)
    })
    fireEvent.focus(window)
    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS / 2)
    })
    expect(chatState.fetchSessions).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledTimes(2)
  })

  it('does not cancel a pending focus refresh when a workspace is toggled', () => {
    renderCenter()
    vi.mocked(chatState.fetchSessions).mockClear()

    fireEvent.focus(window)
    // Toggle a workspace inside the debounce window: the armed refresh must
    // survive and cover the workspaces expanded when it fires.
    fireEvent.click(screen.getByRole('button', { name: 'Hidden tools' }))
    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledTimes(1)
    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-1')
    expect(chatState.fetchSessions).not.toHaveBeenCalledWith('ws-2')
  })

  it('skips a workspace whose fetch is already in flight', async () => {
    let resolveFetch: ((value: { ok: boolean }) => void) | null = null
    chatState.fetchSessions.mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve }),
    )
    renderCenter()

    fireEvent.focus(window)
    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledWith('ws-1')

    // Second focus while the first fetch is still pending: no duplicate.
    fireEvent.focus(window)
    act(() => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })
    expect(chatState.fetchSessions).toHaveBeenCalledTimes(2) // ws-1 + ws-2 only

    await act(async () => {
      resolveFetch?.({ ok: true })
    })
  })

  it('keeps the streaming session rendered and selection untouched after refresh', async () => {
    chatState.fetchSessions.mockResolvedValue({ ok: true })
    renderCenter()

    fireEvent.focus(window)
    await act(async () => {
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS)
    })

    expect(screen.getByText('Needs approval')).toBeInTheDocument()
    expect(chatState.setActiveSession).not.toHaveBeenCalled()
  })
})
