import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { useBackendStore } from '../stores/backend-store'
import BackendSection from './BackendSection'

const setDefaultBackend = vi.fn().mockResolvedValue(undefined)

function renderSection() {
  return render(
    <I18nextProvider i18n={i18n}>
      <BackendSection />
    </I18nextProvider>,
  )
}

describe('BackendSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outputStyle: null }),
    }))
    setDefaultBackend.mockResolvedValue(undefined)
    useBackendStore.setState({
      backends: [
        {
          id: 'claude',
          availability: { status: 'available' },
          capabilities: {},
        },
        {
          id: 'opencode',
          availability: { status: 'unavailable', reason: 'Runtime missing' },
          capabilities: {},
        },
      ],
      defaultBackend: 'claude',
      isLoading: false,
      error: null,
      fetchBackends: vi.fn().mockResolvedValue(undefined),
      setDefaultBackend,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes agent choices as a single-select group', () => {
    renderSection()

    expect(screen.getByRole('radiogroup', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Open Code/ })).not.toBeChecked()
  })

  it('exposes output style as a Claude Code-only agent setting', () => {
    renderSection()

    const claudeOption = screen.getByRole('radio', { name: /Claude Code/ })
      .closest('[data-backend-option="claude"]')

    expect(claudeOption).toContainElement(screen.getByRole('combobox', { name: 'Output style' }))
  })

  it('shows Agent settings by default and lets users collapse them', async () => {
    const user = userEvent.setup()
    renderSection()

    const collapseSettings = screen.getByRole('button', { name: 'Collapse Claude Code settings' })
    expect(collapseSettings).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('combobox', { name: 'Output style' })).toBeVisible()

    await user.click(collapseSettings)

    expect(screen.getByRole('button', { name: 'Expand Claude Code settings' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('combobox', { name: 'Output style' })).not.toBeInTheDocument()
    expect(setDefaultBackend).not.toHaveBeenCalled()
  })

  it('saves output style from the Agent settings page', async () => {
    const user = userEvent.setup()
    renderSection()

    const outputStyle = screen.getByRole('combobox', { name: 'Output style' })
    await waitFor(() => expect(outputStyle).toBeEnabled())
    await user.click(outputStyle)
    await user.click(screen.getByRole('option', { name: 'Concise' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/settings/output-style', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputStyle: 'concise' }),
      })
    })
  })

  it('prevents selecting an unavailable agent', async () => {
    renderSection()

    const unavailableAgent = screen.getByRole('radio', { name: /Open Code/ })
    expect(unavailableAgent).toBeDisabled()
    await userEvent.click(unavailableAgent)
    expect(setDefaultBackend).not.toHaveBeenCalled()
  })

  it('selects an available non-default agent', async () => {
    useBackendStore.setState((state) => ({
      backends: state.backends.map((backend) => (
        backend.id === 'opencode'
          ? { ...backend, availability: { status: 'available' as const } }
          : backend
      )),
    }))
    renderSection()

    await userEvent.click(screen.getByRole('radio', { name: /Open Code/ }))

    expect(setDefaultBackend).toHaveBeenCalledWith('opencode')
  })

  it('uses native radio keyboard behavior for agent selection', async () => {
    useBackendStore.setState((state) => ({
      backends: state.backends.map((backend) => (
        backend.id === 'opencode'
          ? { ...backend, availability: { status: 'available' as const } }
          : backend
      )),
    }))
    renderSection()

    const defaultAgent = screen.getByRole('radio', { name: /Claude Code/ })
    defaultAgent.focus()
    await userEvent.keyboard('{ArrowDown}')

    expect(screen.getByRole('radio', { name: /Open Code/ })).toHaveFocus()
    expect(setDefaultBackend).toHaveBeenCalledWith('opencode')
  })

  it('reports a selection error', async () => {
    setDefaultBackend.mockRejectedValueOnce(new Error('Could not switch agent'))
    useBackendStore.setState((state) => ({
      backends: state.backends.map((backend) => (
        backend.id === 'opencode'
          ? { ...backend, availability: { status: 'available' as const } }
          : backend
      )),
    }))
    renderSection()

    await userEvent.click(screen.getByRole('radio', { name: /Open Code/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch agent')
  })

  it('offers native ChatGPT and API-key login for Codex', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/codex/account')) {
        return { ok: true, json: async () => ({ account: null, requiresOpenaiAuth: true }) }
      }
      if (url.endsWith('/codex/login') && init?.method === 'POST') {
        return { ok: true, json: async () => ({ type: 'apiKey' }) }
      }
      return { ok: true, json: async () => ({ data: [], nextCursor: null }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    useBackendStore.setState((state) => ({
      backends: [
        ...state.backends,
        { id: 'codex', availability: { status: 'available' as const }, capabilities: {} },
      ],
      codexAccount: null,
      codexAccountError: null,
    }))
    const user = userEvent.setup()
    renderSection()

    expect(await screen.findByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('OpenAI API key'), 'sk-secret')
    await user.click(screen.getByRole('button', { name: 'Use API key' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/backends/codex/login', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'apiKey', apiKey: 'sk-secret' }),
      }))
    })
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('')
  })

  it('offers model, effort, and speed defaults for a signed-in Codex account', async () => {
    const setCodexDefaults = vi.fn().mockResolvedValue(undefined)
    useBackendStore.setState((state) => ({
      backends: [
        ...state.backends,
        { id: 'codex', availability: { status: 'available' as const }, capabilities: {} },
      ],
      codexAccount: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      codexModels: [{
        id: 'model-1',
        model: 'gpt-5.6-codex',
        displayName: 'GPT-5.6 Codex',
        description: '',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium', description: '' },
          { reasoningEffort: 'high', description: '' },
        ],
        defaultReasoningEffort: 'medium',
        serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
        defaultServiceTier: null,
      }],
      codexDefaultModel: 'gpt-5.6-codex',
      codexDefaultEffort: null,
      codexDefaultSpeed: null,
      fetchCodexAccount: vi.fn().mockResolvedValue(undefined),
      fetchCodexModels: vi.fn().mockResolvedValue(undefined),
      setCodexDefaults,
    }))
    const user = userEvent.setup()
    renderSection()

    await user.selectOptions(screen.getByLabelText('Default effort'), 'high')
    await user.selectOptions(screen.getByLabelText('Default speed'), 'fast')

    expect(setCodexDefaults).toHaveBeenNthCalledWith(1, {
      model: 'gpt-5.6-codex', effort: 'high', speed: null,
    })
    expect(setCodexDefaults).toHaveBeenNthCalledWith(2, {
      model: 'gpt-5.6-codex', effort: null, speed: 'fast',
    })
  })

  it('renders loading, load-error, and empty states', async () => {
    const { rerender } = renderSection()

    useBackendStore.setState({ backends: [], isLoading: true })
    rerender(
      <I18nextProvider i18n={i18n}>
        <BackendSection />
      </I18nextProvider>,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()

    useBackendStore.setState({ isLoading: false, error: 'Could not load agents' })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load agents'))
    expect(screen.getByText('No agent available')).toBeInTheDocument()
  })
})
