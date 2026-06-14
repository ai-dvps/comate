import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import SessionList from './SessionList'
import i18n from '../i18n'
import type { ChatSession } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
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
  messages: {},
  sessionStatus: {},
  isStreaming: {},
  unreadCompletions: {},
  lastActivityAt: {},
  isLoadingSessions: {},
  setActiveSession: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  toggleSessionWip: vi.fn(),
  toggleSessionArchive: vi.fn(),
  fetchSessions: vi.fn(() => Promise.resolve({ ok: true })),
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ useModifierToSubmit: false }),
}))

describe('SessionList', () => {
  beforeEach(() => {
    mockStore.sessions = {}
    mockStore.activeSessionIds = {}
    mockStore.messages = {}
    mockStore.sessionStatus = {}
    mockStore.isStreaming = {}
    mockStore.unreadCompletions = {}
    mockStore.lastActivityAt = {}
    mockStore.isLoadingSessions = {}
    mockStore.setActiveSession.mockClear()
    mockStore.createSession.mockClear()
    mockStore.renameSession.mockClear()
    mockStore.toggleSessionWip.mockClear()
    mockStore.toggleSessionArchive.mockClear()
    mockStore.fetchSessions.mockClear()
    cleanup()
  })

  it('hides archived sessions by default', () => {
    mockStore.sessions.ws1 = [
      makeSession({ id: 'active', name: 'Active Session' }),
      makeSession({ id: 'archived', name: 'Archived Session', isArchived: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    expect(screen.getByText('Active Session')).toBeInTheDocument()
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument()
  })

  it('reveals archived sessions when the Archived filter is selected', () => {
    mockStore.sessions.ws1 = [
      makeSession({ id: 'active', name: 'Active Session' }),
      makeSession({ id: 'archived', name: 'Archived Session', isArchived: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    const filterSelect = screen.getByLabelText(/Filter sessions/i)
    fireEvent.change(filterSelect, { target: { value: 'archived' } })

    expect(screen.getByText('Archived Session')).toBeInTheDocument()
    expect(screen.queryByText('Active Session')).not.toBeInTheDocument()
  })

  it('shows archived WIP sessions under the WIP filter', () => {
    mockStore.sessions.ws1 = [
      makeSession({ id: 'archived-wip', name: 'Archived WIP', isArchived: true, isWip: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    const filterSelect = screen.getByLabelText(/Filter sessions/i)
    fireEvent.change(filterSelect, { target: { value: 'wip' } })

    expect(screen.getByText('Archived WIP')).toBeInTheDocument()
  })

  it('lists active and archived sessions together under All', () => {
    mockStore.sessions.ws1 = [
      makeSession({ id: 'active', name: 'Active Session' }),
      makeSession({ id: 'archived', name: 'Archived Session', isArchived: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    const filterSelect = screen.getByLabelText(/Filter sessions/i)
    fireEvent.change(filterSelect, { target: { value: 'all' } })

    expect(screen.getByText('Active Session')).toBeInTheDocument()
    expect(screen.getByText('Archived Session')).toBeInTheDocument()
  })

  it('resets the filter to Active when the workspace changes', () => {
    mockStore.sessions.ws1 = [makeSession({ id: 'archived', name: 'Archived Session', isArchived: true })]
    mockStore.sessions.ws2 = [makeSession({ id: 'active', name: 'Active Session', workspaceId: 'ws2' })]

    const { rerender } = renderWithI18n(<SessionList workspaceId="ws1" />)

    const filterSelect = screen.getByLabelText(/Filter sessions/i)
    fireEvent.change(filterSelect, { target: { value: 'archived' } })
    expect(screen.getByText('Archived Session')).toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <SessionList workspaceId="ws2" />
      </I18nextProvider>,
    )

    expect(screen.getByText('Active Session')).toBeInTheDocument()
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument()
  })
})
