import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import MessageList from './MessageList'
import i18n from '../i18n'
import type { ChatMessage } from '../types/message'
import type { ChatSession } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

function makeMessage(text: string, id = 'msg-1'): ChatMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    timestamp: 1,
  }
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const now = new Date().toISOString()
  return {
    id: 's1',
    workspaceId: 'ws1',
    name: 'Session',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const mockStore = {
  sessions: {} as Record<string, ChatSession[]>,
  activeSessionIds: {} as Record<string, string | undefined>,
  messages: {} as Record<string, ChatMessage[]>,
  sessionStatus: {},
  isStreaming: {},
  unreadCompletions: {},
  lastActivityAt: {},
  isLoadingSessions: {},
  domCache: {} as Record<string, string[]>,
  totalMessageCount: {},
  isLoadingOlderMessages: {},
  isCompacting: {},
  isLoadingMessages: {},
  approvalQueue: {},
  autoApprovedTools: {} as Record<string, Record<string, 'auto' | 'readonly'>>,
  compactingStartTime: {},
  setActiveSession: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  toggleSessionWip: vi.fn(),
  toggleSessionArchive: vi.fn(),
  fetchSessions: vi.fn(() => Promise.resolve({ ok: true })),
  sendMessage: vi.fn(),
  loadMessages: vi.fn(),
  refreshBotMessages: vi.fn(),
  resolveApproval: vi.fn(),
  interruptSession: vi.fn(),
  cleanupWorkspace: vi.fn(),
  fetchOlderMessages: vi.fn(),
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ chatFontSize: 'base', useModifierToSubmit: false }),
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const noop = () => {}

describe('MessageList search integration', () => {
  beforeEach(() => {
    mockStore.sessions = {}
    mockStore.activeSessionIds = {}
    mockStore.messages = {}
    mockStore.domCache = {}
    mockStore.autoApprovedTools = {}
    cleanup()
  })

  it('renders highlighted matches when search props are provided', () => {
    mockStore.sessions.ws1 = [makeSession()]
    mockStore.activeSessionIds.ws1 = 's1'
    mockStore.domCache.ws1 = ['s1']
    mockStore.messages.s1 = [makeMessage('hello world')]

    const matches = [{ messageId: 'msg-1', partIndex: 0, start: 6, end: 11 }]
    renderWithI18n(
      <MessageList
        sessionId="s1"
        workspaceId="ws1"
        onOpenDrawer={noop}
        searchMatches={matches}
        currentMatch={matches[0]}
      />,
    )

    const active = document.querySelector('[data-search-active="true"]')
    expect(active).toHaveTextContent('world')
  })

  it('renders no highlights when search props are empty', () => {
    mockStore.sessions.ws1 = [makeSession()]
    mockStore.activeSessionIds.ws1 = 's1'
    mockStore.domCache.ws1 = ['s1']
    mockStore.messages.s1 = [makeMessage('hello world')]

    renderWithI18n(
      <MessageList sessionId="s1" workspaceId="ws1" onOpenDrawer={noop} />,
    )

    expect(document.querySelector('[data-search-active="true"]')).toBeNull()
    expect(screen.getByText('hello world')).toBeInTheDocument()
  })
})
