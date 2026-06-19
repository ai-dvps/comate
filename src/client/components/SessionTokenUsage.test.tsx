import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import SessionTokenUsage from './SessionTokenUsage'
import type { ChatSession, ResultMeta, SessionUsage } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const mockStore = {
  sessions: {} as Record<string, ChatSession[]>,
  sessionUsage: {} as Record<string, SessionUsage>,
  resultMeta: {} as Record<string, ResultMeta>,
}

const mockProviders = {
  providers: [
    {
      id: 'p1',
      name: 'Test Provider',
      model: 'claude-sonnet-4-6',
      isDefault: true,
    },
  ],
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

vi.mock('../stores/provider-store', () => ({
  useProviderStore: (selector: (state: typeof mockProviders) => unknown) => selector(mockProviders),
}))

describe('SessionTokenUsage', () => {
  it('renders dashes when no usage data exists', () => {
    renderWithI18n(<SessionTokenUsage sessionId="s1" workspaceId="ws1" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders session token usage', () => {
    mockStore.sessionUsage.s1 = {
      cumulativeInput: 1234,
      cumulativeOutput: 567,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
    }
    renderWithI18n(<SessionTokenUsage sessionId="s1" workspaceId="ws1" />)
    expect(screen.getByText(/Session: in 1.2k \/ out 567/i)).toBeInTheDocument()
    expect(screen.getByText(/Context: \d+%/i)).toBeInTheDocument()
  })

  it('renders result metadata when available', () => {
    mockStore.sessionUsage.s1 = {
      cumulativeInput: 100,
      cumulativeOutput: 50,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
    }
    mockStore.resultMeta.s1 = {
      stopReason: 'end_turn',
      terminalReason: 'completed',
      origin: 'primary',
    }
    renderWithI18n(<SessionTokenUsage sessionId="s1" workspaceId="ws1" />)
    expect(screen.getByText('end_turn · completed · primary')).toBeInTheDocument()
  })
})
