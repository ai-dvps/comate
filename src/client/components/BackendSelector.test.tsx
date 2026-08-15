import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import BackendSelector from './BackendSelector'

const setSessionBackend = vi.fn()

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({
    sessions: { 'ws-1': [{ id: 'session-1', isDraft: true }] },
    setSessionBackend,
  }),
}))

vi.mock('../stores/backend-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/backend-store')>()
  return {
    ...actual,
    useBackendStore: (selector: (state: unknown) => unknown) => selector({
      backends: [
        { id: 'claude', availability: { status: 'available' }, capabilities: {} },
        { id: 'opencode', availability: { status: 'available' }, capabilities: {} },
      ],
      defaultBackend: 'claude',
      fetchBackends: vi.fn(),
    }),
  }
})

describe('BackendSelector', () => {
  beforeEach(() => setSessionBackend.mockClear())

  it('selects an agent locally in New Chat mode', () => {
    const onBackendChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <BackendSelector
          mode="new-chat"
          workspaceId="ws-1"
          backendId={null}
          onBackendChange={onBackendChange}
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByTitle('Agent'))
    fireEvent.click(screen.getByText('Open Code'))

    expect(onBackendChange).toHaveBeenCalledWith('opencode')
    expect(setSessionBackend).not.toHaveBeenCalled()
  })

  it('keeps the existing session update path unchanged', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BackendSelector workspaceId="ws-1" sessionId="session-1" />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByTitle('Agent'))
    fireEvent.click(screen.getByText('Open Code'))

    expect(setSessionBackend).toHaveBeenCalledWith('ws-1', 'session-1', 'opencode')
  })
})
