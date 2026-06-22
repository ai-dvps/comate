import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
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
    promptHistory: {} as Record<string, string[]>,
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
    setPromptHistory: (workspaceId: string, prompts: string[]) => {
      state.promptHistory[workspaceId] = prompts
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

describe('PromptInput browser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    chatStoreMock.getState().drafts = {}
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().promptHistory = {}
    filesMock.results = []
    filesMock.truncated = false
    appSettingsMock.useModifierToSubmit = false
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  function seedHistory(prompts: string[]) {
    chatStoreMock.setPromptHistory(DEFAULT_PROPS.workspaceId, prompts)
  }

  function editableElement() {
    return screen.getByRole('textbox') as HTMLDivElement
  }

  function editableLocator() {
    return page.getByRole('textbox')
  }

  it('renders the WeCom bot bar with user info when isBotSession is true', () => {
    renderWithI18n(
      <PromptInput
        {...DEFAULT_PROPS}
        isBotSession
        botName="WeCom Bot"
        botIcon="/wecom-icon.svg"
        botUser={{ userId: 'alice@example.com', lastSeenAt: new Date().toISOString() }}
      />,
    )

    expect(screen.getByText('WeCom Bot')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(document.querySelector('img[src="/wecom-icon.svg"]')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('renders the Feishu bot bar with user info when isBotSession is true', () => {
    renderWithI18n(
      <PromptInput
        {...DEFAULT_PROPS}
        isBotSession
        botName="Feishu Bot"
        botIcon="/feishu-icon.svg"
        botUser={{ userId: 'ou-alice', lastSeenAt: new Date().toISOString() }}
      />,
    )

    expect(screen.getByText('Feishu Bot')).toBeInTheDocument()
    expect(screen.getByText('ou-alice')).toBeInTheDocument()
    expect(document.querySelector('img[src="/feishu-icon.svg"]')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('calls onRefresh when the refresh button is clicked in a bot session', async () => {
    const onRefresh = vi.fn()
    renderWithI18n(
      <PromptInput
        {...DEFAULT_PROPS}
        isBotSession
        botName="Feishu Bot"
        botIcon="/feishu-icon.svg"
        botUser={{ userId: 'ou-alice', lastSeenAt: null }}
        onRefresh={onRefresh}
      />,
    )

    await userEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
  })

  it('renders the textbox and toolbar buttons', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Skills/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Files/i })).toBeInTheDocument()
  })

  it('shows placeholder when empty and hides it on focus', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    expect(screen.getByText('Ask Claude anything about your code...')).toBeInTheDocument()

    await editableLocator().click()
    await waitFor(() =>
      expect(screen.queryByText('Ask Claude anything about your code...')).not.toBeInTheDocument(),
    )
  })

  it('types plain text and sends with Enter', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('send me')
    await waitFor(() => expect(editableElement().textContent).toBe('send me'))
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith('send me'))
  })

  it('inserts a newline with Shift+Enter', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('line one')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')

    await waitFor(() => expect(editableElement().textContent).toContain('line one'))
    expect(chatStoreMock.getState().drafts['session-1']).toContain('\n')
    expect(DEFAULT_PROPS.onSend).not.toHaveBeenCalled()
  })

  it('does not submit while an IME composition is active', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const el = editableElement()

    await editableLocator().click()

    // Simulate IME composition sequence without relying on OS-level IME.
    // We dispatch raw composition/key events so we can control isComposing.
    const inputEvent = new InputEvent('input', { bubbles: true })
    const compositionStart = new CompositionEvent('compositionstart', { bubbles: true })
    const compositionEnd = new CompositionEvent('compositionend', { bubbles: true })

    el.dispatchEvent(compositionStart)
    el.textContent = 'ni'
    el.dispatchEvent(inputEvent)

    await waitFor(() => expect(chatStoreMock.getState().drafts['session-1']).toBe('ni'))

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    expect(DEFAULT_PROPS.onSend).not.toHaveBeenCalled()

    el.textContent = '你好'
    el.dispatchEvent(compositionEnd)
    el.dispatchEvent(inputEvent)

    await waitFor(() => expect(chatStoreMock.getState().drafts['session-1']).toBe('你好'))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }))
    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith('你好'))
  })

  it('opens command picker and inserts a slash command', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('/')
    await waitFor(() => expect(screen.getByText('/commit')).toBeInTheDocument(), {
      timeout: 1000,
    })

    await userEvent.click(screen.getByText('/commit'))
    await waitFor(() => expect(editableElement().textContent).toContain('/commit'))
    expect(screen.getByText('<message>')).toBeInTheDocument()
  })

  it('opens file picker and inserts a file path', async () => {
    filesMock.results = [
      { path: 'src/main.ts' },
      { path: 'src/util.ts' },
    ]

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('@')
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })

    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(editableElement().textContent).toBe('@src/main.ts '))
  })

  it('inserts a file path when clicking a picker item after typing @', async () => {
    filesMock.results = [
      { path: 'src/main.ts' },
      { path: 'src/util.ts' },
    ]

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('check @')
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })

    await userEvent.click(screen.getByText('src/main.ts'))
    await waitFor(() => expect(editableElement().textContent).toBe('check @src/main.ts '))
  })

  it('inserts a file path when selecting from the Files button picker', async () => {
    filesMock.results = [
      { path: 'src/main.ts' },
      { path: 'src/util.ts' },
    ]

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    await userEvent.click(screen.getByRole('button', { name: /Files/i }))
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })

    await userEvent.click(screen.getByText('src/main.ts'))
    await waitFor(() => expect(editableElement().textContent).toBe('@src/main.ts '))
  })

  it('inserts a file path at the existing caret when using the Files button picker', async () => {
    filesMock.results = [{ path: 'src/main.ts' }]

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('check ')
    await userEvent.click(screen.getByRole('button', { name: /Files/i }))
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })

    await userEvent.click(screen.getByText('src/main.ts'))
    await waitFor(() =>
      expect(editableElement().textContent).toBe('check @src/main.ts '),
    )
  })

  it('does not recall history with ArrowUp when input is empty', async () => {
    seedHistory(['first', 'second', 'third'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.click()
    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(editableElement().textContent).toBe(''))
  })

  it('does not recall history with ArrowUp inside a multi-line draft', async () => {
    seedHistory(['first', 'second', 'third'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('line one')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await userEvent.keyboard('line two')
    await waitFor(() =>
      expect(chatStoreMock.getState().drafts['session-1']).toContain('\n'),
    )

    // Move caret to the start of the second line so ArrowUp moves within the draft.
    await userEvent.keyboard('{Home}')
    await userEvent.keyboard('{ArrowUp}')

    await waitFor(() =>
      expect(chatStoreMock.getState().drafts['session-1']).toContain('\n'),
    )
    expect(DEFAULT_PROPS.onSend).not.toHaveBeenCalled()
  })

  it('opens history popup with Alt+H and commits a selection', async () => {
    seedHistory(['first', 'second', 'third'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.click()
    await userEvent.keyboard('{Alt>}h{/Alt}')
    await waitFor(() => expect(screen.getByText('third')).toBeInTheDocument(), {
      timeout: 1000,
    })

    const filterInput = screen.getByPlaceholderText('Search history...')
    await waitFor(() => expect(document.activeElement).toBe(filterInput))

    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(editableElement().textContent).toBe('second'))
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Search history...')).not.toBeInTheDocument(),
    )
  })

  it('shows and accepts a completion suggestion', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()
    const sendButton = page.getByTitle('Send')

    await input.fill('explain the function')
    await sendButton.click()
    await input.fill('explain the function')
    await sendButton.click()

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledTimes(2))

    await input.fill('explain ')
    await waitFor(() => expect(screen.getByText('the')).toBeInTheDocument(), {
      timeout: 2000,
    })

    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(editableElement().textContent?.trim()).toBe('explain the'))
  })

  it('pastes plain text and strips formatting', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const el = editableElement()

    await editableLocator().click()
    const dt = new DataTransfer()
    dt.setData('text/plain', 'plain text')
    dt.setData('text/html', '<b>bold</b>')
    const paste = new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: dt,
    })
    el.dispatchEvent(paste)

    await waitFor(() => expect(el.textContent).toBe('plain text'))
  })

  it('disables the input while streaming', async () => {
    seedHistory(['history prompt'])
    chatStoreMock.setDraft('session-1', '@')
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)

    const el = editableElement()
    await waitFor(() => expect(el.textContent).toBe('@'))
    expect(el).toHaveAttribute('contenteditable', 'false')
    expect(el).toHaveAttribute('tabindex', '-1')
  })

  it('undoes typed text with Cmd+Z', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('hello')
    await waitFor(() => expect(editableElement().textContent).toBe('hello'))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(editableElement().textContent).toBe(''))
  })

  it('redoes with Cmd+Shift+Z after undo', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('hello')
    await waitFor(() => expect(editableElement().textContent).toBe('hello'))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(editableElement().textContent).toBe(''))

    await userEvent.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}')
    await waitFor(() => expect(editableElement().textContent).toBe('hello'))
  })

  it('undoes a paste operation with Cmd+Z', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const el = editableElement()

    await editableLocator().click()
    const dt = new DataTransfer()
    dt.setData('text/plain', 'pasted text')
    const paste = new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: dt,
    })
    el.dispatchEvent(paste)

    await waitFor(() => expect(el.textContent).toBe('pasted text'))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(el.textContent).toBe(''))
  })

  it('undoes a clear with Cmd+Z', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('keep me')
    await waitFor(() => expect(editableElement().textContent).toBe('keep me'))

    await userEvent.click(screen.getByTitle('Clear'))
    await waitFor(() => expect(editableElement().textContent).toBe(''))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(editableElement().textContent).toBe('keep me'))
  })

  it('undoes typing in chunks separated by pauses', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('first')
    await waitFor(() => expect(editableElement().textContent).toBe('first'))

    // Wait for the typing group to commit (debounce is 500ms).
    await new Promise((resolve) => setTimeout(resolve, 700))

    await input.fill('first second')
    await waitFor(() => expect(editableElement().textContent).toBe('first second'))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(editableElement().textContent).toBe('first'))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => expect(editableElement().textContent).toBe(''))
  })
})
