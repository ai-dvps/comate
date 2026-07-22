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

  it('renders slash-command meta message with timestamp', () => {
    mockStore.sessions.ws1 = [makeSession()]
    mockStore.activeSessionIds.ws1 = 's1'
    mockStore.domCache.ws1 = ['s1']
    mockStore.messages.s1 = [
      {
        id: 'msg-slash',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '<command-message></command-message><command-name>test</command-name><command-args>hello</command-args>',
          },
        ],
        timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
      },
    ]

    renderWithI18n(<MessageList sessionId="s1" workspaceId="ws1" onOpenDrawer={noop} />)

    const timestamp = screen.getByText('2026-07-08 14:32')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp).toHaveClass('opacity-0')
  })

  it('renders muted system note with timestamp', () => {
    mockStore.sessions.ws1 = [makeSession()]
    mockStore.activeSessionIds.ws1 = 's1'
    mockStore.domCache.ws1 = ['s1']
    mockStore.messages.s1 = [
      {
        id: 'msg-stdout',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '<local-command-stdout>output</local-command-stdout>',
          },
        ],
        timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
      },
    ]

    renderWithI18n(<MessageList sessionId="s1" workspaceId="ws1" onOpenDrawer={noop} />)

    const timestamp = screen.getByText('2026-07-08 14:32')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp).toHaveClass('opacity-0')
  })

  it('does not render timestamp for system-reminder meta message', () => {
    mockStore.sessions.ws1 = [makeSession()]
    mockStore.activeSessionIds.ws1 = 's1'
    mockStore.domCache.ws1 = ['s1']
    mockStore.messages.s1 = [
      {
        id: 'msg-reminder',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '<system-reminder>Please remember to check the logs</system-reminder>',
          },
        ],
        timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
      },
    ]

    renderWithI18n(<MessageList sessionId="s1" workspaceId="ws1" onOpenDrawer={noop} />)

    expect(screen.queryByText('2026-07-08 14:32')).not.toBeInTheDocument()
  })

  it('renders paired slash-command output with timestamp', () => {
    mockStore.sessions.ws1 = [makeSession()]
    mockStore.activeSessionIds.ws1 = 's1'
    mockStore.domCache.ws1 = ['s1']
    mockStore.messages.s1 = [
      {
        id: 'msg-slash-2',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '<command-message></command-message><command-name>status</command-name><command-args></command-args>',
          },
        ],
        timestamp: new Date(2026, 6, 8, 14, 32).getTime(),
      },
      {
        id: 'msg-out-2',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '<local-command-stdout>ok</local-command-stdout>',
          },
        ],
        timestamp: new Date(2026, 6, 8, 14, 33).getTime(),
      },
    ]

    renderWithI18n(<MessageList sessionId="s1" workspaceId="ws1" onOpenDrawer={noop} />)

    const timestamp = screen.getByText('2026-07-08 14:32')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp).toHaveClass('opacity-0')
  })
})
