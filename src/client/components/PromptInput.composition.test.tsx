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

const filesMock = vi.hoisted(() => ({
  results: [] as { path: string }[],
  loading: false,
  error: undefined as string | undefined,
  truncated: false,
  search: vi.fn(),
  clear: vi.fn(),
}))

vi.mock('../stores/files-store', () => ({
  useFiles: () => filesMock,
}))

const appSettingsMock = vi.hoisted(() => ({
  useModifierToSubmit: false,
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ useModifierToSubmit: appSettingsMock.useModifierToSubmit }),
}))

vi.mock('./ProviderSelector', () => ({
  default: () => <div data-testid="provider-selector" />,
}))

vi.mock('./ApprovalModeToggle', () => ({
  default: () => <div data-testid="approval-mode-toggle" />,
}))

describe('PromptInput composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    chatStoreMock.getState().drafts = {}
    chatStoreMock.getState().messages = {}
    filesMock.results = []
    filesMock.truncated = false
    appSettingsMock.useModifierToSubmit = false
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

  it('F9: recalls a markdown prompt, highlights via overlay, and accepts a completion with Tab', async () => {
    seedHistory('session-1', ['**bold** explain the function'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)

    const textarea = screen.getByRole('textbox')
    const sendButton = screen.getByTitle('Send')

    // Train the n-gram model by sending the same prompt twice from this instance.
    const trainPrompt = '**bold** explain the function'
    fireEvent.change(textarea, { target: { value: trainPrompt, selectionStart: trainPrompt.length } })
    fireEvent.click(sendButton)
    fireEvent.change(textarea, { target: { value: trainPrompt, selectionStart: trainPrompt.length } })
    fireEvent.click(sendButton)

    // Recall the markdown prompt via terminal-style ArrowUp.
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('**bold** explain the function')

    // The mirror overlay renders the highlighted source.
    const overlay = document.querySelector('.md-overlay')
    expect(overlay).toBeInTheDocument()
    expect(overlay?.textContent).toContain('bold')

    // Reset to a prefix that the trained model can complete.
    fireEvent.change(textarea, { target: { value: 'explain ', selectionStart: 8 } })
    await waitFor(() => expect(screen.getByText('the')).toBeInTheDocument(), {
      timeout: 500,
    })

    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea).toHaveValue('explain the')
  })

  it('R36: streaming pauses pickers, history navigation, and completion but keeps overlay', () => {
    seedHistory('session-1', ['history prompt'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)

    const textarea = screen.getByRole('textbox')

    // Pickers do not open while streaming.
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } })
    expect(screen.queryByText(/No files match/i)).not.toBeInTheDocument()

    // History recall is disabled; the typed '@' value remains unchanged.
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('@')

    // Overlay still renders (read-only).
    const overlay = document.querySelector('.md-overlay')
    expect(overlay).toBeInTheDocument()
  })

  it('R37: plain Enter sends when useModifierToSubmit is false', () => {
    appSettingsMock.useModifierToSubmit = false
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.change(textarea, { target: { value: 'send me', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith('send me')
  })

  it('R37: Shift+Enter inserts newline when useModifierToSubmit is false', () => {
    appSettingsMock.useModifierToSubmit = false
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.change(textarea, { target: { value: 'line one', selectionStart: 8 } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(DEFAULT_PROPS.onSend).not.toHaveBeenCalled()
  })

  it('R37: modifier+Enter sends when useModifierToSubmit is true', () => {
    appSettingsMock.useModifierToSubmit = true
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.change(textarea, { target: { value: 'send me', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith('send me')
  })

  it('R37: plain Enter does not send when useModifierToSubmit is true', () => {
    appSettingsMock.useModifierToSubmit = true
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    fireEvent.change(textarea, { target: { value: 'send me', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(DEFAULT_PROPS.onSend).not.toHaveBeenCalled()
  })

  it('resets transient input state when switching sessions', () => {
    seedHistory('session-1', ['session one prompt'])
    const { rerender } = renderWithI18n(<PromptInput {...DEFAULT_PROPS} sessionId="session-1" />)
    const textarea = screen.getByRole('textbox')

    // Open a picker, trigger history recall, and leave a completion candidate in flight.
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    expect(screen.getByText('/commit')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.change(textarea, { target: { value: '', selectionStart: 0 } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('session one prompt')

    // Switch sessions: all transient state should reset.
    rerender(<PromptInput {...DEFAULT_PROPS} sessionId="session-2" />)

    const newTextarea = screen.getByRole('textbox')
    expect(newTextarea).toHaveValue('')
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()
    expect(screen.queryByText('session one prompt')).not.toBeInTheDocument()
  })

  it('AE13/AE14: all four features compose without crashing', async () => {
    seedHistory('session-1', ['**bold** note', 'explain the function'])
    filesMock.results = [
      { path: 'src/main.ts' },
      { path: 'src/util.ts' },
    ]

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')
    const sendButton = screen.getByTitle('Send')

    // Train the n-gram model in this component instance.
    const trainPrompt = 'explain the function'
    fireEvent.change(textarea, { target: { value: trainPrompt, selectionStart: trainPrompt.length } })
    fireEvent.click(sendButton)
    fireEvent.change(textarea, { target: { value: trainPrompt, selectionStart: trainPrompt.length } })
    fireEvent.click(sendButton)

    // Feature 1: slash picker opens and fuzzy matches.
    fireEvent.change(textarea, { target: { value: 'fix ', selectionStart: 4 } })
    fireEvent.change(textarea, { target: { value: 'fix /', selectionStart: 5 } })
    fireEvent.change(textarea, { target: { value: 'fix /cmt', selectionStart: 8 } })
    await waitFor(() => expect(screen.getByText('/commit')).toBeInTheDocument())

    // Feature 2: file picker opens after closing the slash picker and typing @.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByText('/commit')).not.toBeInTheDocument()
    fireEvent.change(textarea, { target: { value: 'fix ', selectionStart: 4 } })
    fireEvent.change(textarea, { target: { value: 'fix @', selectionStart: 5 } })
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument())

    // Dismiss and recall history.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.change(textarea, { target: { value: '', selectionStart: 0 } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('explain the function')

    // Feature 3: overlay highlights markdown from recalled history.
    const overlay = document.querySelector('.md-overlay')
    expect(overlay).toBeInTheDocument()

    // Feature 4: completion ghost appears after debounce.
    fireEvent.change(textarea, { target: { value: 'explain ', selectionStart: 8 } })
    await waitFor(() => expect(screen.getByText('the')).toBeInTheDocument(), {
      timeout: 500,
    })
  })

  it('recovers from IME composition state abandoned by IME switch', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const textarea = screen.getByRole('textbox')

    // Start a CJK composition.
    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, { target: { value: 'n', selectionStart: 1 } })
    // During composition the controlled value should not update.
    expect(textarea).toHaveValue('')

    // Simulate switching IMEs mid-composition: the browser abandons the
    // composition without firing compositionend, then a normal keydown arrives.
    fireEvent.keyDown(textarea, { key: 'a', isComposing: false })
    fireEvent.change(textarea, { target: { value: 'hello', selectionStart: 5 } })

    // The input should recover and accept the new value.
    expect(textarea).toHaveValue('hello')
  })
})
