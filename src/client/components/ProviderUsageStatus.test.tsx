import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import ProviderUsageStatus from './ProviderUsageStatus'

const mockChatStore = {
  sessions: {
    ws1: [{ id: 's1', providerId: 'p2' }],
  },
}

const mockProviderStore = {
  providers: [
    { id: 'p1', name: 'Default', baseUrl: 'https://api.example.com', isDefault: true },
    { id: 'p2', name: 'Kimi', baseUrl: 'https://www.kimi.com', isDefault: false },
  ],
}

const fetchUsage = vi.fn().mockResolvedValue(undefined)
const mockUsageStore = {
  usageByProvider: {
    p2: {
      status: 'ready',
      summary: {
        used: 20,
        total: 100,
        remaining: 80,
        resetDate: null,
        rolling: null,
        lastUpdated: '2026-08-04T00:00:00.000Z',
      },
      lastUpdated: Date.now(),
    },
  },
  fetchUsage,
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: typeof mockChatStore) => unknown) => selector(mockChatStore),
}))

vi.mock('../stores/provider-store', () => ({
  useProviderStore: (selector: (state: typeof mockProviderStore) => unknown) => selector(mockProviderStore),
}))

vi.mock('../stores/provider-usage-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/provider-usage-store')>()
  return {
    ...actual,
    useProviderUsageStore: (selector: (state: typeof mockUsageStore) => unknown) => selector(mockUsageStore),
  }
})

function renderComponent() {
  return render(
    <I18nextProvider i18n={i18n}>
      <ProviderUsageStatus sessionId="s1" workspaceId="ws1" />
    </I18nextProvider>,
  )
}

describe('ProviderUsageStatus', () => {
  beforeEach(() => {
    fetchUsage.mockClear()
  })

  it('loads and displays usage for the provider selected by the current session', async () => {
    renderComponent()

    expect(screen.getByText(/Usage: 20 \/ 100/i)).toBeInTheDocument()
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledWith('p2'))
  })

  it('renders nothing when the selected provider does not support usage', () => {
    mockChatStore.sessions.ws1[0].providerId = 'p1'

    const { container } = renderComponent()

    expect(container).toBeEmptyDOMElement()
    expect(fetchUsage).not.toHaveBeenCalled()
    mockChatStore.sessions.ws1[0].providerId = 'p2'
  })
})
