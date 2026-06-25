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
  approvalQueue: {},
  messages: {},
  domCache: {},
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

vi.mock('../stores/provider-store', () => ({
  useProviderStore: (selector: (state: { providers: [] }) => unknown) =>
    selector({ providers: [] }),
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
  default: () => null,
}))

vi.mock('./StatusBar', () => ({
  default: () => null,
}))

vi.mock('./MessageSearchBar', () => ({
  default: () => null,
}))

vi.mock('./ChatEmptyState', () => ({
  default: () => <div data-testid="chat-empty-state" />,
}))

describe('ChatPanel', () => {
  beforeEach(() => {
    mockChatStore.sessions = {}
    mockChatStore.activeSessionIds = {}
    mockChatStore.isStreaming = {}
    mockChatStore.isLoadingMessages = {}
    mockChatStore.approvalQueue = {}
    mockChatStore.messages = {}
    mockChatStore.domCache = {}
  })

  it('hides the prompt input when no session is active', () => {
    mockChatStore.activeSessionIds = { ws1: undefined }

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-surface')).not.toBeInTheDocument()
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

    renderWithI18n(<ChatPanel workspaceId="ws1" />)

    expect(screen.queryByTestId('approval-surface')).not.toBeInTheDocument()
    expect(screen.queryByTestId('prompt-input')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for the bot user to respond in chat...')).toBeInTheDocument()
  })
})
