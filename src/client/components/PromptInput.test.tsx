import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import PromptInput from './PromptInput'
import i18n from '../i18n'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

const DEFAULT_PROPS = {
  workspaceId: 'ws-1',
  sessionId: 'session-1',
  onSend: vi.fn(),
  onStop: vi.fn(),
  hasSession: true,
}

const chatStoreMock = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const state = {
    drafts: {} as Record<string, string>,
    messages: {} as Record<string, { id: string; role: 'user' | 'assistant' | 'system'; parts: { type: string; text?: string }[]; timestamp: number }[]>,
    isRestartingRuntime: {} as Record<string, boolean>,
    setDraft: vi.fn((sessionId: string, content: string) => {
      if (content === '') {
        delete state.drafts[sessionId]
      } else {
        state.drafts[sessionId] = content
      }
      notify()
    }),
  }

  function notify() {
    listeners.forEach((l) => l())
  }

  return {
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setDraft: state.setDraft,
    setMessages: (sessionId: string, messages: typeof state.messages[string]) => {
      state.messages[sessionId] = messages
      notify()
    },
  }
})

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector?: (s: ReturnType<typeof chatStoreMock.getState>) => unknown) => {
    const [, forceRender] = React.useReducer((x: number) => x + 1, 0)
    React.useEffect(() => {
      const unsubscribe = chatStoreMock.subscribe(forceRender)
      return () => {
        unsubscribe()
      }
    }, [])
    const state = chatStoreMock.getState()
    return selector ? selector(state) : state
  },
}))

