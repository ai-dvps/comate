import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  forkSession: vi.fn(() => Promise.resolve({ ok: true })),
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

async function selectFilter(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: /Filter sessions/i }))
  const option = await screen.findByRole('option', { name: new RegExp(label, 'i') })
  await user.click(option)
}

describe('SessionList', () => {
  beforeAll(() => {
    globalThis.ResizeObserver = vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })) as unknown as typeof ResizeObserver
  })

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
    mockStore.forkSession.mockClear()
    mockStore.toggleSessionWip.mockClear()
    mockStore.toggleSessionArchive.mockClear()
    mockStore.fetchSessions.mockClear()
    cleanup()
  })

  it('hides archived sessions by default and uses the custom popover control', () => {
    mockStore.sessions.ws1 = [
      makeSession({ id: 'active', name: 'Active Session' }),
      makeSession({ id: 'archived', name: 'Archived Session', isArchived: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    expect(screen.getByText('Active Session')).toBeInTheDocument()
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Filter sessions/i })).toBeInTheDocument()
  })

  it('reveals archived sessions when the Archived filter is selected', async () => {
    const user = userEvent.setup()
    mockStore.sessions.ws1 = [
      makeSession({ id: 'active', name: 'Active Session' }),
      makeSession({ id: 'archived', name: 'Archived Session', isArchived: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    await selectFilter(user, 'Archived')

    expect(screen.getByText('Archived Session')).toBeInTheDocument()
    expect(screen.queryByText('Active Session')).not.toBeInTheDocument()
  })

  it('shows archived WIP sessions under the WIP filter', async () => {
    const user = userEvent.setup()
    mockStore.sessions.ws1 = [
      makeSession({ id: 'archived-wip', name: 'Archived WIP', isArchived: true, isWip: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    await selectFilter(user, 'WIP')

    expect(screen.getByText('Archived WIP')).toBeInTheDocument()
  })

  it('lists active and archived sessions together under All', async () => {
    const user = userEvent.setup()
    mockStore.sessions.ws1 = [
      makeSession({ id: 'active', name: 'Active Session' }),
      makeSession({ id: 'archived', name: 'Archived Session', isArchived: true }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    await selectFilter(user, 'All')

    expect(screen.getByText('Active Session')).toBeInTheDocument()
    expect(screen.getByText('Archived Session')).toBeInTheDocument()
  })

  it('resets the filter to Active when the workspace changes', async () => {
    const user = userEvent.setup()
    mockStore.sessions.ws1 = [makeSession({ id: 'archived', name: 'Archived Session', isArchived: true })]
    mockStore.sessions.ws2 = [makeSession({ id: 'active', name: 'Active Session', workspaceId: 'ws2' })]

    const { rerender } = renderWithI18n(<SessionList workspaceId="ws1" />)

    await selectFilter(user, 'Archived')
    expect(screen.getByText('Archived Session')).toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <SessionList workspaceId="ws2" />
      </I18nextProvider>,
    )

    expect(screen.getByText('Active Session')).toBeInTheDocument()
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument()
  })

  it('forks a session from the context menu and calls the store action', async () => {
    const user = userEvent.setup()
    mockStore.sessions.ws1 = [makeSession({ id: 's1', name: 'Session to fork' })]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    const row = screen.getByText('Session to fork')
    await user.pointer([{ keys: '[MouseRight]', target: row }])

    const forkButton = await screen.findByRole('button', { name: /Fork session/i })
    await user.click(forkButton)

    expect(mockStore.forkSession).toHaveBeenCalledWith('ws1', 's1')
  })

  it('renders the bot source icon on bot-sourced sessions and no icon on gui sessions', () => {
    mockStore.sessions.ws1 = [
      makeSession({ id: 'feishu-s', name: 'Feishu Chat', source: 'feishu' }),
      makeSession({ id: 'wecom-s', name: 'WeCom Chat', source: 'wecom' }),
      makeSession({ id: 'gui-s', name: 'Gui Chat' }),
    ]

    renderWithI18n(<SessionList workspaceId="ws1" />)

    // Feishu and WeCom icons render for their respective sources.
    expect(screen.getByAltText('Feishu')).toBeInTheDocument()
    expect(screen.getByAltText('WeCom')).toBeInTheDocument()
    // Exactly two bot icons — a gui/default session renders neither.
    expect(screen.getAllByAltText(/^(Feishu|WeCom)$/)).toHaveLength(2)
    // The old Feishu text badge is gone.
    expect(screen.queryByText('Feishu')).not.toBeInTheDocument()
  })
})
