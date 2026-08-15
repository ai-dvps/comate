import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, cleanup, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import App from '../App'
import i18n from '../i18n'
import { isWindows } from '../lib/platform'
import { isWindowMaximized, onWindowMaximizedChange } from '../lib/desktop-api'

// Keep the test focused on the outer layout shell by stubbing child components.
// The desktop bridge is the single boundary for shell capabilities (U2);
// mock it instead of the old per-package `@tauri-apps/*` modules.
vi.mock('../lib/desktop-api')

vi.mock('../components/ChatPanel', () => ({ default: () => <div data-testid="chat-panel" /> }))
vi.mock('../components/PromptInput', () => ({
  default: function MockPromptInput({
    onSend,
    onBackendChange,
    onProviderChange,
    fastMode,
    onFastModeChange,
    onApprovalModeChange,
    disabled,
  }: {
    onSend: (content: string) => void
    onBackendChange?: (backendId: 'claude' | 'opencode') => void
    onProviderChange?: (providerId: string | null) => void
    fastMode?: boolean
    onFastModeChange?: (fastMode: boolean) => void
    onApprovalModeChange?: (approvalMode: 'auto' | 'readonly' | 'manual') => void
    disabled?: boolean
  }) {
    const [value, setValue] = useState('')
    return (
      <div data-testid="prompt-input">
        <textarea
          aria-label="Prompt"
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="button" onClick={() => onBackendChange?.('opencode')}>Choose agent</button>
        <button type="button" onClick={() => onProviderChange?.('provider-2')}>Choose provider</button>
        <button type="button" onClick={() => onFastModeChange?.(!fastMode)}>Toggle fast</button>
        <button type="button" onClick={() => onApprovalModeChange?.('auto')}>Choose permission</button>
        <button type="button" disabled={disabled || !value.trim()} onClick={() => onSend(value.trim())}>Send</button>
      </div>
    )
  },
}))
vi.mock('../components/SettingsPanel', () => ({ default: () => <div data-testid="settings-panel" /> }))
vi.mock('../components/AnalyticsPanel', () => ({ default: () => <div data-testid="analytics-panel" /> }))
vi.mock('../components/ContextWorkspace', () => ({
  default: ({ isCollapsed }: { isCollapsed: boolean }) => (
    <div data-testid="context-workspace" data-collapsed={isCollapsed} />
  ),
}))
vi.mock('../components/CustomTitlebar', () => ({
  default: ({
    contextAvailable,
    onAddTab,
    onToggleRight,
  }: {
    contextAvailable: boolean
    onAddTab: () => void
    onToggleRight: () => void
  }) => (
    <div data-testid="custom-titlebar" data-context-available={contextAvailable}>
      <button type="button" onClick={onAddTab}>Add context tab</button>
      <button type="button" onClick={onToggleRight}>Toggle right panel</button>
    </div>
  ),
}))
vi.mock('../components/AgentCommandCenter', () => ({
  default: ({ onOpenTodos, onNewChat }: { onOpenTodos: () => void; onNewChat: () => void }) => (
    <div data-testid="agent-command-center">
      <button onClick={onNewChat}>New chat</button>
      <button onClick={onOpenTodos}>Open Todos</button>
    </div>
  ),
}))
vi.mock('../components/ManagementWorkspace', () => ({
  default: () => <div data-testid="management-workspace" />,
}))
vi.mock('../components/CreateWorkspaceModal', () => ({
  default: ({ onCreated }: { onCreated?: (workspace: { id: string; name: string; folderPath: string }) => void }) => (
    <div data-testid="create-workspace-modal">
      <button
        type="button"
        onClick={() => {
          const workspace = { id: 'ws-created', name: 'Created', folderPath: '/created' }
          mockWorkspaceStore.workspaces = [...mockWorkspaceStore.workspaces, workspace]
          onCreated?.(workspace)
        }}
      >
        Complete workspace creation
      </button>
    </div>
  ),
}))
vi.mock('../components/ToastContainer', () => ({ default: () => <div data-testid="toast-container" /> }))
vi.mock('../components/UpdateNotification', () => ({ default: () => <div data-testid="update-notification" /> }))
vi.mock('../components/UpdateRestartDialog', () => ({ default: () => <div data-testid="update-restart-dialog" /> }))
vi.mock('../components/tool-renderers/ToolRendererContext', () => ({
  ToolRendererProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../hooks/use-theme', () => ({ useTheme: () => {} }))
vi.mock('../hooks/use-app-settings', () => {
  const setLastUpdateCheckAt = vi.fn()
  return {
    useAppSettings: () => ({
      uiFontSize: 14,
      autoCheckUpdates: false,
      setLastUpdateCheckAt,
      chatFontSize: 12,
      displayMode: 'linear',
      useModifierToSubmit: false,
    }),
  }
})
vi.mock('../lib/use-badge-sync', () => ({ useBadgeSync: () => {} }))
vi.mock('../lib/use-notification-sounds', () => ({ useNotificationSounds: () => {} }))
vi.mock('../hooks/use-sidebar-width', () => ({
  useSidebarWidth: () => ({
    width: 240,
    expandedWidth: 240,
    setWidth: vi.fn(),
    isCollapsed: false,
    toggleCollapse: vi.fn(),
  }),
}))
let rightPanelInitiallyCollapsed = false
vi.mock('../hooks/use-right-panel-width', () => ({
  useRightPanelWidth: () => {
    const [isCollapsed, setIsCollapsed] = useState(rightPanelInitiallyCollapsed)
    return {
      width: isCollapsed ? 0 : 640,
      setWidth: vi.fn(),
      isCollapsed,
      toggleCollapse: () => setIsCollapsed((collapsed) => !collapsed),
      expandedWidth: 640,
    }
  },
}))
vi.mock('../hooks/use-sidebar-keyboard-shortcut', () => ({
  useSidebarKeyboardShortcut: () => {},
}))
vi.mock('../hooks/use-migration-notice', () => ({
  useMigrationNotice: () => ({ visible: false, auditLogsCleared: 0, dismiss: vi.fn() }),
}))

const mockWorkspaceStore: {
  workspaces: Array<{ id: string; name: string; folderPath: string }>
  activeWorkspaceId: string | null
  openWorkspaceIds: string[]
  fetchWorkspaces: ReturnType<typeof vi.fn>
  openWorkspace: ReturnType<typeof vi.fn>
} = {
  workspaces: [],
  activeWorkspaceId: null,
  openWorkspaceIds: [],
  fetchWorkspaces: vi.fn(),
  openWorkspace: vi.fn(),
}

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: typeof mockWorkspaceStore) => unknown) =>
    selector ? selector(mockWorkspaceStore) : mockWorkspaceStore,
}))

