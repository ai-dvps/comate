import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { userEvent } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import FastModeToggle from './FastModeToggle'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const DEFAULT_PROPS = {
  workspaceId: 'ws-1',
  sessionId: 'session-1',
}

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    sessions: {
      'ws-1': [
        {
          id: 'session-1',
          workspaceId: 'ws-1',
          name: 'Test',
          fastMode: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    setSessionFastMode: vi.fn(async (_workspaceId: string, _sessionId: string, fastMode: boolean) => {
      state.sessions['ws-1'][0].fastMode = fastMode
      notify()
    }),
  }

  function notify() {
    listeners.forEach((l) => l())
  }

  function useChatStore(selector?: (s: typeof state) => unknown) {
    const [, forceRender] = React.useReducer((x: number) => x + 1, 0)
    React.useEffect(() => {
      const unsubscribe = chatStoreMock.subscribe(forceRender)
      return () => {
        unsubscribe()
      }
    }, [])
    return selector ? selector(state) : state
  }
  useChatStore.getState = () => state

  return {
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setSessionFastMode: state.setSessionFastMode,
    useChatStore,
  }
})

vi.mock('../stores/chat-store', () => ({
  useChatStore: chatStoreMock.useChatStore,
}))

const providerStoreMock = vi.hoisted(() => {
  const state = {
    providers: [
      {
        id: 'provider-1',
        name: 'Test Provider',
        baseUrl: 'http://test',
        authToken: 'test',
        model: 'test-model',
        isDefault: true,
        supportsFastMode: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    fetchProviders: vi.fn(),
  }

  function useProviderStore(selector?: (s: typeof state) => unknown) {
    return selector ? selector(state) : state
  }

  return {
    getState: () => state,
    setSupportsFastMode: (value: boolean) => {
      state.providers[0].supportsFastMode = value
    },
    useProviderStore,
  }
})

vi.mock('../stores/provider-store', () => ({
  useProviderStore: providerStoreMock.useProviderStore,
}))

describe('FastModeToggle browser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    chatStoreMock.getState().sessions['ws-1'][0].fastMode = false
    providerStoreMock.getState().providers[0].supportsFastMode = true
  })

  it('renders the fast mode toggle in the off state', () => {
    renderWithI18n(<FastModeToggle {...DEFAULT_PROPS} />)
    const button = screen.getByRole('button', { name: /Fast mode/i })
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles fast mode on when clicked', async () => {
    renderWithI18n(<FastModeToggle {...DEFAULT_PROPS} />)
    const button = screen.getByRole('button', { name: /Fast mode/i })

    await userEvent.click(button)

    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    expect(chatStoreMock.setSessionFastMode).toHaveBeenCalledWith('ws-1', 'session-1', true)
  })

  it('disables the button while streaming', () => {
    renderWithI18n(<FastModeToggle {...DEFAULT_PROPS} disabled />)
    const button = screen.getByRole('button', { name: /Fast mode/i })
    expect(button).toBeDisabled()
  })

  it('disables the button when the active provider does not support fast mode', () => {
    providerStoreMock.setSupportsFastMode(false)
    renderWithI18n(<FastModeToggle {...DEFAULT_PROPS} />)
    const button = screen.getByRole('button', { name: /Fast mode/i })
    expect(button).toBeDisabled()
  })
})
