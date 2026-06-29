import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import '../index.css'
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
    setDraft: state.setDraft,
    setMessages: (sessionId: string, messages: typeof state.messages[string]) => {
      state.messages[sessionId] = messages
      notify()
    },
    setPromptHistory: (workspaceId: string, prompts: string[]) => {
      state.promptHistory[workspaceId] = prompts
      notify()
    },
    useChatStore,
  }
})

vi.mock('../stores/chat-store', () => ({
  useChatStore: chatStoreMock.useChatStore,
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

describe('PromptInput ghost text alignment', () => {
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

  function ghostElement() {
    return document.querySelector('.pointer-events-none.z-20 .text-text-tertiary') as HTMLElement | null
  }

  it('positions the completion suggestion on the same line as the caret when empty lines are in the middle', async () => {
    seedHistory(['explain the function', 'other prompt', 'explain the function'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('explain ')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await userEvent.keyboard('the ')

    await waitFor(() => expect(ghostElement()?.textContent?.trim()).toBe('function'), {
      timeout: 2000,
    })

    const el = editableElement()
    const ghost = ghostElement()!

    // Compare the ghost text's vertical position with the caret's vertical
    // position. They should be on the same line (within a few pixels).
    const selection = window.getSelection()
    const caretRect =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0).getBoundingClientRect()
        : null
    const ghostRect = ghost.getBoundingClientRect()

    expect(caretRect).toBeTruthy()
    expect(Math.abs(ghostRect.top - caretRect!.top)).toBeLessThanOrEqual(2)
    expect(el.textContent).toContain('explain ')
    expect(el.textContent).toContain('the ')
  })
})