const mockProviderStore = {
  providers: [],
  fetchProviders: vi.fn(),
  detectProviders: vi.fn(),
}

vi.mock('../stores/provider-store', () => ({
  useProviderStore: (selector?: (s: typeof mockProviderStore) => unknown) =>
    selector ? selector(mockProviderStore) : mockProviderStore,
}))

const mockChatStore = {
  sessions: {},
  activeSessionIds: {},
  setActiveSession: vi.fn(),
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  setDraft: vi.fn(),
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector?: (s: typeof mockChatStore) => unknown) =>
    selector ? selector(mockChatStore) : mockChatStore,
}))

const mockContextTabStore = {
  openTabs: [],
  activeTabId: null,
  setContext: vi.fn(),
  selectTab: vi.fn(),
  closeTab: vi.fn(),
  openFileWorkspace: vi.fn(),
}

vi.mock('../stores/context-tab-store', () => ({
  useContextTabStore: Object.assign(
    (selector: (state: typeof mockContextTabStore) => unknown) => selector(mockContextTabStore),
    { getState: () => mockContextTabStore },
  ),
}))

vi.mock('../lib/platform', () => ({
  isMacOS: vi.fn(() => Promise.resolve(false)),
  isWindows: vi.fn(() => Promise.resolve(false)),
}))
vi.mock('../lib/updater-api', () => ({
  startPeriodicUpdateChecks: () => {},
  stopPeriodicUpdateChecks: () => {},
}))

