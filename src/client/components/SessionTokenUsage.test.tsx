import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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
  it('uses typed categories instead of English names for summary diagnostics', async () => {
    mockStore.contextUsage.s2 = {
      totalTokens: 20, maxTokens: 100, percentage: 20, detail: 'summary',
      categories: [
        { name: '内容', tokens: 20, kind: 'used' },
        { name: '可用', tokens: 50, kind: 'free' },
        { name: '保留', tokens: 30, kind: 'buffer' },
        { name: '工具库', tokens: 500, kind: 'deferred' },
      ],
    }
    renderWithI18n(<SessionTokenUsage sessionId="s2" />)
    fireEvent.click(screen.getByRole('button', { name: /Context: 20%/i }))
    expect(await screen.findByText(/Summary estimate/)).toBeInTheDocument()
    expect(screen.getByTitle('内容: 20')).toHaveStyle({ width: '20%' })
    expect(screen.queryByTitle('可用: 50')).not.toBeInTheDocument()
    expect(screen.queryByTitle('工具库: 500')).not.toBeInTheDocument()
    expect(screen.getByText(/工具库:/)).toBeInTheDocument()
  })
  it('renders independent dashes when no usage data exists', () => {
    renderWithI18n(<SessionTokenUsage sessionId="s1" />)
    expect(screen.getByLabelText(/Session: —/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Context: —/i)).toBeInTheDocument()
  })

  it('renders cumulative tokens but does not infer context from them', () => {
    mockStore.sessionUsage.s1 = {
      cumulativeTotal: 10500,
      cumulativeInput: 10000,
      cumulativeOutput: 500,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
    }
    renderWithI18n(<SessionTokenUsage sessionId="s1" />)
    expect(screen.getByLabelText(/Session: 11k/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Context: —/i)).toBeInTheDocument()
  })

  it('renders contextUsage percentage when available', () => {
    mockStore.contextUsage.s1 = {
      totalTokens: 1500,
      maxTokens: 200000,
      percentage: 15,
      categories: [],
    }
    mockStore.sessionUsage.s1 = {
      cumulativeTotal: 1500,
      cumulativeInput: 1000,
      cumulativeOutput: 500,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
    }
    renderWithI18n(<SessionTokenUsage sessionId="s1" />)
    expect(screen.getByRole('button', { name: /Context: 15%/i })).toBeInTheDocument()
    expect(document.querySelector('.status-bar-compact-icon')).toBeInTheDocument()
  })
})
