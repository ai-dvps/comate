import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import RightPanel from './RightPanel'
import RightPanelContent from './RightPanelContent'
import CodeMirrorDiffViewer from './CodeMirrorDiffViewer'
import { useRightPanelStore, type FileTab, type DiffTab } from '../stores/right-panel-store'
import i18n from '../i18n'
import { MergeView } from '@codemirror/merge'

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
  }: {
    onFileClick: (path: string, name: string) => void
  }) {
    return (
      <div data-testid="file-explorer">
        <button data-testid="mock-open-file" onClick={() => onFileClick('src/App.tsx', 'App.tsx')}>
          Open file
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

  it('renders collapsed icon rail with Files and Git icons', () => {
    renderWithI18n(
      <RightPanel
        width={48}
        isCollapsed={true}
        toggleCollapse={vi.fn()}
        onWidthChange={vi.fn()}
        workspaceId="ws1"
      />,
    )

    expect(screen.getByTestId('right-panel-rail')).toBeInTheDocument()
    expect(screen.getByLabelText('Show files')).toBeInTheDocument()
    expect(screen.getByLabelText('Show git changes')).toBeInTheDocument()
    expect(screen.queryByTestId('right-panel-list-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('right-panel-content')).not.toBeInTheDocument()
  })

  it('expands to show the list sidebar and content panel', () => {
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
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument()
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

    await user.click(screen.getByLabelText('Show git changes'))

    expect(screen.getByTestId('git-changes-list')).toBeInTheDocument()
    expect(screen.queryByTestId('file-explorer')).not.toBeInTheDocument()
    expect(useRightPanelStore.getState().activeListTab).toBe('git-changes')
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
