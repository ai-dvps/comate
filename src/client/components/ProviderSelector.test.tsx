import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import ProviderSelector from './ProviderSelector'

const setSessionProvider = vi.fn()
const setSessionCodexSettings = vi.fn()
const backendState = vi.hoisted(() => ({
  defaultBackend: 'claude' as 'claude' | 'codex',
  codexAccount: null as null | { type: 'chatgpt'; email: string; planType: string },
  codexModels: [] as unknown[],
  codexDefaultModel: null as string | null,
  codexDefaultEffort: null as string | null,
  codexDefaultSpeed: null as string | null,
  fetchCodexAccount: vi.fn(),
  fetchCodexModels: vi.fn(),
}))
const sessions: Record<string, Array<{
  id: string
  providerId: string | null
  backend?: 'claude' | 'codex'
  codexModel?: string | null
  codexEffort?: string | null
  codexSpeed?: string | null
}>> = {
  'ws-1': [{ id: 'session-1', providerId: null }],
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({
    sessions,
    isRestartingRuntime: {},
    setSessionProvider,
    setSessionCodexSettings,
  }),
}))

vi.mock('../stores/backend-store', () => ({
  useBackendStore: (selector: (state: unknown) => unknown) => selector(backendState),
}))

vi.mock('../stores/provider-store', () => ({
  providerReasonKey: (reason?: string) => `provider.reasons.${reason ?? 'unavailable'}`,
  useProviderStore: (selector: (state: unknown) => unknown) => selector({
    providers: [
      {
        id: 'provider-1', name: 'Provider One', baseUrl: 'https://one.example', protocol: 'anthropic', isDefault: true,
        availability: {
          claude: { available: true, supportedEfforts: [], speedSupported: false },
          codex: { available: false, reason: 'protocol-unsupported', supportedEfforts: [], speedSupported: false },
          opencode: { available: true, supportedEfforts: [], speedSupported: false },
        },
      },
      {
        id: 'provider-2', name: 'Provider Two', baseUrl: 'https://two.example', protocol: 'openai-responses', isDefault: false,
        configuration: { models: { codex: 'kimi-k2.5' } },
        availability: {
          claude: { available: true, supportedEfforts: [], speedSupported: false },
          codex: { available: true, model: 'kimi-k2.5', supportedEfforts: ['low', 'high'], speedSupported: false },
          opencode: { available: false, reason: 'protocol-unsupported', supportedEfforts: [], speedSupported: false },
        },
      },
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
    setSessionCodexSettings.mockClear()
    backendState.defaultBackend = 'claude'
    backendState.codexAccount = null
    backendState.codexModels = []
    sessions['ws-1'] = [{ id: 'session-1', providerId: null }]
  })

  it('shows the signed-in Codex account with model, effort, and speed controls', () => {
    backendState.defaultBackend = 'codex'
    backendState.codexAccount = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }
    backendState.codexModels = [{
      id: 'model-1',
      model: 'gpt-5.6-codex',
      displayName: 'GPT-5.6 Codex',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
      serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
    }]
    const onProviderChange = vi.fn()
    const onCodexSettingsChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ProviderSelector
          mode="new-chat"
          workspaceId="ws-1"
          backendId="codex"
          providerId={null}
          onProviderChange={onProviderChange}
          codexModel={null}
          codexEffort={null}
          codexSpeed={null}
          onCodexSettingsChange={onCodexSettingsChange}
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Codex Account/i }))
    expect(screen.getAllByText('Codex Account')).toHaveLength(2)
    const incompatibleProvider = screen.getByRole('button', { name: /Provider One/i })
    expect(incompatibleProvider).toHaveAttribute('aria-disabled', 'true')
    expect(incompatibleProvider).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('This protocol is not supported by the Agent')).toBeInTheDocument()
    expect(screen.getByText('Provider Two')).toBeInTheDocument()
    fireEvent.click(incompatibleProvider)
    expect(onProviderChange).not.toHaveBeenCalled()
    fireEvent.keyDown(incompatibleProvider, { key: 'Enter' })
    expect(onProviderChange).not.toHaveBeenCalled()
    fireEvent.keyDown(incompatibleProvider, { key: ' ' })
    expect(onProviderChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: 'fast' } })

    expect(onCodexSettingsChange).toHaveBeenCalledWith({
      codexModel: null, codexEffort: 'high', codexSpeed: null,
    })
    fireEvent.click(screen.getByText('Provider Two'))
    expect(onProviderChange).toHaveBeenCalledWith('provider-2')
  })

  it('filters third-party effort from server capabilities and hides speed', () => {
    backendState.defaultBackend = 'codex'
    const onCodexSettingsChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ProviderSelector mode="new-chat" workspaceId="ws-1" backendId="codex" providerId="provider-2" onProviderChange={vi.fn()} codexEffort="medium" codexSpeed="fast" onCodexSettingsChange={onCodexSettingsChange} />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Provider Two/i }))
    expect(screen.getByRole('option', { name: 'medium (unsupported)' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Speed')).not.toBeInTheDocument()
    expect(screen.getByText(/Speed is managed only by a native Codex Account/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } })
    expect(onCodexSettingsChange).toHaveBeenCalledWith({ codexModel: 'kimi-k2.5', codexEffort: 'high', codexSpeed: null })
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

  it('handles a rejected session Codex settings request at the event boundary', async () => {
    backendState.defaultBackend = 'codex'
    backendState.codexAccount = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }
    backendState.codexModels = [{
      id: 'model-1',
      model: 'gpt-5.6-codex',
      displayName: 'GPT-5.6 Codex',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
      serviceTiers: [],
    }]
    sessions['ws-1'] = [{
      id: 'session-1',
      providerId: null,
      backend: 'codex',
      codexModel: null,
      codexEffort: null,
      codexSpeed: null,
    }]
    setSessionCodexSettings.mockRejectedValueOnce(new Error('save failed'))

    render(
      <I18nextProvider i18n={i18n}>
        <ProviderSelector workspaceId="ws-1" sessionId="session-1" />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Codex Account/i }))
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } })
    await Promise.resolve()

    expect(setSessionCodexSettings).toHaveBeenCalledWith('ws-1', 'session-1', {
      codexModel: null,
      codexEffort: 'high',
      codexSpeed: null,
    })
  })
})
