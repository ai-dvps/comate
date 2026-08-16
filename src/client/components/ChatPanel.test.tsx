import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import ChatPanel from './ChatPanel'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const mockChatStore = {
  sessions: {},
  activeSessionIds: {},
  isStreaming: {},
  isLoadingMessages: {},
  historyLoadState: {} as Record<string, 'loading' | 'loaded'>,
  approvalQueue: {},
  messages: {},
  domCache: {},
  workflows: {} as Record<string, unknown[]>,
  tasks: {} as Record<string, unknown[]>,
  fetchSessions: vi.fn(),
  sendMessage: vi.fn(),
  loadMessages: vi.fn(),
  refreshBotMessages: vi.fn(),
  resolveApproval: vi.fn(),
  interruptSession: vi.fn(),
  cleanupWorkspace: vi.fn(),
  createSession: vi.fn(),
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockChatStore) => unknown) =>
    selector(mockChatStore),
}))

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (state: { workspaces: { id: string; name: string }[] }) => unknown) =>
    selector({ workspaces: [{ id: 'ws1', name: 'Test Workspace' }] }),
}))

vi.mock('../hooks/useMessageSearch', () => ({
  useMessageSearch: () => ({
    query: '',
    setQuery: vi.fn(),
    matches: [],
    currentMatch: null,
    currentMatchIndex: 0,
    totalMatches: 0,
    nextMatch: vi.fn(),
    prevMatch: vi.fn(),
    isSearching: false,
  }),
}))

vi.mock('./PromptInput', () => ({
  default: () => <div data-testid="prompt-input" />,
}))

vi.mock('./ApprovalSurface', () => ({
  default: () => <div data-testid="approval-surface" />,
  CHAT_ABOUT_THIS_MESSAGE: '',
}))

vi.mock('./MessageList', () => ({
  default: () => <div data-testid="message-list" />,
}))

vi.mock('./SubagentDrawer', () => ({
  default: () => null,
}))

vi.mock('./TaskPanel', () => ({
  default: ({ sessionId }: { sessionId: string }) =>
    mockChatStore.tasks[sessionId]?.length ? (
      <div data-testid="task-panel">Tasks</div>
    ) : null,
}))

vi.mock('./StatusBar', () => ({
  default: () => null,
}))

vi.mock('./MessageSearchBar', () => ({
  default: () => null,
}))

vi.mock('./WorkflowFloatingPanel', () => ({
  default: ({ sessionId }: { sessionId: string }) =>
    mockChatStore.workflows[sessionId]?.length ? (
      <div data-testid="workflow-floating-panel">Workflows</div>
    ) : null,
}))

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStore.sessions = {}
    mockChatStore.activeSessionIds = {}
    mockChatStore.isStreaming = {}
    mockChatStore.isLoadingMessages = {}
    mockChatStore.historyLoadState = {}
    mockChatStore.approvalQueue = {}
    mockChatStore.messages = {}
    mockChatStore.domCache = {}
    mockChatStore.workflows = {}
    mockChatStore.tasks = {}
  })

  it('hides the prompt input when no session is active', () => {
    mockChatStore.activeSessionIds = { ws1: undefined }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-surface')).not.toBeInTheDocument()
    expect(screen.queryByText('Start a conversation')).not.toBeInTheDocument()
  })

  it('renders the prompt input when a session is active', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.getByTestId('prompt-input')).toBeInTheDocument()
  })

  it('renders the approval surface when a session has a pending approval', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }
    mockChatStore.approvalQueue = {
      s1: [
        {
          requestId: 'r1',
          type: 'tool',
          toolName: 'test',
        },
      ],
    }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.getByTestId('approval-surface')).toBeInTheDocument()
    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument()
  })

  it('renders a non-interactive pending banner for bot-session approvals', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }
    mockChatStore.sessions = {
      ws1: [
        {
          id: 's1',
          workspaceId: 'ws1',
          name: 'WeCom Session',
          source: 'wecom',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          isDraft: false,
        },
      ],
    }
    mockChatStore.approvalQueue = {
      s1: [
        {
          requestId: 'r1',
          type: 'tool',
          toolName: 'test',
        },
      ],
    }
    mockChatStore.historyLoadState = { s1: 'loaded' }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.queryByTestId('approval-surface')).not.toBeInTheDocument()
    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for the bot user to respond in chat...')).toBeInTheDocument()
  })

  it('loads complete history even when live-only messages already exist', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [{ id: 'live-1', role: 'assistant', parts: [], timestamp: 1 }] }
    mockChatStore.sessions = {
      ws1: [{
        id: 's1',
        workspaceId: 'ws1',
        name: 'Existing session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        isDraft: false,
      }],
    }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(mockChatStore.loadMessages).toHaveBeenCalledWith('ws1', 's1')
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversation history')
    expect(screen.queryByTestId('message-list')).not.toBeInTheDocument()
  })

  it('renders the message list after complete history is loaded', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }
    mockChatStore.historyLoadState = { s1: 'loaded' }
    mockChatStore.sessions = {
      ws1: [{
        id: 's1',
        workspaceId: 'ws1',
        name: 'Existing session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        isDraft: false,
      }],
    }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.getByTestId('message-list')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not loop the automatic history request after a load failure', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }
    mockChatStore.sessions = {
      ws1: [{
        id: 's1',
        workspaceId: 'ws1',
        name: 'Existing session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        isDraft: false,
      }],
    }

    const rendered = renderWithI18n(<ChatPanel workspaceId="ws1" />)
    mockChatStore.historyLoadState = { s1: 'loading' }
    rendered.rerender(<I18nextProvider i18n={i18n}><ChatPanel workspaceId="ws1" /></I18nextProvider>)
    mockChatStore.historyLoadState = {}
    rendered.rerender(<I18nextProvider i18n={i18n}><ChatPanel workspaceId="ws1" /></I18nextProvider>)

    expect(mockChatStore.loadMessages).toHaveBeenCalledTimes(1)
  })

  it('does not render the floating wrapper when no workflows or tasks are active', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.queryByTestId('workflow-floating-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
  })

  it('does not render a redundant message header above the conversation', () => {
    mockChatStore.activeSessionIds = { ws1: 's1' }
    mockChatStore.domCache = { ws1: ['s1'] }
    mockChatStore.messages = { s1: [] }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.queryByText('No session')).not.toBeInTheDocument()
    expect(screen.queryByText('claude-sonnet-4-6')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Collapse context panel' })).not.toBeInTheDocument()
  })
})
