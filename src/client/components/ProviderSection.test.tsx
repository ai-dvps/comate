import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  codex: {},
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
  codex: { modelProfiles: { 'kimi-k2.5': { promptCacheRouting: 'auto', thinking: 'required', supportedEfforts: ['low', 'high', 'xhigh'] } } },
  preset: { id: 'kimi', version: 2 },
}
const presets: ProviderPreset[] = [
  { id: 'kimi', version: 2, name: 'Kimi For Coding', vendorId: 'kimi', configuration: kimiConfiguration, capabilities: { promptCacheRouting: 'auto', thinking: 'required', codexEffortWireMapping: {}, thirdPartySpeed: false } },
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
  afterEach(() => vi.restoreAllMocks())

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

  it('switches exact-model capability profiles implicitly and restores prior values', async () => {
    const user = userEvent.setup()
    const provider = kimiProvider()
    useProviderStore.setState({ providers: [provider] })
    renderSection()
    await user.click(screen.getByRole('button', { name: 'Edit Provider' }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))

    const codexContext = screen.getAllByLabelText('Context window (tokens)')[0]
    await user.type(codexContext, '128000')
    expect(codexContext).toHaveValue(128000)

    const codexModel = screen.getByLabelText('Codex model')
    await user.clear(codexModel)
    await user.type(codexModel, 'another-model')
    expect(screen.getAllByLabelText('Context window (tokens)')[0]).toHaveValue(null)

    await user.clear(codexModel)
    await user.type(codexModel, 'kimi-k2.5')
    expect(screen.getAllByLabelText('Context window (tokens)')[0]).toHaveValue(128000)
  })

  it('renders the advanced backend panels in the documented order', async () => {
    const user = userEvent.setup()
    useProviderStore.setState({ providers: [kimiProvider()] })
    const { container } = renderSection()
    await user.click(screen.getByRole('button', { name: 'Edit Provider' }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))

    expect([...container.querySelectorAll('legend')].slice(-3).map((legend) => legend.textContent)).toEqual([
      'Advanced Claude Code capabilities',
      'Advanced Codex capabilities',
      'Advanced OpenCode capabilities',
    ])
    expect(screen.getAllByRole('heading', { name: 'Model limits' })).toHaveLength(2)
    expect(screen.getAllByRole('heading', { name: 'Declared capabilities' })).toHaveLength(2)
    expect(screen.getAllByRole('heading', { name: 'Runtime behavior' })).toHaveLength(2)
  })

  it('adds and removes protocol-aware OpenCode variants', async () => {
    const user = userEvent.setup()
    const provider = kimiProvider()
    const updateProvider = vi.fn().mockResolvedValue({ provider: null })
    useProviderStore.setState({ providers: [provider], updateProvider })
    renderSection()
    await user.click(screen.getByRole('button', { name: 'Edit Provider' }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.click(screen.getByRole('button', { name: 'Add variant' }))

    expect(screen.getByLabelText('Variant name')).toHaveValue('variant-1')
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('high')
    await user.selectOptions(screen.getAllByLabelText('Reasoning summary').at(-1)!, 'concise')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateProvider).toHaveBeenCalledWith('provider-kimi', expect.objectContaining({
      configuration: expect.objectContaining({
        openCode: expect.objectContaining({
          modelProfiles: expect.objectContaining({
            'kimi-k2.5': expect.objectContaining({
              variants: { 'variant-1': { reasoningEffort: 'high', reasoningSummary: 'concise' } },
            }),
          }),
        }),
      }),
    }), expect.any(Object))

    await user.click(screen.getByRole('button', { name: 'Remove variant' }))
    expect(screen.queryByLabelText('Variant name')).not.toBeInTheDocument()
  })

  it('blocks save when OpenCode output exceeds the active context window', async () => {
    const user = userEvent.setup()
    const provider = kimiProvider()
    const updateProvider = vi.fn()
    useProviderStore.setState({ providers: [provider], updateProvider })
    renderSection()
    await user.click(screen.getByRole('button', { name: 'Edit Provider' }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.type(screen.getAllByLabelText('Context window (tokens)')[1], '100')
    await user.type(screen.getByLabelText('Maximum output (tokens)'), '101')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The OpenCode output limit cannot exceed its context window.')
    expect(updateProvider).not.toHaveBeenCalled()
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

  it('masks a saved auth token and reveals it only after the eye is clicked', async () => {
    const user = userEvent.setup()
    const provider = kimiProvider()
    const updateProvider = vi.fn().mockResolvedValue({ provider: null })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ authToken: 'saved-provider-token' }),
    } as Response)
    useProviderStore.setState({ providers: [provider], updateProvider })

    renderSection()
    await user.click(screen.getByRole('button', { name: 'Edit Provider' }))

    const tokenInput = screen.getByPlaceholderText('••••••••') as HTMLInputElement
    expect(tokenInput).toHaveValue('')
    expect(tokenInput.type).toBe('password')

    await user.click(screen.getByRole('button', { name: 'Show token' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/providers/provider-kimi/auth-token/reveal', expect.objectContaining({
      method: 'POST', signal: expect.any(AbortSignal),
    }))
    const revealedInput = await screen.findByDisplayValue('saved-provider-token')
    expect(revealedInput).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: 'Hide token' }))
    expect(revealedInput).toHaveAttribute('type', 'password')
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/providers/provider-kimi/auth-token/reveal')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateProvider).toHaveBeenCalledWith(
      'provider-kimi',
      expect.objectContaining({ authToken: '' }),
      expect.any(Object),
    )
  })

  it('keeps a saved auth token masked when reveal fails', async () => {
    const user = userEvent.setup()
    const provider = { ...kimiProvider(), configuration: customConfiguration }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Reveal failed' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authToken: 'token-after-retry' }),
      } as Response)
    useProviderStore.setState({ providers: [provider] })

    renderSection()
    await user.click(screen.getByRole('button', { name: 'Edit Provider' }))
    await user.click(screen.getByRole('button', { name: 'Show token' }))

    const tokenInput = screen.getByPlaceholderText('••••••••')
    expect(tokenInput).toHaveAttribute('type', 'password')
    expect(tokenInput).toHaveValue('')
    expect(await screen.findByRole('alert')).toHaveTextContent('Reveal failed')
    expect(useProviderStore.getState().error).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Show token' }))
    expect(await screen.findByDisplayValue('token-after-retry')).toHaveAttribute('type', 'text')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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
