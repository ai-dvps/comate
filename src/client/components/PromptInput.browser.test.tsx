import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import PromptInput from './PromptInput'
import i18n from '../i18n'
import type { SessionActivitySnapshot } from '../types/message'
import { extractPlainText, setCaretOffset, setSelectionOffsets } from '../lib/contenteditable'

const ACTIVITY_LAYOUT_STYLES = `
  .mx-auto { margin-inline: auto; }
  .w-fit { width: fit-content; }
  .max-w-full { max-width: 100%; }
`

const TOOLBAR_LAYOUT_STYLES = `
  [data-testid="prompt-input-toolbar"] { display: flex; align-items: center; gap: 4px; padding-inline: 8px; }
  [data-testid="prompt-input-toolbar"] > div { display: flex; align-items: center; gap: 4px; }
  [data-testid="prompt-input-toolbar"] .hidden { display: none; }
  [data-testid="prompt-input-toolbar"] .inline-flex { display: inline-flex; }
  [data-testid="prompt-input-toolbar"] .justify-between { justify-content: space-between; }
  [data-testid="prompt-input-toolbar"] .justify-end { justify-content: flex-end; }
  [data-testid="prompt-input-toolbar"] .ml-auto { margin-left: auto; }
  [data-testid="prompt-input-toolbar"] .min-w-0 { min-width: 0; }
  [data-testid="prompt-input-toolbar"] .overflow-hidden { overflow: hidden; }
  [data-testid="prompt-input-toolbar"] .shrink-0 { flex-shrink: 0; }
`

function renderWithI18n(ui: React.ReactElement) {
  return render(
    <I18nextProvider i18n={i18n}>
      <div style={{ width: '800px' }}>{ui}</div>
    </I18nextProvider>,
  )
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
    sessions: {} as Record<string, { id: string; backend?: string; providerId?: string }[]>,
    drafts: {} as Record<string, string>,
    imageDrafts: {} as Record<string, { id: string; name: string; mediaType: 'image/png'; data: string; width: number; height: number; blob: Blob; previewUrl: string }[]>,
    messages: {} as Record<string, { id: string; role: 'user' | 'assistant' | 'system'; parts: { type: string; text?: string }[]; timestamp: number }[]>,
    promptHistory: {} as Record<string, string[]>,
    pendingTurns: {} as Record<string, unknown>,
    isRestartingRuntime: {} as Record<string, boolean>,
    sessionActivity: {} as Record<string, SessionActivitySnapshot>,
    stopBackgroundTask: vi.fn(() => Promise.resolve()),
    setDraft: vi.fn((sessionId: string, content: string) => {
      if (content === '') {
        delete state.drafts[sessionId]
      } else {
        state.drafts[sessionId] = content
      }
      notify()
    }),
    setImageDrafts: vi.fn((workspaceId: string, sessionId: string, images: typeof state.imageDrafts[string]) => {
      const key = `${JSON.stringify(workspaceId)}:${JSON.stringify(sessionId)}`
      if (images.length === 0) delete state.imageDrafts[key]
      else state.imageDrafts[key] = images
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
    setImageDrafts: state.setImageDrafts,
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
  newChatDraftSessionId: (workspaceId: string) =>
    `__new_chat_draft__:${JSON.stringify(workspaceId)}`,
  promptImageDraftKey: (workspaceId: string, sessionId: string) =>
    `${JSON.stringify(workspaceId)}:${JSON.stringify(sessionId)}`,
}))

const backendStoreMock = vi.hoisted(() => ({
  backends: [
    { id: 'claude', availability: { status: 'available' }, capabilities: { imageInput: { state: 'full' } } },
    { id: 'opencode', availability: { status: 'available' }, capabilities: { imageInput: { state: 'full' } } },
  ],
  fetchBackends: vi.fn(),
}))

vi.mock('../stores/backend-store', () => ({
  useBackendStore: (selector: (state: typeof backendStoreMock) => unknown) => selector(backendStoreMock),
  backendAvailability: (backends: typeof backendStoreMock.backends, id: string) =>
    backends.find((backend) => backend.id === id)?.availability,
  backendCapability: (backends: typeof backendStoreMock.backends, id: string, capability: string) =>
    backends.find((backend) => backend.id === id)?.capabilities[capability as 'imageInput']
      ?? { state: 'unavailable', reasonKey: 'backend.capabilityUndeclared' },
}))

const providerStoreMock = vi.hoisted(() => ({
  providers: [
    { id: 'provider-1', model: 'claude-sonnet-4-6', isDefault: true },
  ],
  fetchProviders: vi.fn(),
}))

vi.mock('../stores/provider-store', () => ({
  useProviderStore: (selector: (state: typeof providerStoreMock) => unknown) => selector(providerStoreMock),
}))

const imageInputMock = vi.hoisted(() => ({
  normalizeImageBatch: vi.fn(async (files: File[]) => files.map((file, index) => ({
    id: `image-${index}`,
    name: file.name,
    mediaType: 'image/png' as const,
    data: 'AA==',
    width: 100,
    height: 50,
    blob: file,
    previewUrl: `blob:${file.name}`,
  }))),
  releasePromptImage: vi.fn(),
}))

vi.mock('../lib/image-input', () => {
  class ImageInputError extends Error {
    constructor(public code: string, message: string) {
      super(message)
    }
  }
  return { ...imageInputMock, ImageInputError }
})

const workspaceAwareControlsMock = vi.hoisted(() => ({
  commandWorkspaceIds: [] as string[],
  fileWorkspaceIds: [] as string[],
  providerWorkspaceIds: [] as string[],
}))

vi.mock('../stores/commands-store', () => ({
  useCommands: (workspaceId: string) => {
    workspaceAwareControlsMock.commandWorkspaceIds.push(workspaceId)
    return {
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
    }
  },
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
  useFiles: (workspaceId: string) => {
    workspaceAwareControlsMock.fileWorkspaceIds.push(workspaceId)
    return filesMock
  },
}))