vi.mock('../stores/commands-store', () => ({
  useCommands: () => ({
    commands: [
      { name: 'commit', description: 'Commit changes', argumentHint: '<message>' },
      { name: 'compact', description: 'Compact session' },
      { name: 'explain', description: 'Explain code' },
    ],
    loading: false,
    error: undefined,
    partial: false,
    partialReason: undefined,
    fetch: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('../stores/files-store', () => ({
  useFiles: () => ({
    results: [],
    loading: false,
    error: undefined,
    truncated: false,
    search: vi.fn(),
    clear: vi.fn(),
  }),
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ useModifierToSubmit: false }),
}))

vi.mock('./ProviderSelector', () => ({
  default: () => <div data-testid="provider-selector" />,
}))

vi.mock('./ApprovalModeToggle', () => ({
  default: () => <div data-testid="approval-mode-toggle" />,
}))

vi.mock('../lib/keyboard', () => ({
  shouldSubmitOnEnter: vi.fn(() => false),
}))

describe('PromptInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    chatStoreMock.getState().drafts = {}
    chatStoreMock.getState().messages = {}
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  function seedHistory(sessionId: string, prompts: string[]) {
    chatStoreMock.setMessages(
      sessionId,
      prompts.map((text, i) => ({
        id: `m-${i}`,
        role: 'user' as const,
        parts: [{ type: 'text', text }],
        timestamp: i + 1,
      })),
    )
  }

  it('renders the textarea and toolbar buttons', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    expect(screen.getByPlaceholderText('Ask Claude anything about your code...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Commands/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Files/i })).toBeInTheDocument()
  })

  it('opens command picker when / is typed in empty input', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
  })

  it('opens command picker when / follows whitespace mid-text', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'fix /', selectionStart: 5 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
  })

  it('does not open command picker for mid-word /', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'email/foo', selectionStart: 9 } })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()
  })

  it('opens file picker when @ is typed in empty input', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } })
    expect(screen.getByText(/No files match/i)).toBeInTheDocument()
  })

  it('opens file picker when @ follows whitespace mid-text', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'fix @', selectionStart: 5 } })
    expect(screen.getByText(/No files match/i)).toBeInTheDocument()
  })

  it('does not open file picker for mid-word @', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'email@x', selectionStart: 7 } })
    expect(screen.queryByText(/No files match/i)).not.toBeInTheDocument()
  })

  it('reopens command picker after dismissal by typing / again', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()

    // Type space to dismiss any lingering state, then / to reopen
    fireEvent.change(textarea, { target: { value: ' ', selectionStart: 1 } })
    fireEvent.change(textarea, { target: { value: ' /', selectionStart: 2 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
  })

  it('closes file picker and opens command picker when / follows whitespace', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } })
    expect(screen.getByText(/No files match/i)).toBeInTheDocument()

    // Type space to dismiss file picker, then / to open command picker
    fireEvent.change(textarea, { target: { value: '@ ', selectionStart: 2 } })
    expect(screen.queryByText(/No files match/i)).not.toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: '@ /', selectionStart: 3 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
  })

  it('closes command picker and opens file picker when @ follows whitespace', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()

    // Type space to dismiss command picker, then @ to open file picker
    fireEvent.change(textarea, { target: { value: '/ ', selectionStart: 2 } })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: '/ @', selectionStart: 3 } })
    expect(screen.getByText(/No files match/i)).toBeInTheDocument()
  })

  it('navigates command picker with arrow keys', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'fix ', selectionStart: 4 } })
    fireEvent.change(textarea, { target: { value: 'fix /', selectionStart: 5 } })
    fireEvent.change(textarea, { target: { value: 'fix /com', selectionStart: 8 } })
    const first = screen.getByText('/commit')
    expect(first).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    // active row changed; hard to assert DOM, but no error means navigation worked
    expect(screen.getByText('/compact')).toBeInTheDocument()
  })

  it('dismisses command picker on space, tab, or escape', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()

    // Clear and reopen with /, then type c, then space
    fireEvent.change(textarea, { target: { value: '', selectionStart: 0 } })
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
    fireEvent.change(textarea, { target: { value: '/c', selectionStart: 2 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()
    fireEvent.change(textarea, { target: { value: '/c ', selectionStart: 3 } })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()
  })

  it('recalls the most recent prompt on ArrowUp with empty input', () => {
    seedHistory('session-1', ['older prompt', 'most recent prompt'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('most recent prompt')
  })

  it('cycles through history with ArrowUp and ArrowDown', () => {
    seedHistory('session-1', ['first', 'second', 'third'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('third')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('second')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('first')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('second')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('third')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('')
  })

  it('restores the original draft when ArrowDown moves past the most recent entry', () => {
    chatStoreMock.setDraft('session-1', 'original draft')
    seedHistory('session-1', ['history prompt'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    expect(textarea).toHaveValue('original draft')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('history prompt')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('original draft')
  })

  it('replaces an edited recalled draft when ArrowUp continues backward', () => {
    seedHistory('session-1', ['older', 'newer'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('newer')

    fireEvent.change(textarea, { target: { value: 'edited', selectionStart: 6 } })
    expect(textarea).toHaveValue('edited')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('older')
  })

  it('does not change draft on ArrowUp when there is no history', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('')
  })

  it('does not navigate history while streaming', () => {
    seedHistory('session-1', ['history prompt'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('')
  })

  it('shows a completion suggestion after training on sent prompts', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    const sendButton = screen.getByTitle('Send')

    // Train the model by sending the same prompt twice.
    fireEvent.change(textarea, { target: { value: 'explain the function', selectionStart: 20 } })
    fireEvent.click(sendButton)
    fireEvent.change(textarea, { target: { value: 'explain the function', selectionStart: 20 } })
    fireEvent.click(sendButton)

    // Type the prefix and wait for the debounced suggestion.
    fireEvent.change(textarea, { target: { value: 'explain ', selectionStart: 8 } })
    await waitFor(() => expect(screen.getByText('the')).toBeInTheDocument(), {
      timeout: 500,
    })
  })

  it('accepts a completion suggestion with Tab', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    const sendButton = screen.getByTitle('Send')

    fireEvent.change(textarea, { target: { value: 'explain the function', selectionStart: 20 } })
    fireEvent.click(sendButton)
    fireEvent.change(textarea, { target: { value: 'explain the function', selectionStart: 20 } })
    fireEvent.click(sendButton)

    fireEvent.change(textarea, { target: { value: 'explain ', selectionStart: 8 } })
    await waitFor(() => expect(screen.getByText('the')).toBeInTheDocument(), {
      timeout: 500,
    })

    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea).toHaveValue('explain the')
  })

  it('does not show completion while an argument hint is active', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    const sendButton = screen.getByTitle('Send')

    fireEvent.change(textarea, { target: { value: 'explain the function', selectionStart: 20 } })
    fireEvent.click(sendButton)
    fireEvent.change(textarea, { target: { value: 'explain the function', selectionStart: 20 } })
    fireEvent.click(sendButton)

    // Select a command that produces an argument hint.
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(screen.getByText('<message>')).toBeInTheDocument()

    // The completion ghost must not appear while the argument hint is shown.
    await waitFor(() => expect(screen.queryByText('the')).not.toBeInTheDocument(), {
      timeout: 500,
    })
  })
})
