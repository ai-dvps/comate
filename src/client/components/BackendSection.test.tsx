import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('exposes agent choices as a single-select group', () => {
    renderSection()

    expect(screen.getByRole('radiogroup', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Open Code/ })).not.toBeChecked()
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