const appSettingsMock = vi.hoisted(() => ({
  useModifierToSubmit: false,
}))

const toolbarControlMock = vi.hoisted(() => ({
  forceWideControls: false,
}))

vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({ useModifierToSubmit: appSettingsMock.useModifierToSubmit }),
}))

vi.mock('./ProviderSelector', () => ({
  default: ({ workspaceId, disabled, mode }: { workspaceId: string; disabled?: boolean; hideNameBelowSm?: boolean; mode?: string }) => {
    workspaceAwareControlsMock.providerWorkspaceIds.push(workspaceId)
    return (
      <div
        data-testid="provider-selector"
        data-disabled={disabled ? 'true' : 'false'}
        data-mode={mode ?? 'session'}
        data-workspace-id={workspaceId}
        style={toolbarControlMock.forceWideControls ? { minWidth: '160px' } : undefined}
      />
    )
  },
}))

vi.mock('./ApprovalModeToggle', () => ({
  default: () => (
    <div
      data-testid="approval-mode-toggle"
      style={toolbarControlMock.forceWideControls ? { minWidth: '160px' } : undefined}
    />
  ),
}))

vi.mock('./FastModeToggle', () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <div
      data-testid="fast-mode-toggle"
      data-disabled={disabled ? 'true' : 'false'}
      style={toolbarControlMock.forceWideControls ? { minWidth: '160px' } : undefined}
    />
  ),
}))

