import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import ProviderSelector from './ProviderSelector'

const setSessionProvider = vi.fn()
const sessions = {
  'ws-1': [{ id: 'session-1', providerId: null }],
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({
    sessions,
    isRestartingRuntime: {},
    setSessionProvider,
  }),
}))

vi.mock('../stores/provider-store', () => ({
  useProviderStore: (selector: (state: unknown) => unknown) => selector({
    providers: [
      { id: 'provider-1', name: 'Provider One', baseUrl: 'https://one.example', isDefault: true },
      { id: 'provider-2', name: 'Provider Two', baseUrl: 'https://two.example', isDefault: false },
    ],
    fetchProviders: vi.fn(),
  }),
}))

vi.mock('../stores/provider-usage-store', () => ({
  useProviderUsageStore: (selector: (state: unknown) => unknown) => selector({
    usageByProvider: {},
    fetchUsage: vi.fn(),
    startUsageLogin: vi.fn(),
    login: null,
  }),
  hasUsageSupport: () => false,
  formatRemaining: () => null,
  usagePercentage: () => null,
  usageBarColor: () => '',
}))

describe('ProviderSelector', () => {
  beforeEach(() => {
    setSessionProvider.mockClear()
  })

  it('selects a provider without requiring an existing session in New Chat mode', () => {
    const onProviderChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ProviderSelector
          mode="new-chat"
          workspaceId="ws-1"
          providerId={null}
          onProviderChange={onProviderChange}
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Provider One/i }))
    fireEvent.click(screen.getByText('Provider Two'))

    expect(onProviderChange).toHaveBeenCalledWith('provider-2')
    expect(setSessionProvider).not.toHaveBeenCalled()
  })

  it('keeps the existing session provider update path unchanged', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ProviderSelector workspaceId="ws-1" sessionId="session-1" />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Provider One/i }))
    fireEvent.click(screen.getByText('Provider Two'))

    expect(setSessionProvider).toHaveBeenCalledWith('ws-1', 'session-1', 'provider-2')
  })
})
