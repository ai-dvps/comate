import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import SessionTokenUsage from './SessionTokenUsage'
import type { ChatSession, ContextUsage, SessionUsage } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const mockStore = {
  sessions: {} as Record<string, ChatSession[]>,
  sessionUsage: {} as Record<string, SessionUsage>,
  contextUsage: {} as Record<string, ContextUsage>,
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

  it('renders context estimate from sessionUsage when contextUsage is absent', () => {
    mockStore.sessionUsage.s1 = {
      cumulativeInput: 10000,
      cumulativeOutput: 500,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
    }
    renderWithI18n(<SessionTokenUsage sessionId="s1" workspaceId="ws1" />)
    expect(screen.getByText(/Context: 5%/i)).toBeInTheDocument()
  })

  it('renders contextUsage percentage when available', () => {
    mockStore.contextUsage.s1 = {
      totalTokens: 1500,
      maxTokens: 200000,
      percentage: 15,
      categories: [],
    }
    mockStore.sessionUsage.s1 = {
      cumulativeInput: 1000,
      cumulativeOutput: 500,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
    }
    renderWithI18n(<SessionTokenUsage sessionId="s1" workspaceId="ws1" />)
    expect(screen.getByText(/Context: 15%/i)).toBeInTheDocument()
  })
})
