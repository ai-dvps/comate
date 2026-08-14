import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import App from '../App'
import i18n from '../i18n'
import { isWindows } from '../lib/platform'
import { isWindowMaximized, onWindowMaximizedChange } from '../lib/desktop-api'

// Keep the test focused on the outer layout shell by stubbing child components.
// The desktop bridge is the single boundary for shell capabilities (U2);
// mock it instead of the old per-package `@tauri-apps/*` modules.
vi.mock('../lib/desktop-api')

vi.mock('../components/WorkspaceEmptyState', () => ({ default: () => <div data-testid="workspace-empty-state" /> }))
vi.mock('../components/ChatPanel', () => ({ default: () => <div data-testid="chat-panel" /> }))
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
  default: ({ onOpenTodos }: { onOpenTodos: () => void }) => (
    <div data-testid="agent-command-center"><button onClick={onOpenTodos}>Open Todos</button></div>
  ),
}))
vi.mock('../components/ManagementWorkspace', () => ({
  default: () => <div data-testid="management-workspace" />,
}))
vi.mock('../components/CreateWorkspaceModal', () => ({ default: () => <div data-testid="create-workspace-modal" /> }))
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
    await findByTestId('workspace-empty-state')
    const root = container.firstElementChild
    expect(root).toHaveClass('overflow-hidden')
    expect(root).not.toHaveClass('overflow-x-hidden')
  })

  it('marks context controls unavailable on the Welcome screen', async () => {
    const { findByTestId } = renderWithI18n(<App />)

    await findByTestId('workspace-empty-state')
    expect(await findByTestId('custom-titlebar')).toHaveAttribute('data-context-available', 'false')
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
    await findByTestId('workspace-empty-state')
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
    await findByTestId('workspace-empty-state')
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
    await findByTestId('workspace-empty-state')
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
    fireEvent.click(document.querySelector('[data-testid="agent-command-center"] button') as HTMLButtonElement)

    expect(document.querySelector('[data-testid="management-workspace"]')).toBeInTheDocument()
    expect(document.querySelector('[data-testid="chat-panel"]')).toBeInTheDocument()
    expect(sessionWorkspace).toHaveClass('invisible', 'pointer-events-none')
    expect(sessionWorkspace).toHaveAttribute('aria-hidden', 'true')
    expect(sessionWorkspace).toHaveAttribute('inert')
    expect(document.querySelector('[data-testid="context-workspace"]')).toHaveAttribute('data-collapsed', 'true')
  })
})
