import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { useProviderStore, type Provider, type ProviderConfiguration, type ProviderPreset } from '../stores/provider-store'
import { useProviderUsageStore } from '../stores/provider-usage-store'
import ProviderSection from './ProviderSection'

const customConfiguration: ProviderConfiguration = {
  schemaVersion: 1,
  endpoints: {
    anthropic: { enabled: false, baseUrl: '' },
    openai: { enabled: false, baseUrl: '', format: 'openai-responses' },
  },
  models: {}, openCode: { protocol: 'anthropic' }, claude: {},
  codex: { promptCacheRouting: 'unsupported', thinking: 'unknown' },
  preset: { id: 'custom', version: 1 },
}
const kimiConfiguration: ProviderConfiguration = {
  schemaVersion: 1,
  endpoints: {
    anthropic: { enabled: true, baseUrl: 'https://api.kimi.com/coding' },
    openai: { enabled: true, baseUrl: 'https://api.kimi.com/coding/v1', format: 'openai-chat-completions' },
  },
  models: { claudeCode: 'kimi-k2.5', codex: 'kimi-k2.5', openCode: 'kimi-k2.5' },
  openCode: { protocol: 'openai' }, claude: {},
  codex: { promptCacheRouting: 'auto', thinking: 'required', effortByModel: { 'kimi-k2.5': ['low', 'high', 'xhigh'] } },
  preset: { id: 'kimi', version: 1 },
}
const presets: ProviderPreset[] = [
  { id: 'kimi', version: 1, name: 'Kimi For Coding', vendorId: 'kimi', configuration: kimiConfiguration, capabilities: { promptCacheRouting: 'auto', thinking: 'required', codexEffortWireMapping: {}, thirdPartySpeed: false } },
  { id: 'custom', version: 1, name: 'Custom', vendorId: 'custom', configuration: customConfiguration, capabilities: { promptCacheRouting: 'unsupported', thinking: 'unknown', codexEffortWireMapping: {}, thirdPartySpeed: false } },
]

function kimiProvider(): Provider {
  const providerId = 'provider-kimi'
  return {
    id: providerId,
    name: 'Kimi',
    configuration: kimiConfiguration,
    authTokenPresent: true,
    isDefault: false,
    availability: {
      claude: { available: true, providerId, agent: 'claude', mode: 'anthropic', supportedEfforts: [], speedSupported: false },
      codex: { available: true, providerId, agent: 'codex', mode: 'routed', supportedEfforts: ['low', 'high', 'xhigh'], speedSupported: false },
      opencode: { available: true, providerId, agent: 'opencode', mode: 'openai', supportedEfforts: [], speedSupported: false },
    },
    baseUrl: 'https://api.kimi.com/coding/v1',
    protocol: 'openai-responses',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function renderSection() {
  return render(<I18nextProvider i18n={i18n}><ProviderSection /></I18nextProvider>)
}

describe('ProviderSection', () => {
  beforeEach(() => {
    useProviderStore.setState({
      providers: [], presets, isLoading: false, presetsLoading: false, isSaving: false,
      error: null,
      fetchProviders: vi.fn().mockResolvedValue(undefined),
      fetchPresets: vi.fn().mockResolvedValue(undefined),
      clearError: vi.fn(),
    })
    useProviderUsageStore.setState({ usageByProvider: {}, login: null })
  })

  it('copies Kimi documented defaults into an editable multi-protocol draft', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getByRole('button', { name: 'Create First Provider' }))
    await user.click(screen.getByRole('button', { name: 'Kimi For Coding' }))

    expect(screen.getByLabelText('OpenAI endpoint Base URL')).toHaveValue('https://api.kimi.com/coding/v1')
    expect(screen.getByLabelText('OpenAI upstream format')).toHaveValue('openai-chat-completions')
    expect(screen.getByLabelText('Codex model')).toHaveValue('kimi-k2.5')
    expect(screen.getByLabelText('Protocol used by OpenCode')).toHaveValue('openai')
  })

  it('confirms before a preset switch discards dirty edits', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getByRole('button', { name: 'Create First Provider' }))
    await user.type(screen.getByLabelText(/Name/), 'My Provider')
    await user.click(screen.getByRole('button', { name: 'Kimi For Coding' }))

    expect(screen.getByRole('dialog', { name: 'Replace the current draft?' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Name/)).toHaveValue('My Provider')
    await user.click(screen.getByRole('button', { name: 'Apply preset' }))
    expect(screen.getByLabelText(/Name/)).toHaveValue('Kimi For Coding')
  })

  it('accepts internal HTTP endpoints and reports disabled endpoints without network requests', async () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Create First Provider' }))
    const anthropicUrl = screen.getByLabelText('Anthropic endpoint Base URL')
    fireEvent.change(anthropicUrl, { target: { value: 'http://llm.internal:8080/v1' } })

    expect(screen.getByText('Not tested')).toBeInTheDocument()
    expect(screen.queryByText('Structurally invalid HTTP(S) URL')).not.toBeInTheDocument()
    expect(screen.getByText('HTTP sends credentials and model traffic without encryption. Use it only for a trusted internal service.')).toBeInTheDocument()
    expect(screen.getByText('Skipped — endpoint disabled')).toBeInTheDocument()

    fireEvent.change(anthropicUrl, { target: { value: 'http://llm.internal:0/v1' } })
    expect(screen.getByText('Structurally invalid HTTP(S) URL')).toBeInTheDocument()
  })

  it('loads the truthful affected-session count before opening delete confirmation', async () => {
    const user = userEvent.setup()
    const provider = kimiProvider()
    const getDeleteImpact = vi.fn().mockResolvedValue({ ok: true, affectedSessionCount: 3 })
    useProviderStore.setState({ providers: [provider], getDeleteImpact })

    renderSection()
    await user.click(screen.getByRole('button', { name: 'Delete Kimi' }))

    expect(getDeleteImpact).toHaveBeenCalledWith('provider-kimi')
    expect(screen.getByRole('dialog', { name: 'Delete Provider?' })).toHaveTextContent(
      'This Provider is referenced by 3 sessions',
    )
  })

  it('keeps the full coding-plan usage details and refresh action', () => {
    const provider = kimiProvider()
    useProviderStore.setState({ providers: [provider] })
    useProviderUsageStore.setState({
      usageByProvider: {
        'provider-kimi': {
          status: 'ready',
          summary: {
            used: 3, total: 10, remaining: 7,
            resetDate: '2026-08-25T00:00:00.000Z',
            rolling: { remaining: 4, resetDate: '2026-08-24T05:00:00.000Z' },
            lastUpdated: '2026-08-24T00:00:00.000Z',
          },
          lastUpdated: Date.now(),
        },
      },
    })

    renderSection()

    expect(screen.getByText('7 left')).toBeInTheDocument()
    expect(screen.getByText(/5h window/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeInTheDocument()
  })
})
