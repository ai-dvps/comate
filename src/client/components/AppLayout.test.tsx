import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import App from '../App'
import i18n from '../i18n'

// Keep the test focused on the outer layout shell by stubbing child components.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: vi.fn(),
    unminimize: vi.fn(),
    setFocus: vi.fn(),
    startDragging: vi.fn(),
  }),
}))

vi.mock('../components/Sidebar', () => ({ default: () => <div data-testid="sidebar" /> }))
vi.mock('../components/WorkspaceTabs', () => ({ default: () => <div data-testid="workspace-tabs" /> }))
vi.mock('../components/WorkspaceSwitcher', () => ({ default: () => <div data-testid="workspace-switcher" /> }))
vi.mock('../components/WorkspaceEmptyState', () => ({ default: () => <div data-testid="workspace-empty-state" /> }))
vi.mock('../components/ChatPanel', () => ({ default: () => <div data-testid="chat-panel" /> }))
vi.mock('../components/SettingsPanel', () => ({ default: () => <div data-testid="settings-panel" /> }))
vi.mock('../components/AnalyticsPanel', () => ({ default: () => <div data-testid="analytics-panel" /> }))
vi.mock('../components/RightPanel', () => ({ default: () => <div data-testid="right-panel" /> }))
vi.mock('../components/HeaderToolbar', () => ({ default: () => <div data-testid="header-toolbar" /> }))
vi.mock('../components/CreateWorkspaceModal', () => ({ default: () => <div data-testid="create-workspace-modal" /> }))
vi.mock('../components/ToastContainer', () => ({ default: () => <div data-testid="toast-container" /> }))
vi.mock('../components/UpdateNotification', () => ({ default: () => <div data-testid="update-notification" /> }))
vi.mock('../components/UpdateRestartDialog', () => ({ default: () => <div data-testid="update-restart-dialog" /> }))
vi.mock('../components/tool-renderers/ToolRendererContext', () => ({
  ToolRendererProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../hooks/use-theme', () => ({ useTheme: () => {} }))
vi.mock('../hooks/use-app-settings', () => ({
  useAppSettings: () => ({
    uiFontSize: 'base',
    autoCheckUpdates: false,
    setLastUpdateCheckAt: vi.fn(),
    chatFontSize: 'base',
    displayMode: 'linear',
    useModifierToSubmit: false,
  }),
}))
vi.mock('../lib/use-badge-sync', () => ({ useBadgeSync: () => {} }))
vi.mock('../lib/use-notification-sounds', () => ({ useNotificationSounds: () => {} }))
vi.mock('../hooks/use-sidebar-width', () => ({
  useSidebarWidth: () => ({
    width: 240,
    setWidth: vi.fn(),
    isCollapsed: false,
    toggleCollapse: vi.fn(),
  }),
}))
vi.mock('../hooks/use-right-panel-width', () => ({
  useRightPanelWidth: () => ({
    width: 640,
    setWidth: vi.fn(),
    isCollapsed: false,
    toggleCollapse: vi.fn(),
    expandedWidth: 640,
  }),
  RAIL_WIDTH: 48,
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
  activeSessionIds: {},
  setActiveSession: vi.fn(),
}

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector?: (s: typeof mockChatStore) => unknown) =>
    selector ? selector(mockChatStore) : mockChatStore,
}))

vi.mock('../lib/platform', () => ({ isMacOS: () => Promise.resolve(false) }))
vi.mock('../lib/font-size', () => ({ fontSizeClass: () => 'text-base' }))
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
  })

  it('clips the root container vertically to prevent the whole page from scrolling', async () => {
    const { container, findByTestId } = renderWithI18n(<App />)
    await findByTestId('workspace-empty-state')
    const root = container.firstElementChild
    expect(root).toHaveClass('overflow-hidden')
    expect(root).not.toHaveClass('overflow-x-hidden')
  })

  it('renders RightPanel and not legacy FilePanel/GitDiffPanel when a workspace is active', async () => {
    mockWorkspaceStore.activeWorkspaceId = 'ws1'
    mockWorkspaceStore.openWorkspaceIds = ['ws1']
    mockWorkspaceStore.workspaces = [{ id: 'ws1', name: 'Test', folderPath: '/tmp' }]

    const { findByTestId, queryByTestId } = renderWithI18n(<App />)
    await findByTestId('chat-panel')

    expect(queryByTestId('right-panel')).toBeInTheDocument()
    expect(queryByTestId('file-panel')).not.toBeInTheDocument()
    expect(queryByTestId('git-diff-panel')).not.toBeInTheDocument()
  })
})
