import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentCommandCenter from './AgentCommandCenter'

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
      },
    ],
  },
  activeSessionIds: { 'ws-1': 'session-a' },
  sessionStatus: { 'session-a': { pendingCount: 1, pendingKind: 'approval' } },
  sessionActivity: { 'session-a': { active: true, phase: 'background', backgroundTasks: [] } },
  isStreaming: { 'session-a': true },
  unreadCompletions: {},
  lastActivityAt: {},
  setActiveSession: vi.fn(),
  createSession: vi.fn(),
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
}))

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}))

vi.mock('../hooks/use-channel-statuses', () => ({
  useChannelStatuses: () => ({}),
  getChannelStatusLabel: () => '',
}))

vi.mock('../hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}))

describe('AgentCommandCenter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows Workspace groups, Session supervision state, and footer controls', () => {
    render(
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

    expect(screen.getByRole('complementary', { name: 'Agent Command Center' })).toBeInTheDocument()
    expect(screen.getByText('Comate')).toBeInTheDocument()
    expect(screen.getByText('Needs approval')).toBeInTheDocument()
    expect(screen.getByText('Approval')).toBeInTheDocument()
    expect(screen.getAllByText('WIP')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'User account' })).toBeInTheDocument()
  })

  it('finds and opens a defined Workspace that is not already open', () => {
    render(
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

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search workspaces and sessions' }), {
      target: { value: 'Hidden' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Open Hidden tools/ }))
    expect(workspaceState.openWorkspace).toHaveBeenCalledWith('ws-2')
  })
})