global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  })
) as unknown as typeof global.fetch

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('App layout', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockWorkspaceStore.openWorkspace.mockReset()
    mockWorkspaceStore.activeWorkspaceId = null
    mockWorkspaceStore.openWorkspaceIds = []
    mockWorkspaceStore.workspaces = []
    rightPanelInitiallyCollapsed = false
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    vi.mocked(isWindows).mockResolvedValue(false)
    vi.mocked(isWindowMaximized).mockResolvedValue(false)
    vi.mocked(onWindowMaximizedChange).mockReturnValue(() => {})
  })

  it('clips the root container vertically to prevent the whole page from scrolling', async () => {
    const { container, findByTestId } = renderWithI18n(<App />)
    await findByTestId('new-chat-workspace-gate')
    const root = container.firstElementChild
    expect(root).toHaveClass('overflow-hidden')
    expect(root).not.toHaveClass('overflow-x-hidden')
  })

  it('marks context controls unavailable on the default New Chat screen', async () => {
    const { findByTestId } = renderWithI18n(<App />)

    await findByTestId('new-chat-workspace-gate')
    expect(await findByTestId('custom-titlebar')).toHaveAttribute('data-context-available', 'false')
  })

  it('uses New Chat as the default screen instead of the legacy Welcome screen', async () => {
    renderWithI18n(<App />)

    expect(await screen.findByTestId('new-chat-workspace-gate')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-empty-state')).not.toBeInTheDocument()
  })

  it('opens New Chat and creates then sends the first prompt', async () => {
    mockWorkspaceStore.workspaces = [{ id: 'ws-1', name: 'Comate', folderPath: '/comate' }]
    mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    mockWorkspaceStore.openWorkspaceIds = ['ws-1']
    mockChatStore.createSession.mockResolvedValue({
      ok: true,
      session: {
        id: 'session-new',
        workspaceId: 'ws-1',
        name: 'Fix redirects',
        createdAt: '',
        updatedAt: '',
      },
    })

    renderWithI18n(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Fix redirects' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose provider' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle fast' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose permission' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(mockChatStore.createSession).toHaveBeenCalledWith('ws-1', expect.objectContaining({
        initialPrompt: 'Fix redirects',
        backend: 'opencode',
        providerId: 'provider-2',
        fastMode: true,
        approvalMode: 'auto',
        signal: expect.any(AbortSignal),
      }))
      expect(mockChatStore.sendMessage).toHaveBeenCalledWith('ws-1', 'session-new', 'Fix redirects')
    })
  })

  it('keeps the active session mounted but hidden while New Chat is open', async () => {
    mockWorkspaceStore.workspaces = [{ id: 'ws-1', name: 'Comate', folderPath: '/comate' }]
    mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    mockWorkspaceStore.openWorkspaceIds = ['ws-1']

    renderWithI18n(<App />)
    const chatPanel = await screen.findByTestId('chat-panel')
    const sessionWorkspace = chatPanel.parentElement

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    expect(screen.getByTestId('new-chat-page')).toBeInTheDocument()
    expect(chatPanel).toBeInTheDocument()
    expect(sessionWorkspace).toHaveClass('invisible', 'pointer-events-none')
    expect(sessionWorkspace).toHaveAttribute('aria-hidden', 'true')
    expect(sessionWorkspace).toHaveAttribute('inert')
  })

  it('creates a session when submitting directly from the default New Chat screen', async () => {
    mockWorkspaceStore.workspaces = [{ id: 'ws-1', name: 'Comate', folderPath: '/comate' }]
    mockWorkspaceStore.openWorkspace.mockImplementation(() => {
      mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    })
    let resolveCreation: ((result: {
      ok: true
      session: { id: string; workspaceId: string; name: string; createdAt: string; updatedAt: string }
    }) => void) | undefined
    mockChatStore.createSession.mockReturnValue(new Promise((resolve) => {
      resolveCreation = resolve
    }))

    renderWithI18n(<App />)
    fireEvent.change(await screen.findByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Start from the default screen' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(mockChatStore.createSession).toHaveBeenCalled())
    expect(screen.getByTestId('prompt-input')).toBeInTheDocument()

    resolveCreation?.({
      ok: true,
      session: {
        id: 'session-default',
        workspaceId: 'ws-1',
        name: 'Start from the default screen',
        createdAt: '',
        updatedAt: '',
      },
    })
    await waitFor(() => expect(mockChatStore.sendMessage).toHaveBeenCalledWith(
      'ws-1',
      'session-default',
      'Start from the default screen',
    ))
  })

  it('selects a workspace created from New Chat before submitting', async () => {
    mockWorkspaceStore.workspaces = [{ id: 'ws-1', name: 'Comate', folderPath: '/comate' }]
    mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    mockWorkspaceStore.openWorkspaceIds = ['ws-1']
    mockChatStore.createSession.mockResolvedValue({
      ok: true,
      session: { id: 'session-new', workspaceId: 'ws-created', name: 'Prompt', createdAt: '', updatedAt: '' },
    })

    renderWithI18n(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Create workspace…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Complete workspace creation' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace' })).toHaveTextContent('Created'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Use the new workspace' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(mockChatStore.createSession).toHaveBeenCalledWith(
      'ws-created',
      expect.objectContaining({ initialPrompt: 'Use the new workspace' }),
    ))
  })

  it('keeps the New Chat prompt visible after a recoverable creation failure', async () => {
    mockWorkspaceStore.workspaces = [{ id: 'ws-1', name: 'Comate', folderPath: '/comate' }]
    mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    mockWorkspaceStore.openWorkspaceIds = ['ws-1']
    mockChatStore.createSession.mockResolvedValue({
      ok: false,
      reason: 'timeout',
      error: 'Creating the session timed out. Try again.',
    })

    renderWithI18n(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'Retry this prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Creating the session timed out. Try again.')
    expect(prompt).toHaveValue('Retry this prompt')
    expect(mockChatStore.sendMessage).not.toHaveBeenCalled()
  })

  it('ignores a session response that arrives after leaving New Chat', async () => {
    mockWorkspaceStore.workspaces = [{ id: 'ws-1', name: 'Comate', folderPath: '/comate' }]
    mockWorkspaceStore.activeWorkspaceId = 'ws-1'
    mockWorkspaceStore.openWorkspaceIds = ['ws-1']
    let resolveCreation: ((result: unknown) => void) | undefined
    mockChatStore.createSession.mockReturnValue(new Promise((resolve) => {
      resolveCreation = resolve
    }))

    renderWithI18n(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Do not reopen me' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Todos' }))

    resolveCreation?.({
      ok: true,
      session: { id: 'late', workspaceId: 'ws-1', name: 'Late', createdAt: '', updatedAt: '' },
    })
    await waitFor(() => expect(screen.getByTestId('management-workspace')).toBeInTheDocument())
    expect(mockChatStore.sendMessage).not.toHaveBeenCalled()
  })

  it('shows the Windows top frame only while the window is restored', async () => {
    vi.mocked(isWindows).mockResolvedValue(true)
    let handleMaximizedChange: ((maximized: boolean) => void) | undefined
    const stopListening = vi.fn()
    vi.mocked(onWindowMaximizedChange).mockImplementation((handler) => {
      handleMaximizedChange = handler
      return stopListening
    })

    const { container, findByTestId, unmount } = renderWithI18n(<App />)
    await findByTestId('new-chat-workspace-gate')
    const root = container.firstElementChild

    await waitFor(() => expect(root).toHaveAttribute('data-windows-restored-frame'))

    act(() => handleMaximizedChange?.(true))
    expect(root).not.toHaveAttribute('data-windows-restored-frame')

    act(() => handleMaximizedChange?.(false))
    expect(root).toHaveAttribute('data-windows-restored-frame')

    unmount()
    expect(stopListening).toHaveBeenCalledTimes(1)
  })

  it('does not show the Windows top frame when launched maximized', async () => {
    vi.mocked(isWindows).mockResolvedValue(true)
    vi.mocked(isWindowMaximized).mockResolvedValue(true)

    const { container, findByTestId } = renderWithI18n(<App />)
    await findByTestId('new-chat-workspace-gate')
    const root = container.firstElementChild

    await waitFor(() => expect(isWindowMaximized).toHaveBeenCalledTimes(1))
    expect(root).not.toHaveAttribute('data-windows-restored-frame')
  })

  it('does not let the initial query overwrite a newer maximize event', async () => {
    vi.mocked(isWindows).mockResolvedValue(true)
    let resolveInitialState: ((maximized: boolean) => void) | undefined
    vi.mocked(isWindowMaximized).mockReturnValue(new Promise((resolve) => {
      resolveInitialState = resolve
    }))
    let handleMaximizedChange: ((maximized: boolean) => void) | undefined
    vi.mocked(onWindowMaximizedChange).mockImplementation((handler) => {
      handleMaximizedChange = handler
      return () => {}
    })

    const { container, findByTestId } = renderWithI18n(<App />)
    await findByTestId('new-chat-workspace-gate')
    const root = container.firstElementChild
    await waitFor(() => expect(handleMaximizedChange).toBeDefined())

    act(() => handleMaximizedChange?.(true))
    resolveInitialState?.(false)
    await waitFor(() => expect(root).not.toHaveAttribute('data-windows-restored-frame'))

    expect(root).not.toHaveAttribute('data-windows-restored-frame')
  })

  it('renders the typed ContextWorkspace and not legacy panels when a workspace is active', async () => {
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.workspaces = [{ id: 'ws1', name: 'Test', folderPath: '/tmp' }]

    const { findByTestId, queryByTestId } = renderWithI18n(<App />)
    await findByTestId('chat-panel')

    expect(queryByTestId('custom-titlebar')).toBeInTheDocument()
    expect(queryByTestId('custom-titlebar')).toHaveAttribute('data-context-available', 'true')
    expect(queryByTestId('agent-command-center')).toBeInTheDocument()
    expect(queryByTestId('context-workspace')).toBeInTheDocument()
    expect(queryByTestId('file-panel')).not.toBeInTheDocument()
    expect(queryByTestId('git-diff-panel')).not.toBeInTheDocument()
  })

  it('collapses an auto-expanded right panel on the first click when no Session is open', async () => {
    rightPanelInitiallyCollapsed = true
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1800 })
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.workspaces = [{ id: 'ws1', name: 'Test', folderPath: '/tmp' }]

    const { findByTestId, getByRole, getByTestId } = renderWithI18n(<App />)
    expect(await findByTestId('context-workspace')).toHaveAttribute('data-collapsed', 'true')

    fireEvent.click(getByRole('button', { name: 'Add context tab' }))
    fireEvent.click(getByRole('menuitem', { name: 'Files' }))
    await waitFor(() => expect(getByTestId('context-workspace')).toHaveAttribute('data-collapsed', 'false'))

    fireEvent.click(getByRole('button', { name: 'Toggle right panel' }))
    await waitFor(() => expect(getByTestId('context-workspace')).toHaveAttribute('data-collapsed', 'true'))
  })

  it('keeps Session work mounted and hides Browser content during management navigation', async () => {
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.workspaces = [{ id: 'ws1', name: 'Test', folderPath: '/tmp' }]

    renderWithI18n(<App />)
    await waitFor(() => expect(document.querySelector('[data-testid="chat-panel"]')).toBeInTheDocument())
    const sessionWorkspace = document.querySelector('[data-testid="chat-panel"]')?.parentElement

    expect(sessionWorkspace).toHaveClass('visible')
    expect(sessionWorkspace).not.toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Open Todos' }))

    expect(document.querySelector('[data-testid="management-workspace"]')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="chat-panel"]')).toBeInTheDocument()
    expect(sessionWorkspace).toHaveClass('invisible', 'pointer-events-none')
    expect(sessionWorkspace).toHaveAttribute('aria-hidden', 'true')
    expect(sessionWorkspace).toHaveAttribute('inert')
    expect(document.querySelector('[data-testid="context-workspace"]')).toHaveAttribute('data-collapsed', 'true')
  })
})
