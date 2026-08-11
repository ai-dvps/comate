import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import RightPanel from './RightPanel'
import RightPanelContent from './RightPanelContent'
import CodeMirrorDiffViewer from './CodeMirrorDiffViewer'
import { MergeView } from '@codemirror/merge'
import { useRightPanelStore, type FileTab, type DiffTab } from '../stores/right-panel-store'
import i18n from '../i18n'

vi.mock('@uiw/react-codemirror', () => ({
  default: function CodeMirrorMock({ value, className }: { value?: string; className?: string }) {
    return <pre data-testid="codemirror" className={className}>{value}</pre>
  },
}))

vi.mock('@codemirror/merge', () => ({
  unifiedMergeView: vi.fn(() => []),
  MergeView: vi.fn(() => ({ destroy: vi.fn() })),
}))

vi.mock('./MarkdownPreview', () => ({
  default: function MarkdownPreviewMock({ content }: { content: string }) {
    return <div data-testid="markdown-preview">{content}</div>
  },
}))

vi.mock('./FileExplorer', () => ({
  default: function FileExplorerMock({
    onFileClick,
    selectedPath,
    onSelectPath,
  }: {
    onFileClick: (path: string, name: string) => void
    selectedPath?: string | null
    onSelectPath?: (path: string) => void
  }) {
    return (
      <div data-testid="file-explorer" data-selected={selectedPath ?? ''}>
        <button data-testid="mock-open-file" onClick={() => onFileClick('src/App.tsx', 'App.tsx')}>
          Open file
        </button>
        <button
          data-testid="mock-select-file"
          onClick={() => onSelectPath?.('src/App.tsx')}
        >
          Select file
        </button>
      </div>
    )
  },
}))

vi.mock('./GitChangesPanel', () => ({
  default: function GitChangesPanelMock() {
    return <div data-testid="git-changes-list" />
  },
}))

vi.mock('./browser/BrowserPane', () => ({
  default: function BrowserPaneMock({ workspaceId }: { workspaceId: string }) {
    return <div data-testid="browser-pane" data-workspace={workspaceId} />
  },
}))

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { openWorkspaceIds: string[] }) => unknown) =>
    selector ? selector({ openWorkspaceIds: ['ws1'] }) : { openWorkspaceIds: ['ws1'] },
}))

vi.mock('../stores/chat-store', () => ({
  useChatStore: (selector?: (s: { activeSessionIds: Record<string, string> }) => unknown) =>
    selector
      ? selector({ activeSessionIds: { ws1: 'sess-1' } })
      : { activeSessionIds: { ws1: 'sess-1' } },
}))

vi.mock('../stores/browser-pane-store', () => ({
  useBrowserPaneStore: (selector?: (s: {
    setPaneOpen: (sessionId: string, open: boolean) => void
  }) => unknown) =>
    selector
      ? selector({ setPaneOpen: vi.fn() })
      : { setPaneOpen: vi.fn() },
  selectSessionOpen: () => false,
  selectHandoffPending: () => false,
}))

function resetStore() {
  useRightPanelStore.setState({
    activeListTab: 'files',
    openTabs: [],
    activeTabId: null,
  })
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('RightPanel', () => {
  beforeEach(() => {
    cleanup()
    resetStore()
    vi.clearAllMocks()
  })

  it('renders fully hidden when collapsed', () => {
    renderWithI18n(
      <RightPanel
        width={0}
        isCollapsed={true}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    const panel = screen.getByTestId('right-panel')
    expect(panel).toHaveStyle({ width: '0px' })
    const filesTab = screen.queryByTestId('right-panel-files-tab')
    expect(filesTab).toBeInTheDocument()
    // The content wrapper is hidden so nothing inside the panel is visible.
    expect(filesTab?.closest('.hidden')).toBeInTheDocument()
    expect(screen.queryByTestId('right-panel-rail')).not.toBeInTheDocument()
  })

  it('renders Files, Git Changes and Browser tabs when expanded', () => {
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('right-panel-files-tab')).toBeInTheDocument()
    expect(screen.getByTestId('right-panel-git-tab')).toBeInTheDocument()
    expect(screen.getByTestId('right-panel-browser-tab')).toBeInTheDocument()
  })

  it('switches to the browser tab and opens the browser pane', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('browser-pane')).toBeInTheDocument()

    await user.click(screen.getByTestId('right-panel-browser-tab'))

    expect(useRightPanelStore.getState().activeListTab).toBe('browser')
    expect(screen.getByTestId('browser-pane')).toBeInTheDocument()
    expect(screen.queryByTestId('right-panel-list-sidebar')).not.toBeInTheDocument()
  })

  it('keeps the browser pane mounted but hidden when switching back to files', async () => {
    const user = userEvent.setup()
    useRightPanelStore.setState({ activeListTab: 'browser' })

    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('browser-pane')).toBeInTheDocument()

    await user.click(screen.getByTestId('right-panel-files-tab'))

    expect(useRightPanelStore.getState().activeListTab).toBe('files')
    // Browser pane stays mounted; its parent container is hidden via CSS.
    expect(screen.getByTestId('browser-pane')).toBeInTheDocument()
    expect(screen.getByTestId('right-panel-list-sidebar')).toBeInTheDocument()
  })

  it('keeps the native browser surface clear of the panel resize handle', () => {
    useRightPanelStore.setState({ activeListTab: 'browser' })

    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    const browserSurface = screen.getByTestId('browser-pane').parentElement
    expect(browserSurface).toHaveStyle({ left: '4px' })
  })

  it('expands to show the list sidebar and hides the content panel when no tabs are open', () => {
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('right-panel-list-sidebar')).toBeInTheDocument()
    expect(screen.queryByTestId('right-panel-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument()
  })

  it('shows the content panel when at least one tab is open', () => {
    const fileTab: FileTab = {
      type: 'file',
      id: 'file:src/App.tsx',
      path: 'src/App.tsx',
      name: 'App.tsx',
      content: '',
      isBinary: false,
    }
    useRightPanelStore.setState({ openTabs: [fileTab], activeTabId: fileTab.id })

    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('right-panel-list-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('right-panel-content')).toBeInTheDocument()
  })

  it('clicking the Git icon switches to the Git Changes list tab', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('file-explorer')).toBeInTheDocument()

    await user.click(screen.getByTestId('right-panel-git-tab'))

    expect(screen.getByTestId('git-changes-list')).toBeInTheDocument()
    expect(screen.queryByTestId('file-explorer')).not.toBeInTheDocument()
    expect(useRightPanelStore.getState().activeListTab).toBe('git-changes')
  })

  it('single-clicking a file in the Files tree selects/highlights it', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    // No selection initially.
    expect(screen.getByTestId('file-explorer')).toHaveAttribute('data-selected', '')

    await user.click(screen.getByTestId('mock-select-file'))

    // RightPanel threaded onSelectPath -> selectedPath back into FileExplorer.
    expect(screen.getByTestId('file-explorer')).toHaveAttribute('data-selected', 'src/App.tsx')
  })

  it('renders a resize handle for the list sidebar when expanded', () => {
    renderWithI18n(
      <RightPanel
        width={640}
        isCollapsed={false}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('right-panel-list-resize-handle')).toBeInTheDocument()
  })
})

