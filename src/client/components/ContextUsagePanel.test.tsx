import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import ContextUsagePanel from './ContextUsagePanel'
import type { ContextUsage } from '../stores/chat-store'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const mockUsage: ContextUsage = {
  totalTokens: 1200,
  maxTokens: 200000,
  percentage: 0.6,
  categories: [
    { name: 'Messages', tokens: 1000, color: '#3b82f6' },
    { name: 'Tools', tokens: 200, color: '#10b981' },
  ],
}

const mockStore = {
  contextUsage: {} as Record<string, ContextUsage>,
  fetchContextUsage: vi.fn(async (_workspaceId: string, sessionId: string) => {
    mockStore.contextUsage[sessionId] = mockUsage
    return { ok: true, data: mockUsage }
  }),
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

describe('ContextUsagePanel', () => {
  beforeEach(() => {
    mockStore.contextUsage = {}
    mockStore.fetchContextUsage.mockClear()
  })

  it('opens and fetches context usage when clicked', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ContextUsagePanel sessionId="s1" workspaceId="ws1" />)

    const button = screen.getByRole('button', { name: /Context usage/i })
    await user.click(button)

    expect(mockStore.fetchContextUsage).toHaveBeenCalledWith('ws1', 's1')

    await waitFor(() => {
      expect(screen.getByText('1.2k / 200.0k tokens')).toBeInTheDocument()
    })
    expect(screen.getByText('Messages')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
  })

  it('shows cached usage without refetching when already available', async () => {
    mockStore.contextUsage.s1 = mockUsage
    const user = userEvent.setup()
    renderWithI18n(<ContextUsagePanel sessionId="s1" workspaceId="ws1" />)

    const button = screen.getByRole('button', { name: /0\.6%/i })
    await user.click(button)

    expect(mockStore.fetchContextUsage).toHaveBeenCalledWith('ws1', 's1')
  })

  it('displays an error message when fetching fails', async () => {
    mockStore.fetchContextUsage.mockResolvedValue({ ok: false, error: 'Session is not active' } as unknown as Awaited<
      ReturnType<typeof mockStore.fetchContextUsage>
    >)
    const user = userEvent.setup()
    renderWithI18n(<ContextUsagePanel sessionId="s1" workspaceId="ws1" />)

    const button = screen.getByRole('button', { name: /Context usage/i })
    await user.click(button)

    await waitFor(() => {
      expect(screen.getByText('Session is not active')).toBeInTheDocument()
    })
  })
})