describe('PromptInput browser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    chatStoreMock.getState().sessions = {}
    chatStoreMock.getState().drafts = {}
    chatStoreMock.getState().imageDrafts = {}
    chatStoreMock.getState().messages = {}
    chatStoreMock.getState().promptHistory = {}
    chatStoreMock.getState().pendingTurns = {}
    chatStoreMock.getState().isRestartingRuntime = {}
    chatStoreMock.getState().sessionActivity = {}
    filesMock.results = []
    filesMock.truncated = false
    workspaceAwareControlsMock.commandWorkspaceIds = []
    workspaceAwareControlsMock.fileWorkspaceIds = []
    workspaceAwareControlsMock.providerWorkspaceIds = []
    appSettingsMock.useModifierToSubmit = false
    toolbarControlMock.forceWideControls = false
    providerStoreMock.providers = [
      { id: 'provider-1', model: 'claude-sonnet-4-6', isDefault: true },
    ]
    imageInputMock.normalizeImageBatch.mockImplementation(async (files: File[]) => files.map((file, index) => ({
      id: `image-${index}`,
      name: file.name,
      mediaType: 'image/png' as const,
      data: 'AA==',
      width: 100,
      height: 50,
      blob: file,
      previewUrl: `blob:${file.name}`,
    })))
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { paths: string[] }
      return {
        ok: true,
        json: async () => ({
          paths: body.paths.filter((path) => path === 'src/app.ts'),
        }),
      } as Response
    }))
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

  function inputCardElement() {
    return screen.getByTestId('input-card')
  }

  function popoverForPlaceholder(placeholder: RegExp) {
    return screen.getByPlaceholderText(placeholder).parentElement as HTMLDivElement
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
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
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
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-mode-toggle')).not.toBeInTheDocument()
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

  it('shows an interactive provider selector on a bot session when not streaming', () => {
    renderWithI18n(
      <PromptInput
        {...DEFAULT_PROPS}
        isBotSession
        botName="WeCom Bot"
        botIcon="/wecom-icon.svg"
        botUser={{ userId: 'alice@example.com', lastSeenAt: null }}
      />,
    )

    // R1/R5: the selector is present and stays interactive even though the bot input is read-only.
    const selector = screen.getByTestId('provider-selector')
    expect(selector).toBeInTheDocument()
    expect(selector).toHaveAttribute('data-disabled', 'false')
  })

  it('disables the provider selector on a bot session while streaming', () => {
    renderWithI18n(
      <PromptInput
        {...DEFAULT_PROPS}
        isBotSession
        isStreaming
        botName="WeCom Bot"
        botIcon="/wecom-icon.svg"
        botUser={{ userId: 'alice@example.com', lastSeenAt: null }}
      />,
    )

    // R6: switching is blocked while the runtime is streaming.
    expect(screen.getByTestId('provider-selector')).toHaveAttribute('data-disabled', 'true')
  })

  it('disables the provider selector on a bot session while the runtime is restarting', () => {
    chatStoreMock.getState().isRestartingRuntime = { [DEFAULT_PROPS.sessionId]: true }
    renderWithI18n(
      <PromptInput
        {...DEFAULT_PROPS}
        isBotSession
        botName="WeCom Bot"
        botIcon="/wecom-icon.svg"
        botUser={{ userId: 'alice@example.com', lastSeenAt: null }}
      />,
    )

    // R6: switching is blocked while the runtime is restarting after a provider change.
    expect(screen.getByTestId('provider-selector')).toHaveAttribute('data-disabled', 'true')
  })

  it('renders the textbox and toolbar buttons', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Skills/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Files/i })).not.toBeInTheDocument()
  })

  it('renders toolbar controls and Send in the same bottom row', () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const card = inputCardElement()
    const historyButton = screen.getByRole('button', { name: /History/i })
    const sendButton = screen.getByTitle('Send')

    expect(card).toContainElement(historyButton)
    expect(card).toContainElement(sendButton)
    expect(historyButton.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('uses the same composer for New Chat with workspace-aware controls and preserves its draft after send', async () => {
    const onSend = vi.fn()
    renderWithI18n(
      <PromptInput
        workspaceId={DEFAULT_PROPS.workspaceId}
        mode="new-chat"
        backendId={null}
        onBackendChange={vi.fn()}
        providerId={null}
        onProviderChange={vi.fn()}
        fastMode={false}
        outputStyle={null}
        onOutputStyleChange={vi.fn()}
        onFastModeChange={vi.fn()}
        approvalMode="manual"
        onApprovalModeChange={vi.fn()}
        onSend={onSend}
      />,
    )

    await editableLocator().fill('Start from this prompt')
    await page.getByTitle('Send').click()

    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ text: 'Start from this prompt', images: [] }))
    expect(editableElement().textContent).toBe('Start from this prompt')
    expect(screen.queryByRole('button', { name: /Skills/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Files/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /History/i })).toBeDisabled()
    expect(screen.getByTestId('provider-selector')).toHaveAttribute('data-mode', 'new-chat')
    expect(screen.getByTitle('Agent')).toBeInTheDocument()
    expect(screen.getByTestId('fast-mode-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('approval-mode-toggle')).toBeInTheDocument()
    expect(inputCardElement()).not.toHaveClass('border', 'shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.12)]')
  })

  it('keeps the workspace-scoped New Chat draft when its composer unmounts', async () => {
    const newChat = renderWithI18n(
      <PromptInput
        workspaceId="ws-1"
        mode="new-chat"
        backendId={null}
        onBackendChange={vi.fn()}
        providerId={null}
        onProviderChange={vi.fn()}
        fastMode={false}
        outputStyle={null}
        onOutputStyleChange={vi.fn()}
        onFastModeChange={vi.fn()}
        approvalMode="manual"
        onApprovalModeChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )

    await editableLocator().fill('Temporary new chat draft')
    expect(Object.values(chatStoreMock.getState().drafts)).toContain('Temporary new chat draft')
    newChat.unmount()
    expect(Object.values(chatStoreMock.getState().drafts)).toContain('Temporary new chat draft')

    chatStoreMock.getState().drafts[DEFAULT_PROPS.sessionId] = 'Existing session draft'
    const session = renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    expect(inputCardElement()).toHaveClass('border', 'shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.12)]')
    session.unmount()
    expect(chatStoreMock.getState().drafts[DEFAULT_PROPS.sessionId]).toBe('Existing session draft')
  })

  it('rebinds command, file, and provider controls when the New Chat workspace changes', async () => {
    function WorkspaceHarness() {
      const [workspaceId, setWorkspaceId] = React.useState('ws-1')
      return (
        <>
          <button type="button" onClick={() => setWorkspaceId('ws-2')}>Switch workspace</button>
          <PromptInput
            workspaceId={workspaceId}
            mode="new-chat"
            backendId={null}
            onBackendChange={vi.fn()}
            providerId={null}
            onProviderChange={vi.fn()}
            fastMode={false}
            outputStyle={null}
            onOutputStyleChange={vi.fn()}
            onFastModeChange={vi.fn()}
            approvalMode="manual"
            onApprovalModeChange={vi.fn()}
            onSend={vi.fn()}
          />
        </>
      )
    }

    renderWithI18n(<WorkspaceHarness />)

    expect(workspaceAwareControlsMock.commandWorkspaceIds.at(-1)).toBe('ws-1')
    expect(workspaceAwareControlsMock.fileWorkspaceIds.at(-1)).toBe('ws-1')
    expect(workspaceAwareControlsMock.providerWorkspaceIds.at(-1)).toBe('ws-1')

    await userEvent.click(screen.getByRole('button', { name: 'Switch workspace' }))

    await waitFor(() => {
      expect(workspaceAwareControlsMock.commandWorkspaceIds.at(-1)).toBe('ws-2')
      expect(workspaceAwareControlsMock.fileWorkspaceIds.at(-1)).toBe('ws-2')
      expect(workspaceAwareControlsMock.providerWorkspaceIds.at(-1)).toBe('ws-2')
    })
    expect(screen.getByTestId('provider-selector')).toHaveAttribute('data-workspace-id', 'ws-2')
  })

  it('uses the shared toolbar breakpoints in New Chat at compact composer widths', async () => {
    appSettingsMock.useModifierToSubmit = true
    renderWithI18n(
      <div style={{ width: '469px' }}>
        <PromptInput
          workspaceId="ws-1"
          mode="new-chat"
          backendId={null}
          onBackendChange={vi.fn()}
          providerId={null}
          onProviderChange={vi.fn()}
          fastMode={false}
          outputStyle={null}
          onOutputStyleChange={vi.fn()}
          onFastModeChange={vi.fn()}
          approvalMode="manual"
          onApprovalModeChange={vi.fn()}
          onSend={vi.fn()}
        />
      </div>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /History/i })).toHaveClass('hidden')
      expect(screen.queryByRole('button', { name: /Skills/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Files/i })).not.toBeInTheDocument()
      expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
      expect(screen.getByTitle('Agent')).toBeInTheDocument()
      expect(screen.getByTestId('fast-mode-toggle')).toBeInTheDocument()
      expect(screen.getByTestId('approval-mode-toggle')).toBeInTheDocument()
      expect(screen.getByTitle('Send')).toBeInTheDocument()
      expect(screen.queryByText(/(Cmd|Ctrl)\+Enter/)).not.toBeInTheDocument()
    })
  })

  it('hides the submit shortcut before New Chat toolbar controls can overlap', async () => {
    appSettingsMock.useModifierToSubmit = true
    renderWithI18n(
      <div style={{ width: '698px' }}>
        <PromptInput
          workspaceId="ws-1"
          mode="new-chat"
          backendId={null}
          onBackendChange={vi.fn()}
          providerId={null}
          onProviderChange={vi.fn()}
          fastMode={false}
          outputStyle={null}
          onOutputStyleChange={vi.fn()}
          onFastModeChange={vi.fn()}
          approvalMode="manual"
          onApprovalModeChange={vi.fn()}
          onSend={vi.fn()}
        />
      </div>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /History/i })).not.toHaveClass('hidden')
      expect(screen.queryByRole('button', { name: /Skills/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Files/i })).not.toBeInTheDocument()
      expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
      expect(screen.queryByText(/(Cmd|Ctrl)\+Enter/)).not.toBeInTheDocument()
    })
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

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith({ text: 'send me', images: [] }))
  })

  it('keeps the editor available for a newer draft while admission is pending', async () => {
    chatStoreMock.getState().pendingTurns['session-1'] = { clientTurnId: 'pending-1' }
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)

    expect(editableElement()).toHaveAttribute('contenteditable', 'true')
    await editableLocator().fill('next draft')

    expect(chatStoreMock.getState().drafts['session-1']).toBe('next draft')
    expect(screen.getByTitle('Send')).toBeDisabled()
  })

  it('sends repeatedly with Cmd+Enter when macOS omits the Enter keyup event', async () => {
    appSettingsMock.useModifierToSubmit = true
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()
    const el = editableElement()

    await input.fill('first message')
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        bubbles: true,
      }))
      el.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Meta',
        code: 'MetaLeft',
        bubbles: true,
      }))
    })

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith({ text: 'first message', images: [] }))

    await input.fill('second message')
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        bubbles: true,
      }))
    })

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith({ text: 'second message', images: [] }))
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
    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith({ text: '你好', images: [] }))
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
    expect(
      editableElement().querySelector('[data-prompt-reference-chip]'),
    ).toHaveTextContent('/commit')
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
    await waitFor(() => {
      const chip = editableElement().querySelector<HTMLElement>(
        '[data-prompt-reference-chip]',
      )
      expect(editableElement().textContent).toBe('@main.ts ')
      expect(chip?.textContent).toBe('@main.ts')
      expect(chip?.getAttribute('aria-label')).toBe('@src/main.ts')
      expect(extractPlainText(editableElement())).toBe('@src/main.ts ')
    })
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
    await waitFor(() => {
      expect(editableElement().textContent).toBe('check @main.ts ')
      expect(extractPlainText(editableElement())).toBe('check @src/main.ts ')
    })
  })

  it('reveals the full path in an instant tooltip when hovering a file chip', async () => {
    filesMock.results = [{ path: 'src/main.ts' }]
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('check @')
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })
    await userEvent.click(screen.getByText('src/main.ts'))
    const el = editableElement()
    const chip = await waitFor(() => {
      const found = el.querySelector<HTMLElement>('[data-prompt-reference-chip]')
      expect(found).toHaveTextContent('@main.ts')
      return found!
    })

    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    const tooltip = await waitFor(() => {
      const found = screen.getByRole('tooltip')
      expect(found).toHaveTextContent('@src/main.ts')
      return found
    })
    // Portaled to <body> with fixed positioning so no clipping ancestor
    // (e.g. the collapsing editor wrapper) can obscure it.
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.className).toContain('fixed')
    // The horizontal clamp is computed inline (Tailwind is not loaded in
    // browser tests, so geometry from class-based sizing is unreliable).
    expect(tooltip.style.left).toBe('140px')
    expect(tooltip.style.transform).toContain('-50%')

    chip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    await waitFor(() =>
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(),
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

    // Select the second history item by clicking it. Browser-mode userEvent
    // keyboard navigation targets the previously-clicked editable surface,
    // causing ArrowDown to select the wrong item; clicking keeps the test
    // focused on verifying the popup opens and commits a selection.
    await userEvent.click(screen.getByText('second'))
    await waitFor(() => expect(editableElement().textContent).toBe('second'))
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Search history...')).not.toBeInTheDocument(),
    )
  })

  it('does not suggest text from previously sent prompts', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()
    const sendButton = page.getByTitle('Send')

    await input.fill('explain the function')
    await sendButton.click()
    await input.fill('explain the function')
    await sendButton.click()

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledTimes(2))

    await input.fill('explain ')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByText('the')).not.toBeInTheDocument()
    await userEvent.keyboard('{Tab}')
    expect(extractPlainText(editableElement())).toBe('explain ')
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

  it('adds pasted images beside plain text without embedding them in the editor', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const el = editableElement()
    const image = new File([new Uint8Array([1])], 'screen.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'fix this')
    transfer.items.add(image)

    el.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: transfer,
    }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview screen.png' })).toBeInTheDocument())
    expect(extractPlainText(el)).toBe('fix this')
    expect(el.querySelector('img')).not.toBeInTheDocument()
  })

  it('allows image paste in New Chat before a backend is explicitly chosen', async () => {
    // Regression: the image gate must resolve the effective default backend
    // (like BackendSelector does) instead of treating an unchosen backend as
    // 'backend.capabilityUndeclared' ("Not available on this agent").
    renderWithI18n(
      <PromptInput
        workspaceId="ws-1"
        mode="new-chat"
        backendId={null}
        onBackendChange={vi.fn()}
        providerId={null}
        onProviderChange={vi.fn()}
        fastMode={false}
        outputStyle={null}
        onOutputStyleChange={vi.fn()}
        onFastModeChange={vi.fn()}
        approvalMode="manual"
        onApprovalModeChange={vi.fn()}
        onSend={vi.fn()}
      />,
    )
    const el = editableElement()
    const image = new File([new Uint8Array([1])], 'screen.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(image)

    el.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: transfer,
    }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview screen.png' })).toBeInTheDocument())
    expect(screen.queryByText('Not available on this agent')).not.toBeInTheDocument()
  })

  it('supports chooser intake and an image-only send', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    const { container } = renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const chooser = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const image = new File([new Uint8Array([1])], 'screen.png', { type: 'image/png' })

    fireEvent.change(chooser, { target: { files: [image] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview screen.png' })).toBeInTheDocument())
    await page.getByTitle('Send').click()

    await waitFor(() => expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith(expect.objectContaining({ text: '', images: expect.any(Array) })))
  })

  it('adds dropped images while preserving dropped plain text semantics', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const image = new File([new Uint8Array([1])], 'dropped.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'compare this')
    transfer.items.add(image)

    editableElement().dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      dataTransfer: transfer,
    }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview dropped.png' })).toBeInTheDocument())
    expect(extractPlainText(editableElement())).toBe('compare this')
  })

  it('keeps async intake attached to its originating session after a switch', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [
        { id: 'session-1', backend: 'claude', providerId: 'provider-1' },
        { id: 'session-2', backend: 'claude', providerId: 'provider-1' },
      ],
    }
    let resolveNormalization: ((images: Awaited<ReturnType<typeof imageInputMock.normalizeImageBatch>>) => void) | undefined
    imageInputMock.normalizeImageBatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveNormalization = resolve
    }))
    const view = renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const image = new File([new Uint8Array([1])], 'delayed.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(image)
    editableElement().dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: transfer,
    }))

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <div style={{ width: '800px' }}>
          <PromptInput {...DEFAULT_PROPS} sessionId="session-2" />
        </div>
      </I18nextProvider>,
    )
    resolveNormalization?.([{
      id: 'delayed',
      name: 'delayed.png',
      mediaType: 'image/png',
      data: 'AA==',
      width: 100,
      height: 50,
      blob: image,
      previewUrl: 'blob:delayed',
    }])

    await waitFor(() => expect(
      chatStoreMock.getState().imageDrafts['"ws-1":"session-1"'],
    ).toHaveLength(1))
    expect(chatStoreMock.getState().imageDrafts['"ws-1":"session-2"']).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Preview delayed.png' })).not.toBeInTheDocument()
  })

  it('releases a late image result instead of repopulating a cleared draft', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    chatStoreMock.setDraft('session-1', 'clear this')
    let resolveNormalization: ((images: Awaited<ReturnType<typeof imageInputMock.normalizeImageBatch>>) => void) | undefined
    imageInputMock.normalizeImageBatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveNormalization = resolve
    }))
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = new File([new Uint8Array([1])], 'late.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(input)
    editableElement().dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: transfer,
    }))
    await waitFor(() => expect(imageInputMock.normalizeImageBatch).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTitle('Clear'))
    const lateImage = {
      id: 'late',
      name: 'late.png',
      mediaType: 'image/png' as const,
      data: 'AA==',
      width: 100,
      height: 50,
      blob: input,
      previewUrl: 'blob:late',
    }
    await act(async () => resolveNormalization?.([lateImage]))

    expect(chatStoreMock.getState().imageDrafts['"ws-1":"session-1"']).toBeUndefined()
    expect(imageInputMock.releasePromptImage).toHaveBeenCalledWith(lateImage)
  })

  it('releases a late image result after the composer is disposed', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    let resolveNormalization: ((images: Awaited<ReturnType<typeof imageInputMock.normalizeImageBatch>>) => void) | undefined
    imageInputMock.normalizeImageBatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveNormalization = resolve
    }))
    const view = renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = new File([new Uint8Array([1])], 'disposed.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(input)
    editableElement().dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: transfer,
    }))
    await waitFor(() => expect(imageInputMock.normalizeImageBatch).toHaveBeenCalledTimes(1))
    view.unmount()

    const lateImage = {
      id: 'disposed',
      name: 'disposed.png',
      mediaType: 'image/png' as const,
      data: 'AA==',
      width: 100,
      height: 50,
      blob: input,
      previewUrl: 'blob:disposed',
    }
    await act(async () => resolveNormalization?.([lateImage]))

    expect(chatStoreMock.getState().imageDrafts['"ws-1":"session-1"']).toBeUndefined()
    expect(imageInputMock.releasePromptImage).toHaveBeenCalledWith(lateImage)
  })

  it('ignores a second image intake while the same draft is still normalizing', async () => {
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    let resolveNormalization: ((images: Awaited<ReturnType<typeof imageInputMock.normalizeImageBatch>>) => void) | undefined
    imageInputMock.normalizeImageBatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveNormalization = resolve
    }))
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)

    const pasteImage = (name: string) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array([1])], name, { type: 'image/png' }))
      editableElement().dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        clipboardData: transfer,
      }))
    }

    pasteImage('first.png')
    await waitFor(() => expect(imageInputMock.normalizeImageBatch).toHaveBeenCalledTimes(1))
    pasteImage('second.png')
    expect(imageInputMock.normalizeImageBatch).toHaveBeenCalledTimes(1)
    resolveNormalization?.([])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Image' })).toBeEnabled())
  })

  it('does not block image controls based on an unrecognized provider model name', async () => {
    providerStoreMock.providers = [
      { id: 'provider-1', model: 'custom-text-model', isDefault: true },
    ]
    chatStoreMock.getState().sessions = {
      'ws-1': [{ id: 'session-1', backend: 'claude', providerId: 'provider-1' }],
    }
    chatStoreMock.getState().imageDrafts['"ws-1":"session-1"'] = [{
      id: 'kept',
      name: 'kept.png',
      mediaType: 'image/png',
      data: 'AA==',
      width: 100,
      height: 50,
      blob: new Blob(),
      previewUrl: 'blob:kept',
    }]
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)

    expect(screen.getByRole('button', { name: 'Preview kept.png' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Image' })).toBeEnabled()
    expect(screen.getByTitle('Send')).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('replaces selected text when pasting', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const el = editableElement()

    await editableLocator().fill('hello world')
    await waitFor(() => expect(el.textContent).toBe('hello world'))

    // Select the word "world" (offsets 6..11).
    const selection = window.getSelection()
    const textNode = el.firstChild
    if (textNode) {
      const range = document.createRange()
      range.setStart(textNode, 6)
      range.setEnd(textNode, 11)
      selection?.removeAllRanges()
      selection?.addRange(range)
    }

    const dt = new DataTransfer()
    dt.setData('text/plain', 'pasted')
    const paste = new ClipboardEvent('paste', {
      bubbles: true,
      clipboardData: dt,
    })
    el.dispatchEvent(paste)

    await waitFor(() => expect(el.textContent).toBe('hello pasted'))
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

  it('shows live task details while keeping the composer available', async () => {
    chatStoreMock.getState().sessionActivity[DEFAULT_PROPS.sessionId] = {
      phase: 'background',
      active: true,
      backgroundTasks: [
        { id: 'agent-1', type: 'agent', description: 'Review the runtime lifecycle' },
        { id: 'command-1', type: 'command', description: 'Run focused server tests' },
      ],
    }
    chatStoreMock.setDraft(DEFAULT_PROPS.sessionId, 'Answer the main agent')

    renderWithI18n(
      <>
        <style>{ACTIVITY_LAYOUT_STYLES}</style>
        <PromptInput {...DEFAULT_PROPS} isStreaming />
      </>,
    )

    const activitySurface = screen.getByTestId('session-activity-details')
    expect(activitySurface).toHaveClass(
      'mx-auto',
      'w-fit',
      'max-w-full',
      'rounded-lg',
      'shadow-[0_8px_24px_-14px_rgba(0,0,0,0.45)]',
    )
    const activityRect = activitySurface.getBoundingClientRect()
    const inputRect = inputCardElement().getBoundingClientRect()
    expect(activityRect.width).toBeLessThan(inputRect.width)
    expect(Math.abs(
      activityRect.left + activityRect.width / 2 - (inputRect.left + inputRect.width / 2),
    )).toBeLessThan(1)
    expect(activitySurface.querySelector('svg')).toBeInTheDocument()
    expect(screen.getByText('2 background tasks running')).toBeInTheDocument()
    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(screen.getByText('Review the runtime lifecycle')).toBeInTheDocument()
    expect(screen.getByText('Command')).toBeInTheDocument()
    expect(screen.getByText('Run focused server tests')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).not.toHaveAttribute('contenteditable', 'false')
    expect(screen.getByRole('textbox')).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('button', { name: 'stop' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'stop' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))

    expect(DEFAULT_PROPS.onStop).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(DEFAULT_PROPS.onSend).toHaveBeenCalledWith({ text: 'Answer the main agent', images: [] })
  })

  it('uses the generic label for an unknown background task type', () => {
    chatStoreMock.getState().sessionActivity[DEFAULT_PROPS.sessionId] = {
      phase: 'background',
      active: true,
      backgroundTasks: [
        { id: 'future-1', type: 'future_sdk_task', description: 'Index the repository' },
      ],
    }

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)

    expect(screen.getByText('Background task')).toBeInTheDocument()
    expect(screen.getByText('Index the repository')).toBeInTheDocument()
  })

  it('stops only the selected Claude background task', async () => {
    let resolveStop!: () => void
    chatStoreMock.getState().sessions[DEFAULT_PROPS.workspaceId] = [
      { id: DEFAULT_PROPS.sessionId, backend: 'claude' },
    ]
    chatStoreMock.getState().sessionActivity[DEFAULT_PROPS.sessionId] = {
      phase: 'background',
      active: true,
      backgroundTasks: [
        { id: 'agent-1', type: 'agent', description: 'Review the runtime lifecycle' },
        { id: 'command-1', type: 'command', description: 'Run focused tests' },
      ],
    }
    chatStoreMock.getState().stopBackgroundTask.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveStop = resolve
      }),
    )

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)

    const stopAgent = screen.getByRole('button', {
      name: 'Stop task: Review the runtime lifecycle',
    })
    await userEvent.click(stopAgent)

    expect(chatStoreMock.getState().stopBackgroundTask).toHaveBeenCalledWith(
      DEFAULT_PROPS.workspaceId,
      DEFAULT_PROPS.sessionId,
      'agent-1',
    )
    expect(DEFAULT_PROPS.onStop).not.toHaveBeenCalled()
    expect(screen.getByRole('button', {
      name: 'Stopping task: Review the runtime lifecycle',
    })).toBeDisabled()
    expect(screen.getByRole('button', {
      name: 'Stop task: Run focused tests',
    })).toBeEnabled()

    await act(async () => {
      resolveStop()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Stop task: Review the runtime lifecycle',
      })).toBeEnabled()
    })
  })

  it('does not offer individual task stopping for OpenCode sessions', () => {
    chatStoreMock.getState().sessions[DEFAULT_PROPS.workspaceId] = [
      { id: DEFAULT_PROPS.sessionId, backend: 'opencode' },
    ]
    chatStoreMock.getState().sessionActivity[DEFAULT_PROPS.sessionId] = {
      phase: 'background',
      active: true,
      backgroundTasks: [
        { id: 'agent-1', type: 'agent', description: 'Review the runtime lifecycle' },
      ],
    }

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming />)

    expect(screen.queryByRole('button', {
      name: 'Stop task: Review the runtime lifecycle',
    })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'stop' })).toBeInTheDocument()
  })

  it('shows immediate stopping feedback without an actionable Stop button', () => {
    chatStoreMock.getState().sessionActivity[DEFAULT_PROPS.sessionId] = {
      phase: 'stopping',
      active: true,
      backgroundTasks: [],
    }

    renderWithI18n(<PromptInput {...DEFAULT_PROPS} isStreaming isInterrupting />)

    expect(screen.getByText('Stopping all Session work...')).toBeInTheDocument()
    expect(screen.getByTestId('session-activity-details')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: 'Stopping...' })).toBeDisabled()
  })

  it('contains long task descriptions in the bounded scroll region', () => {
    const longDescription = 'Inspect '.repeat(60).trim()
    chatStoreMock.getState().sessionActivity[DEFAULT_PROPS.sessionId] = {
      phase: 'background',
      active: true,
      backgroundTasks: [{ id: 'agent-1', type: 'agent', description: longDescription }],
    }

    renderWithI18n(
      <div style={{ width: '230px' }}>
        <style>{ACTIVITY_LAYOUT_STYLES}</style>
        <PromptInput {...DEFAULT_PROPS} isStreaming />
      </div>,
    )

    const region = screen.getByTestId('session-activity-details')
    const regionRect = region.getBoundingClientRect()
    const inputRect = inputCardElement().getBoundingClientRect()
    expect(region).toHaveClass('max-h-28', 'overflow-y-auto')
    expect(screen.getByText(longDescription)).toHaveClass('break-words')
    expect(regionRect.left).toBeGreaterThanOrEqual(inputRect.left)
    expect(regionRect.right).toBeLessThanOrEqual(inputRect.right)
    expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth)
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

  it('sizes the command picker popover to the input card width', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const card = inputCardElement()
    const input = editableLocator()

    await input.fill('/')
    await waitFor(() =>
      expect(screen.getByText('/commit')).toBeInTheDocument(),
    )

    const popover = screen.getByRole('dialog')
    expect(popover.offsetWidth).toBe(card.offsetWidth)
    expect(popover.getBoundingClientRect().left).toBeCloseTo(
      card.getBoundingClientRect().left,
      0,
    )
  })

  it('sizes the file picker popover to the input card width', async () => {
    filesMock.results = [{ path: 'src/main.ts' }]
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const card = inputCardElement()
    const input = editableLocator()

    await input.fill('@')
    await waitFor(() =>
      expect(screen.getByText('src/main.ts')).toBeInTheDocument(),
    )

    const popover = screen.getByRole('dialog')
    expect(popover.offsetWidth).toBe(card.offsetWidth)
    expect(popover.getBoundingClientRect().left).toBeCloseTo(
      card.getBoundingClientRect().left,
      0,
    )
  })

  it('sizes the history picker popover to the input card width', async () => {
    seedHistory(['first', 'second', 'third'])
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()
    const card = inputCardElement()

    await input.click()
    await userEvent.keyboard('{Alt>}h{/Alt}')
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search history/i)).toBeInTheDocument(),
    )

    const popover = popoverForPlaceholder(/Search history/i)
    expect(popover.offsetWidth).toBe(card.offsetWidth)
    expect(popover.getBoundingClientRect().left).toBeCloseTo(
      card.getBoundingClientRect().left,
      0,
    )
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

  const LEFT_CONTROLS = ['history']

  function queryControl(name: string) {
    switch (name) {
      case 'history':
        return screen.queryByRole('button', { name: /History/i })
      case 'provider':
        return screen.queryByTestId('provider-selector')
      case 'fast':
        return screen.queryByTestId('fast-mode-toggle')
      case 'approval':
        return screen.queryByTestId('approval-mode-toggle')
      case 'clear':
        return screen.queryByTitle('Clear')
      case 'send':
        return screen.queryByTitle('Send')
      default:
        throw new Error(`Unknown control: ${name}`)
    }
  }

  function renderAtWidth(width: number) {
    chatStoreMock.setDraft(DEFAULT_PROPS.sessionId, 'x')
    return renderWithI18n(
      <div style={{ width: `${width}px` }}>
        <PromptInput {...DEFAULT_PROPS} />
      </div>,
    )
  }

  it.each([
    {
      label: 'wide',
      width: 800,
      visible: ['history', 'provider', 'fast', 'approval', 'clear'],
      hidden: [] as string[],
    },
    {
      label: 'history-collapsed',
      width: 440,
      visible: ['provider', 'fast', 'approval', 'clear'],
      hidden: ['history'],
    },
    {
      label: 'provider-collapsed',
      width: 380,
      visible: ['fast', 'approval', 'clear'],
      hidden: ['history', 'provider'],
    },
    {
      label: 'fast-collapsed',
      width: 330,
      visible: ['approval', 'clear'],
      hidden: ['history', 'provider', 'fast'],
    },
    {
      label: 'approval-collapsed',
      width: 280,
      visible: ['clear'],
      hidden: ['history', 'provider', 'fast', 'approval'],
    },
    {
      label: 'minimal',
      width: 230,
      visible: [] as string[],
      hidden: ['history', 'provider', 'fast', 'approval', 'clear'],
    },
  ])(
    'responsive toolbar at $label width ($width px)',
    async ({ width, visible, hidden }) => {
      renderAtWidth(width)
      await waitFor(() => {
        visible.forEach((name) => {
          const el = queryControl(name)
          expect(el).toBeInTheDocument()
          if (LEFT_CONTROLS.includes(name)) {
            expect(el).not.toHaveClass('hidden')
          }
        })
        hidden.forEach((name) => {
          const el = queryControl(name)
          if (LEFT_CONTROLS.includes(name)) {
            expect(el).toBeInTheDocument()
            expect(el).toHaveClass('hidden')
          } else {
            expect(el).not.toBeInTheDocument()
          }
        })
      })
      expect(queryControl('send')).toBeInTheDocument()
    },
  )

  it('keeps the send button inside the input card when optional controls exceed the toolbar width', async () => {
    toolbarControlMock.forceWideControls = true
    chatStoreMock.setDraft(DEFAULT_PROPS.sessionId, 'x')
    renderWithI18n(
      <>
        <style>{TOOLBAR_LAYOUT_STYLES}</style>
        <div style={{ width: '380px' }}>
          <PromptInput {...DEFAULT_PROPS} />
        </div>
      </>,
    )

    const sendButton = await waitFor(() => {
      const button = queryControl('send')
      expect(button).toBeInTheDocument()
      return button!
    })
    const cardRect = inputCardElement().getBoundingClientRect()
    const sendRect = sendButton.getBoundingClientRect()

    expect(sendRect.right).toBeLessThanOrEqual(cardRect.right)
    expect(sendRect.left).toBeGreaterThanOrEqual(cardRect.left)
  })

  it('keeps the stop button inside the input card when optional controls exceed the toolbar width', async () => {
    toolbarControlMock.forceWideControls = true
    chatStoreMock.setDraft(DEFAULT_PROPS.sessionId, 'x')
    renderWithI18n(
      <>
        <style>{TOOLBAR_LAYOUT_STYLES}</style>
        <div style={{ width: '380px' }}>
          <PromptInput {...DEFAULT_PROPS} isStreaming />
        </div>
      </>,
    )

    const stopButton = await waitFor(() => {
      const button = screen.queryByRole('button', { name: /stop/i })
      expect(button).toBeInTheDocument()
      return button!
    })
    const cardRect = inputCardElement().getBoundingClientRect()
    const stopRect = stopButton.getBoundingClientRect()

    expect(stopRect.right).toBeLessThanOrEqual(cardRect.right)
    expect(stopRect.left).toBeGreaterThanOrEqual(cardRect.left)
  })

  it('keeps slash and at triggers working when toolbar controls are collapsed', async () => {
    renderAtWidth(230)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /History/i })).toHaveClass('hidden'),
    )

    const input = editableLocator()
    await input.fill('/')
    await waitFor(() => expect(screen.getByText('/commit')).toBeInTheDocument(), {
      timeout: 1000,
    })
  })

  it('atomizes only completed references that resolve', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('/commit')
    expect(
      editableElement().querySelector('[data-prompt-reference-chip]'),
    ).toBeNull()

    await input.fill('/commit-extra ')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      editableElement().querySelector('[data-prompt-reference-chip]'),
    ).toBeNull()

    await input.fill('/commit @src/app.ts /unknown @missing.ts')

    await waitFor(() => {
      expect(
        Array.from(
          editableElement().querySelectorAll('[data-prompt-reference-chip]'),
          (chip) => chip.textContent,
        ),
      ).toEqual(['/commit', '@app.ts'])
    })
  })

  it('reveals a newly invalid chip before allowing an explicit second send', async () => {
    let fileStillExists = true
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { paths: string[] }
      return {
        ok: true,
        json: async () => ({
          paths: fileStillExists
            ? body.paths.filter((path) => path === 'src/app.ts')
            : [],
        }),
      } as Response
    }))
    const onSend = vi.fn()
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} onSend={onSend} />)

    await editableLocator().fill('@src/app.ts ')
    await waitFor(() => {
      expect(
        editableElement().querySelector('[data-prompt-reference-chip]'),
      ).toHaveTextContent('@app.ts')
    })

    fileStillExists = false
    await page.getByTitle('Send').click()

    const invalidChip = await waitFor(() => {
      const chip = editableElement().querySelector<HTMLElement>(
        '[data-prompt-reference-chip]',
      )
      expect(chip).toHaveAttribute('aria-invalid', 'true')
      return chip!
    })
    expect(invalidChip.getAttribute('aria-label')).toContain('@src/app.ts')
    expect(onSend).not.toHaveBeenCalled()

    await page.getByTitle('Send').click()
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ text: '@src/app.ts ', images: [] }))
  })

  it('deletes a whole chip at its edge and restores it with undo', async () => {
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()
    await input.fill('/commit next')
    await waitFor(() => {
      expect(
        editableElement().querySelector('[data-prompt-reference-chip]'),
      ).toHaveTextContent('/commit')
    })

    act(() => setCaretOffset(editableElement(), '/commit'.length))
    await userEvent.keyboard('{Backspace}')
    await waitFor(() => expect(extractPlainText(editableElement())).toBe(' next'))

    await userEvent.keyboard('{Meta>}z{/Meta}')
    await waitFor(() => {
      expect(extractPlainText(editableElement())).toBe('/commit next')
      expect(
        editableElement().querySelector('[data-prompt-reference-chip]'),
      ).toHaveTextContent('/commit')
    })
  })

  it('copies the full path when a selection spans a file chip', async () => {
    filesMock.results = [{ path: 'src/main.ts' }]
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('@')
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(
        editableElement().querySelector('[data-prompt-reference-chip]'),
      ).toHaveTextContent('@main.ts')
    })

    const el = editableElement()
    act(() => setSelectionOffsets(el, 0, extractPlainText(el).length))
    const data = new DataTransfer()
    const copyEvent = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(copyEvent, 'clipboardData', { value: data })
    el.dispatchEvent(copyEvent)

    expect(copyEvent.defaultPrevented).toBe(true)
    expect(data.getData('text/plain')).toBe('@src/main.ts ')
  })

  it('cuts a selection ending at a file chip edge as the whole reference', async () => {
    filesMock.results = [{ path: 'src/main.ts' }]
    renderWithI18n(<PromptInput {...DEFAULT_PROPS} />)
    const input = editableLocator()

    await input.fill('check @')
    await waitFor(() => expect(screen.getByText('src/main.ts')).toBeInTheDocument(), {
      timeout: 1000,
    })
    await userEvent.click(screen.getByText('src/main.ts'))
    await waitFor(() => {
      expect(
        editableElement().querySelector('[data-prompt-reference-chip]'),
      ).toHaveTextContent('@main.ts')
    })

    // Select "check @src/main.ts" — the chip's plain-text range is atomic, so
    // offsets inside it snap to its edges and the cut removes it whole.
    const el = editableElement()
    act(() => setSelectionOffsets(el, 0, 'check @src/main.ts'.length))
    const data = new DataTransfer()
    const cutEvent = new ClipboardEvent('cut', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(cutEvent, 'clipboardData', { value: data })
    el.dispatchEvent(cutEvent)

    expect(cutEvent.defaultPrevented).toBe(true)
    expect(data.getData('text/plain')).toBe('check @src/main.ts')
    await waitFor(() => expect(extractPlainText(el)).toBe(' '))
    await waitFor(() =>
      expect(
        editableElement().querySelector('[data-prompt-reference-chip]'),
      ).toBeNull(),
    )
  })
})