describe('RightPanelContent', () => {
  beforeEach(() => {
    cleanup()
    resetStore()
    vi.clearAllMocks()
  })

  it('renders file and diff tabs with correct icons and badges', () => {
    const fileTab: FileTab = {
      type: 'file',
      id: 'file:src/App.tsx',
      path: 'src/App.tsx',
      name: 'App.tsx',
      content: 'export default function App() {}',
      isBinary: false,
    }
    const diffTab: DiffTab = {
      type: 'diff',
      id: 'diff:src/App.tsx:M',
      path: 'src/App.tsx',
      name: 'App.tsx',
      statusCode: 'M',
      staged: true,
      original: 'old',
      modified: 'new',
      isBinary: false,
      truncated: false,
      isDeleted: false,
      isUntracked: false,
    }

    useRightPanelStore.setState({
      openTabs: [fileTab, diffTab],
      activeTabId: fileTab.id,
    })

    renderWithI18n(<RightPanelContent workspacePath="/workspace" contentWidth={400} />)

    expect(screen.getAllByText('App.tsx')).toHaveLength(2)
    expect(screen.getByText('M')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(2)

    const activeTab = screen.getAllByRole('tab')[0]
    expect(activeTab).toHaveClass('bg-surface-hover')
  })

  it('closes tabs and shows empty state when the last tab is closed', async () => {
    const user = userEvent.setup()
    const fileTab: FileTab = {
      type: 'file',
      id: 'file:a.tsx',
      path: 'a.tsx',
      name: 'a.tsx',
      content: 'a',
      isBinary: false,
    }
    const diffTab: DiffTab = {
      type: 'diff',
      id: 'diff:b.tsx:M',
      path: 'b.tsx',
      name: 'b.tsx',
      statusCode: 'M',
      staged: true,
      original: 'old',
      modified: 'new',
      isBinary: false,
      truncated: false,
      isDeleted: false,
      isUntracked: false,
    }

    useRightPanelStore.setState({
      openTabs: [fileTab, diffTab],
      activeTabId: fileTab.id,
    })

    renderWithI18n(<RightPanelContent workspacePath="/workspace" contentWidth={400} />)

    expect(screen.getAllByRole('tab')).toHaveLength(2)

    await user.click(screen.getAllByTestId('close-tab-button')[0])

    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(useRightPanelStore.getState().activeTabId).toBe(diffTab.id)

    await user.click(screen.getByTestId('close-tab-button'))

    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByText('Open a file or change to view it')).toBeInTheDocument()
    expect(useRightPanelStore.getState().activeTabId).toBeNull()
  })
})

describe('CodeMirrorDiffViewer', () => {
  it('forces unified mode when width is below the side-by-side threshold', () => {
    const diffTab: DiffTab = {
      type: 'diff',
      id: 'diff:src/App.tsx:M',
      path: 'src/App.tsx',
      name: 'App.tsx',
      statusCode: 'M',
      staged: true,
      original: 'old',
      modified: 'new',
      isBinary: false,
      truncated: false,
      isDeleted: false,
      isUntracked: false,
    }

    renderWithI18n(
      <CodeMirrorDiffViewer tab={diffTab} workspacePath="/workspace" width={300} />,
    )

    const toggle = screen.getByTestId('diff-mode-toggle')
    expect(toggle).toBeDisabled()
    expect(MergeView).not.toHaveBeenCalled()
  })
})
