import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import '../index.css'
import PromptInput from './PromptInput'
import i18n from '../i18n'
import type { SessionActivitySnapshot } from '../types/message'

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
    sessions: {} as Record<string, { id: string; backend?: string }[]>,
    drafts: {} as Record<string, string>,
    messages: {} as Record<string, { id: string; role: 'user' | 'assistant' | 'system'; parts: { type: string; text?: string }[]; timestamp: number }[]>,
    promptHistory: {} as Record<string, string[]>,
    isRestartingRuntime: {} as Record<string, boolean>,
    sessionActivity: {} as Record<string, SessionActivitySnapshot>,
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
  newChatDraftSessionId: (workspaceId: string) => `new:${workspaceId}`,
  promptImageDraftKey: (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`,
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
    refresh: vi.fn(async () => ({
      commands: [
        { name: 'commit', description: 'Commit changes', argumentHint: '<message>' },
        { name: 'compact', description: 'Compact session' },
        { name: 'explain', description: 'Explain code' },
      ],
      succeeded: true,
    })),
  }),
  // OutputStyleSelect reads available styles from the raw store hook; the
  // empty map keeps it on the built-in style list in these tests.
  useCommandsStore: (selector: (state: unknown) => unknown) =>
    selector({
      commandsByWorkspace: {},
      loadingByWorkspace: {},
      errorByWorkspace: {},
      fetchCommands: vi.fn(async () => {}),
      refreshCommands: vi.fn(async () => {}),
      clearCommandsForWorkspace: vi.fn(),
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
  useAppSettings: () => ({
    useModifierToSubmit: appSettingsMock.useModifierToSubmit,
    outputStyle: null,
    setOutputStyle: vi.fn(),
  }),
}))

vi.mock('./ProviderSelector', () => ({
  default: () => <div data-testid="provider-selector" />,
}))

vi.mock('./ApprovalModeToggle', () => ({
  default: () => <div data-testid="approval-mode-toggle" />,
}))

vi.mock('./FastModeToggle', () => ({
  default: () => <div data-testid="fast-mode-toggle" />,
}))

describe('PromptInput ghost text alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    chatStoreMock.getState().sessions = {}
    chatStoreMock.getState().drafts = {}
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().promptHistory = {}
    chatStoreMock.getState().sessionActivity = {}
    filesMock.results = []
    filesMock.truncated = false
    appSettingsMock.useModifierToSubmit = false
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  function editableElement() {
    return screen.getByRole('textbox') as HTMLDivElement
  }

  function editableLocator() {
    return page.getByRole('textbox')
  }

  function ghostElement() {
    return document.querySelector('.pointer-events-none.z-20 .text-text-tertiary') as HTMLElement | null
  }

  it('positions a skill argument hint on the same line as the caret', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('/')
    await userEvent.click(screen.getByText('/commit'))

    await waitFor(() => expect(ghostElement()?.textContent?.trim()).toBe('<message>'), {
      timeout: 2000,
    })

    const el = editableElement()
    const ghost = ghostElement()!
    const chip = el.querySelector<HTMLElement>('[data-prompt-reference-chip]')
    expect(chip).not.toBeNull()

    // The invisible command mirror and its hint should share a line, and the
    // hint must begin after the rendered chip rather than inside its padding.
    const inputMirror = document.querySelector(
      '.pointer-events-none.z-20 .invisible',
    ) as HTMLElement
    const inputRect = inputMirror.getBoundingClientRect()
    const ghostRect = ghost.getBoundingClientRect()
    const chipRect = chip!.getBoundingClientRect()

    expect(Math.abs(ghostRect.top - inputRect.top)).toBeLessThanOrEqual(2)
    expect(ghostRect.left).toBeGreaterThanOrEqual(chipRect.right)
    expect(el.textContent).toBe('/commit ')
  })
})
